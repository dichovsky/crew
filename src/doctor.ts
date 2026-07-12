/**
 * `crew doctor` (FR-K01/K10, FR-B02): read-only diagnostics over the system,
 * Workspace placement, State Store, and built-in config drift.
 *
 * This handler owns the finding code -> severity vocabulary and all rendering;
 * the Store returns raw facts only. Findings (info/warn/error) print first, then
 * one `health_summary`. In human mode a retention footer follows. If any
 * error-severity finding exists, a `CrewError` is thrown after output so the
 * Program seam writes a one-line stderr failure and exits 1.
 */
import { accessSync, constants, existsSync, readdirSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CrewError } from './errors.js';
import { humanCell, messageOf, writeJsonLine, writeLine } from './format.js';
import type { Io } from './io.js';
import { createTmuxAdapter } from './launcher/tmux.js';
import { listResumableSessions } from './launcher/resume.js';
import { PARTICIPANT_TARGETS } from './platforms/registry.js';
import { compareVersions, probeVersion } from './platforms/shared.js';
import { DEFAULT_MESSAGE_RETENTION_DAYS, DEFAULT_TASK_RETENTION_DAYS } from './retention.js';
import { listRolesWithFailures } from './roles.js';
import { type ArtifactDrift, collectArtifactDrift } from './setup/index.js';
import { diagnoseStore, type StoreFacts } from './store/maintenance.js';
import { listTeamsWithFailures } from './teams.js';
import { isExecutableOnPath } from './which.js';
import {
  findWorkspaceRoot,
  resolveWorkspaceRoot,
  WORKSPACE_DIRNAME,
  workspacePaths,
  type WorkspacePaths,
} from './workspace.js';

export interface DoctorOptions {
  readonly system: boolean;
  readonly json: boolean;
}

type Severity = 'info' | 'warn' | 'error';

interface Finding {
  readonly severity: Severity;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

/** Diagnostics that need a present executable on PATH (only absence is reported). */
const SYSTEM_DEPENDENCIES = ['tmux', 'git'] as const;

/** Linux `statfs` f_type magic numbers for common network filesystems. */
const NETWORK_FS_TYPES: ReadonlySet<number> = new Set([
  0x6969, // NFS
  0x517b, // SMBFS
  0xff534d42, // CIFS/SMB
  0xfe534d42, // SMB2
  0x5346414f, // AFS (OpenAFS)
  0x564c, // NCP (NetWare)
]);

/** True when a `statfs` filesystem-type magic number is a known network FS. */
export function isNetworkFsType(type: number): boolean {
  return NETWORK_FS_TYPES.has(type >>> 0);
}

/** Best-effort network-filesystem detection; undetectable resolves to false. */
function detectNetworkFilesystem(path: string): boolean {
  try {
    const { type } = statfsSync(path);
    return isNetworkFsType(Number(type));
  } catch {
    return false;
  }
}

function collectSystemFindings(io: Io, findings: Finding[]): void {
  for (const name of SYSTEM_DEPENDENCIES) {
    if (!isExecutableOnPath(io.env, name)) {
      findings.push({
        severity: 'info',
        code: 'DEPENDENCY_MISSING',
        message: `${name} is not installed or not on PATH`,
        details: { dependency: name },
      });
    }
  }
}

/**
 * Report each Participant CLI that is not installed (FR-K01). Absence is `info`,
 * like tmux/git: crew coordinates whatever Participant is present and requires no
 * single one. Version is not a doctor finding — it is surfaced by `crew setup`.
 */
function collectParticipantFindings(io: Io, findings: Finding[]): void {
  for (const target of PARTICIPANT_TARGETS) {
    if (!isExecutableOnPath(io.env, target.executable)) {
      findings.push({
        severity: 'info',
        code: 'DEPENDENCY_MISSING',
        message: `${target.executable} (${target.id}) is not installed or not on PATH`,
        details: { dependency: target.executable, target: target.id },
      });
    }
  }
}

/**
 * Warn (never block) when an installed Participant CLI is BELOW its verified
 * version floor (FR-K01). Only present executables with a pinned
 * `minimumVerifiedVersion` are probed; an unparseable `--version` is skipped
 * rather than guessed. The floor is advisory — crew coordinates whatever a
 * Participant CLI is, so an older-but-working CLI is warned, not refused.
 */
async function collectVersionFloorFindings(io: Io, findings: Finding[]): Promise<void> {
  // Probe concurrently (mirroring setup's runSetupList) so a slow or hung CLI cannot
  // serialize five bounded 5s probes into a ~25s wait — doctor is a fast read-only
  // diagnostic. Promise.all preserves order, so findings stay deterministic; a floor
  // with no pin is skipped without a spawn, and probeVersion presence-checks
  // internally (no spawn for an absent CLI).
  const below = await Promise.all(
    PARTICIPANT_TARGETS.map(async (target) => {
      const floor = target.minimumVerifiedVersion;
      if (floor === null) return null;
      const probe = await probeVersion(io, target);
      if (probe.version === null || compareVersions(probe.version, floor) >= 0) return null;
      return { target, floor, detected: probe.version };
    }),
  );
  for (const hit of below) {
    if (hit === null) continue;
    findings.push({
      severity: 'warn',
      code: 'VERSION_FLOOR',
      message: `${hit.target.executable} (${hit.target.id}) ${hit.detected} is below the verified minimum ${hit.floor}`,
      details: {
        target: hit.target.id,
        detected: hit.detected,
        minimum: hit.floor,
        verified_on: hit.target.verifiedOn,
      },
    });
  }
}

/**
 * Build a SETUP_DRIFT finding whose message carries the exact, runnable remediation
 * command for this target and scope (FR-K01). An edited or unmanaged file is `warn`
 * (crew cannot replace it without --force + backup); an outdated or missing-but-CLI-
 * present artifact is `info` (a plain re-run installs/refreshes it).
 */
function setupDriftFinding(drift: ArtifactDrift): Finding {
  const cmd = `crew setup ${drift.id}${drift.scope === 'project' ? ' --project' : ''}`;
  const where = `${drift.targets.join(', ')} (${drift.scope})`;
  const detail = {
    target: drift.id,
    targets: drift.targets,
    scope: drift.scope,
    path: drift.path,
    drift: drift.state,
  };
  const shared = drift.targets.length > 1 ? ' the shared artifact' : '';
  switch (drift.state) {
    case 'managed-edited':
      return makeSetupFinding(
        'warn',
        `${where} setup artifact has local edits; run "${cmd} --force" to back it up and regenerate${shared}`,
        detail,
      );
    case 'unmanaged':
      return makeSetupFinding(
        'warn',
        `a non-crew file occupies the ${where} setup path; run "${cmd} --force" to back it up and overwrite${shared}`,
        detail,
      );
    case 'managed-outdated':
      return makeSetupFinding(
        'info',
        `${where} setup artifact is from an older registry revision; run "${cmd}" to refresh${shared}`,
        detail,
      );
    case 'absent':
      return makeSetupFinding(
        'info',
        `${where} Participant CLI is installed but its setup artifact is missing; run "${cmd}" to install`,
        detail,
      );
    default:
      return makeSetupFinding('warn', `${where} setup artifact drift`, detail);
  }
}

function makeSetupFinding(
  severity: Severity,
  message: string,
  details: Record<string, unknown>,
): Finding {
  return { severity, code: 'SETUP_DRIFT', message, details };
}

/**
 * Report Participant setup-artifact drift (FR-K01). Global artifacts are checked in
 * every mode; project artifacts only in workspace mode.
 */
function collectSetupFindings(io: Io, findings: Finding[], includeProject: boolean): void {
  for (const drift of collectArtifactDrift(io, includeProject)) {
    findings.push(setupDriftFinding(drift));
  }
}

function collectWorkspaceFindings(paths: WorkspacePaths, findings: Finding[]): void {
  const target = existsSync(paths.state) ? paths.state : paths.crew;
  let writable = true;
  try {
    accessSync(target, constants.W_OK);
  } catch {
    writable = false;
  }
  if (!writable) {
    findings.push({
      severity: 'warn',
      code: 'STATE_PATH',
      message: 'State directory is not writable',
      details: { path: target },
    });
  }
  if (detectNetworkFilesystem(target)) {
    findings.push({
      severity: 'warn',
      code: 'NETWORK_FILESYSTEM',
      message: 'State directory may be on a network filesystem (unsupported)',
      details: { path: paths.state },
    });
  }
}

/**
 * Warn when another `.crew` workspace exists in an ancestor directory (FR-B02): the
 * nearest-ancestor resolution may select a different Crew than intended, which is
 * especially risky for the destructive `prune`/`clean` commands.
 */
function collectNestedWorkspaceFinding(root: string, findings: Finding[]): void {
  const parent = dirname(root);
  const outer = parent === root ? null : findWorkspaceRoot(parent);
  if (outer !== null) {
    findings.push({
      severity: 'warn',
      code: 'NESTED_WORKSPACE',
      message:
        'Another .crew workspace exists in an ancestor directory; commands may target a different Crew',
      details: { outer: join(outer, WORKSPACE_DIRNAME) },
    });
  }
}

function storeFactFindings(facts: StoreFacts, findings: Finding[]): void {
  if (facts.newer) {
    findings.push({
      severity: 'error',
      code: 'UNSUPPORTED_SCHEMA',
      message: 'State Store schema is newer than this crew supports',
      details: { version: facts.schemaVersion },
    });
  }
  if (facts.nonEmptyV0) {
    findings.push({
      severity: 'error',
      code: 'UNSUPPORTED_SCHEMA',
      message: 'State Store has unrecognized objects at schema version 0',
    });
  }
  if (!facts.quickCheckOk) {
    findings.push({
      severity: 'error',
      code: 'INTEGRITY',
      message: 'State Store failed its integrity quick_check',
    });
  }
  if (!facts.foreignKeyOk) {
    findings.push({
      severity: 'error',
      code: 'INTEGRITY',
      message: 'State Store failed its foreign-key check',
    });
  }
  if (facts.schemaDriftReason !== null) {
    findings.push({
      severity: 'error',
      code: 'SCHEMA_DRIFT',
      message: `Schema drift: ${facts.schemaDriftReason}`,
    });
  }
  for (const taskId of facts.staleLeases) {
    findings.push({
      severity: 'warn',
      code: 'STALE_LEASE',
      message: 'Task lease has expired',
      details: { task_id: taskId },
    });
  }
  for (const owner of facts.archivedOwners) {
    findings.push({
      severity: 'warn',
      code: 'ARCHIVED_OWNER',
      message: 'Archived agent referenced by a non-completed task',
      details: { task_id: owner.taskId, agent_id: owner.agentId },
    });
  }
}

function collectStoreFindings(io: Io, paths: WorkspacePaths, findings: Finding[]): void {
  if (!existsSync(paths.db)) {
    findings.push({
      severity: 'info',
      code: 'NO_STATE_STORE',
      message: 'No State Store yet; it is created on first use',
    });
    return;
  }
  let facts: StoreFacts;
  try {
    facts = diagnoseStore(paths.db, Math.floor(io.clock()));
  } catch (err) {
    findings.push({
      severity: 'error',
      code: 'INTEGRITY',
      message: `State Store could not be opened: ${messageOf(err)}`,
    });
    return;
  }
  storeFactFindings(facts, findings);
}

function pushConfigReadFailure(
  findings: Finding[],
  config: 'roles' | 'teams',
  label: string,
  err: unknown,
  name?: string,
): void {
  const code =
    err instanceof CrewError && err.code === 'UNSAFE_PATH' ? 'UNSAFE_PATH' : 'INVALID_CONFIG';
  findings.push({
    severity: 'warn',
    code,
    message: `Project ${label} config could not be read: ${messageOf(err)}`,
    details: { config, ...(name !== undefined ? { name } : {}) },
  });
}

/**
 * Config drift degrades per file: each unreadable/invalid project Role or Team
 * file becomes its own warn finding while every remaining valid config is still
 * listed and drift-checked. The outer try/catch covers whole-listing failures
 * (e.g. an unreadable roles/teams directory), which degrade the same way.
 */
function collectConfigDriftFindings(io: Io, findings: Finding[]): void {
  let roleListing: ReturnType<typeof listRolesWithFailures>;
  try {
    roleListing = listRolesWithFailures(io);
  } catch (err) {
    pushConfigReadFailure(findings, 'roles', 'role', err);
    roleListing = { roles: [], failures: [] };
  }
  for (const failure of roleListing.failures) {
    pushConfigReadFailure(findings, 'roles', `role "${failure.name}"`, failure.error, failure.name);
  }
  for (const role of roleListing.roles) {
    if (role.builtin && role.source === 'project') {
      findings.push({
        severity: 'info',
        code: 'ROLE_DRIFT',
        message: `Built-in role "${role.name}" has local edits`,
        details: { role: role.name },
      });
    }
  }
  let teamListing: ReturnType<typeof listTeamsWithFailures>;
  try {
    teamListing = listTeamsWithFailures(io);
  } catch (err) {
    pushConfigReadFailure(findings, 'teams', 'team', err);
    teamListing = { teams: [], failures: [] };
  }
  for (const failure of teamListing.failures) {
    pushConfigReadFailure(findings, 'teams', `team "${failure.name}"`, failure.error, failure.name);
  }
  for (const team of teamListing.teams) {
    if (team.builtin && team.source === 'project') {
      findings.push({
        severity: 'info',
        code: 'TEAM_DRIFT',
        message: `Built-in team "${team.name}" has local edits`,
        details: { team: team.name },
      });
    }
  }
}

async function collectResumeFindings(io: Io, findings: Finding[]): Promise<void> {
  const root = resolveWorkspaceRoot(io.cwd);
  const generated = join(root, '.crew', 'generated');
  if (!existsSync(generated)) return;

  const resumable = await listResumableSessions(io, { adapter: createTmuxAdapter(io) });
  const resumableNames = new Set(resumable.map((session) => session.sessionName));
  for (const entry of readdirSync(generated, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const session = entry.name;
    if (!existsSync(join(generated, session, 'resume.json'))) continue;
    if (resumableNames.has(session)) continue;
    findings.push({
      severity: 'warn',
      code: 'RESUME_DRIFT',
      message: `Stopped session "${session}" is no longer resumable`,
      details: { session },
    });
  }
}

function findingRecord(finding: Finding): Record<string, unknown> {
  return {
    type: 'health_finding',
    schema_version: 1,
    severity: finding.severity,
    code: finding.code,
    message: finding.message,
    ...(finding.details !== undefined ? { details: finding.details } : {}),
  };
}

function writeFindingHuman(io: Io, finding: Finding): void {
  const detail =
    finding.details === undefined
      ? ''
      : '  ' +
        Object.entries(finding.details)
          .map(([key, value]) => `${key}=${humanCell(String(value))}`)
          .join(' ');
  writeLine(
    io,
    `${finding.severity.padEnd(5)} ${finding.code.padEnd(18)} ${humanCell(finding.message)}${detail}`,
  );
}

function writeRetentionFooter(io: Io): void {
  writeLine(io, '');
  writeLine(
    io,
    `Retention: "crew prune" removes read messages older than ${DEFAULT_MESSAGE_RETENTION_DAYS} days ` +
      `and completed or abandoned tasks older than ${DEFAULT_TASK_RETENTION_DAYS} days; nothing is deleted automatically.`,
  );
  writeLine(
    io,
    'Delivery: receive is at-most-once. A crash after commit but before output can drop a ' +
      'message from the inbox (history keeps the row). Do not rely on crew for irreplaceable records.',
  );
}

/** Run read-only diagnostics and render findings + a trailing `health_summary`. */
export async function runDoctor(io: Io, options: DoctorOptions): Promise<void> {
  const findings: Finding[] = [];
  collectSystemFindings(io, findings);
  collectParticipantFindings(io, findings);
  await collectVersionFloorFindings(io, findings);
  collectSetupFindings(io, findings, !options.system);

  let workspace: string | null = null;
  if (!options.system) {
    const root = resolveWorkspaceRoot(io.cwd);
    const paths = workspacePaths(root);
    workspace = paths.crew;
    collectWorkspaceFindings(paths, findings);
    collectNestedWorkspaceFinding(root, findings);
    collectStoreFindings(io, paths, findings);
    collectConfigDriftFindings(io, findings);
    await collectResumeFindings(io, findings);
  }

  // The contract promises the most noteworthy findings first. Array#sort is
  // stable, so collection order remains the deterministic tie-breaker.
  const severityRank: Record<Severity, number> = { error: 0, warn: 1, info: 2 };
  findings.sort((left, right) => severityRank[left.severity] - severityRank[right.severity]);

  const counts = { info: 0, warn: 0, error: 0 };
  for (const finding of findings) counts[finding.severity]++;
  const ok = counts.error === 0;

  if (options.json) {
    for (const finding of findings) writeJsonLine(io, findingRecord(finding));
    writeJsonLine(io, {
      type: 'health_summary',
      schema_version: 1,
      workspace,
      ok,
      info: counts.info,
      warn: counts.warn,
      error: counts.error,
    });
  } else {
    if (findings.length === 0) writeLine(io, 'No findings.');
    for (const finding of findings) writeFindingHuman(io, finding);
    writeLine(io, '');
    writeLine(io, `Workspace ${workspace === null ? '(system check only)' : humanCell(workspace)}`);
    writeLine(
      io,
      `Findings  ${counts.error} error, ${counts.warn} warn, ${counts.info} info — ${ok ? 'ok' : 'problems found'}`,
    );
    if (!options.system) writeRetentionFooter(io);
  }

  if (counts.error > 0) {
    // UNSUPPORTED_SCHEMA outranks INTEGRITY/SCHEMA_DRIFT, which throws as INTEGRITY.
    const code = findings.some((f) => f.code === 'UNSUPPORTED_SCHEMA')
      ? 'UNSUPPORTED_SCHEMA'
      : 'INTEGRITY';
    throw new CrewError(code, `doctor found ${counts.error} error-severity finding(s)`);
  }
}
