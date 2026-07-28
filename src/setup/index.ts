/**
 * The Setup Module: `crew setup` (FR-G01-G13, DEC-13).
 *
 * Bare `setup` / `--list` detects every Setup Target and writes nothing. An
 * explicit Participant target writes exactly one marked artifact at its
 * registry-canonical path (global by default, `--project` for the repo path),
 * backing up an edited/unmanaged file only with `--force`. A Model Backend
 * target runs read-only checks and prints a recipe; it writes no file. All
 * platform facts come from the registry (ADR-0006); this module owns only the
 * flow, output, and the home/project path resolution.
 */
import { join, relative } from 'node:path';
import { CrewError } from '../errors.js';
import { humanCell, sanitizeHuman, writeJsonLine, writeLine } from '../format.js';
import type { Io } from '../io.js';
import {
  ALL_TARGETS,
  getTarget,
  PARTICIPANT_TARGETS,
  REGISTRY_REVISION,
} from '../platforms/registry.js';
import {
  type BackendTarget,
  classifyArtifact,
  type DriftState,
  type ParticipantTarget,
  probeVersion,
  type SetupTarget,
} from '../platforms/shared.js';
import { isExecutableOnPath } from '../which.js';
import { findWorkspaceRoot } from '../workspace.js';
import {
  backupArtifact,
  isSymlinkLeaf,
  readArtifact,
  resolveProjectArtifact,
  UnreadableArtifact,
  writeArtifactAtomic,
  writeProjectArtifactAtomic,
} from './fs.js';

/** Stated on every Participant install (FR-K08): identity is spoofable, share one trust domain. */
const SHARED_TRUST_NOTE =
  'Trust: crew cannot authenticate Agents — any session can claim any id, so every participant must share one trust domain.';

type SetupScope = 'global' | 'project';

interface SetupOptions {
  readonly target?: string;
  readonly list: boolean;
  readonly project: boolean;
  readonly force: boolean;
  readonly json: boolean;
}

/** Resolve `$HOME` for global artifact paths; absent home is an explicit dependency error. */
function homeDir(io: Io): string {
  const home = io.env.HOME ?? io.env.USERPROFILE;
  if (home === undefined || home === '') {
    throw new CrewError(
      'DEPENDENCY_MISSING',
      'cannot resolve the home directory (HOME unset) for global setup',
    );
  }
  return home;
}

/** Absolute global artifact path for a Participant target. */
function globalAbsPath(io: Io, target: ParticipantTarget): string {
  return join(homeDir(io), target.userPath);
}

/** Absolute project artifact path; requires a `.crew/` workspace, else null. */
function projectAbsPath(io: Io, target: ParticipantTarget): string | null {
  const root = findWorkspaceRoot(io.cwd);
  return root === null ? null : join(root, target.projectPath);
}

/** Collapse a leading home directory to `~` so output never embeds the absolute home. */
function displayPath(io: Io, absPath: string): string {
  const home = io.env.HOME ?? io.env.USERPROFILE;
  if (home !== undefined && home !== '' && absPath.startsWith(home)) {
    return `~${absPath.slice(home.length)}`;
  }
  return absPath;
}

/** Drift state of an existing artifact; a symlinked leaf or unreadable file reads as unmanaged. */
function computeState(absPath: string): DriftState {
  if (isSymlinkLeaf(absPath)) return 'unmanaged';
  let content: string | null;
  try {
    content = readArtifact(absPath);
  } catch (err) {
    // A directory squatting the path (UNSAFE_PATH) or a binary/oversized file
    // (UnreadableArtifact) is never crew-managed: report it as unmanaged rather
    // than crashing detection, doctor, or an install.
    if (err instanceof UnreadableArtifact) return 'unmanaged';
    if (err instanceof CrewError && err.code === 'UNSAFE_PATH') return 'unmanaged';
    throw err;
  }
  return classifyArtifact(content);
}

interface PlannedWrite {
  readonly action: 'written' | 'noop' | 'regenerated';
  readonly backup: boolean;
}

/** Decide what an explicit Participant write does for a drift state; refusal throws. */
function planWrite(state: DriftState, force: boolean, displayPath: string): PlannedWrite {
  switch (state) {
    case 'absent':
      return { action: 'written', backup: false };
    case 'managed-current':
      return { action: 'noop', backup: false };
    case 'managed-outdated':
      return { action: 'regenerated', backup: false };
    case 'managed-edited':
    case 'unmanaged':
      if (force) return { action: 'written', backup: true };
      throw new CrewError(
        'ALREADY_EXISTS',
        `${state === 'managed-edited' ? 'a locally edited' : 'an unmanaged'} file exists at ${humanCell(displayPath)}; pass --force to back it up and overwrite`,
        { path: displayPath, state },
      );
  }
}

interface SetupResult {
  readonly id: string;
  readonly scope: SetupScope;
  readonly path: string;
  readonly action: 'written' | 'noop' | 'regenerated';
  readonly backupPath: string | null;
  readonly state: DriftState;
}

/**
 * Write (or no-op) one Participant artifact at a resolved absolute path. `write`
 * is the scope-appropriate atomic writer prepared by the caller: the project
 * writer re-establishes workspace containment at write time, so the
 * classification/backup I/O that runs above it cannot be raced into an escape;
 * the global writer keeps $HOME's intentional symlink-following.
 */
function applyParticipant(
  target: ParticipantTarget,
  scope: SetupScope,
  absPath: string,
  force: boolean,
  clockSeconds: number,
  toDisplay: (abs: string) => string,
  write: (content: string) => void,
): SetupResult {
  const state = computeState(absPath);
  const displayed = toDisplay(absPath);
  const plan = planWrite(state, force, displayed);
  const base = {
    id: target.id,
    scope,
    path: displayed,
    state,
  } as const;
  if (plan.action === 'noop') {
    return { ...base, action: 'noop', backupPath: null };
  }
  let backupPath: string | null = null;
  if (plan.backup) {
    // Moves the existing entry (incl. a dangling symlink) aside; null only when
    // the path is truly empty.
    const made = backupArtifact(absPath, clockSeconds);
    if (made !== null) backupPath = toDisplay(made);
  }
  write(target.render());
  return { ...base, action: plan.action, backupPath };
}

function setupResultRecord(result: SetupResult): Record<string, unknown> {
  return {
    type: 'setup_result',
    schema_version: 1,
    id: result.id,
    scope: result.scope,
    path: result.path,
    action: result.action,
    backup_path: result.backupPath,
    state: result.state,
    registry_revision: REGISTRY_REVISION,
  };
}

/** `crew setup <participant> [--project] [--force]`: write one marked artifact. */
function runSetupParticipant(io: Io, target: ParticipantTarget, options: SetupOptions): void {
  const scope: SetupScope = options.project ? 'project' : 'global';
  let absPath: string;
  let toDisplay: (abs: string) => string;
  let write: (content: string) => void;
  if (scope === 'project') {
    const root = findWorkspaceRoot(io.cwd);
    if (root === null) {
      throw new CrewError(
        'NOT_WORKSPACE',
        'no .crew/ workspace found for --project setup; run "crew init" first or omit --project for global setup',
      );
    }
    // Containment-checked: a repo-planted symlink component must not redirect
    // the fixed registry path outside the workspace root. The writer
    // re-runs this check at write time; project dirs are world-readable (0o755)
    // so co-developers and CI can use the committed file.
    absPath = resolveProjectArtifact(root, target.projectPath);
    // Workspace-relative display so output never embeds an absolute repo path.
    toDisplay = (abs) => relative(root, abs);
    write = (content) => {
      writeProjectArtifactAtomic(root, target.projectPath, content, 0o755);
    };
  } else {
    absPath = globalAbsPath(io, target);
    toDisplay = (abs) => displayPath(io, abs);
    // Global artifacts live in $HOME and stay user-only (0o700).
    write = (content) => {
      writeArtifactAtomic(absPath, content, 0o700);
    };
  }

  const result = applyParticipant(
    target,
    scope,
    absPath,
    options.force,
    Math.floor(io.clock()),
    toDisplay,
    write,
  );

  if (options.json) {
    writeJsonLine(io, setupResultRecord(result));
    return;
  }
  const verb = { written: 'Wrote', noop: 'Up to date:', regenerated: 'Regenerated' }[result.action];
  if (result.backupPath !== null) {
    writeLine(io, `Backed up existing file to ${humanCell(result.backupPath)}`);
  }
  writeLine(io, `${verb} ${target.id} (${scope}) at ${humanCell(result.path)}`);
  writeLine(io, `Invoke: ${target.invocation('<role>', '[id]')}`);
  writeLine(io, sanitizeHuman(target.permissionNote));
  writeLine(io, SHARED_TRUST_NOTE);
}

/** `crew setup <backend>`: read-only checks plus a printed recipe; writes nothing. */
async function runSetupBackend(
  io: Io,
  target: BackendTarget,
  options: SetupOptions,
): Promise<void> {
  if (options.project) {
    throw new CrewError(
      'USAGE',
      `--project is invalid for ${target.id}: backend setup prints a recipe and writes no file`,
    );
  }
  if (options.force) {
    throw new CrewError(
      'USAGE',
      `--force is invalid for ${target.id}: backend setup writes nothing to back up`,
    );
  }
  const checks = await target.checks(io);
  const recipe = target.recipe();
  if (options.json) {
    writeJsonLine(io, {
      type: 'setup_recipe',
      schema_version: 1,
      id: target.id,
      checks: checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
      recipe_lines: recipe,
    });
    return;
  }
  writeLine(io, `Backend ${target.id} (crew writes nothing; it never contacts the backend)`);
  for (const c of checks) {
    writeLine(io, `  [${c.ok ? 'ok' : '--'}] ${c.name}: ${sanitizeHuman(c.detail)}`);
  }
  writeLine(io, '');
  for (const line of recipe) writeLine(io, sanitizeHuman(line));
}

interface TargetDetection {
  readonly present: boolean;
  readonly version: string | null;
  readonly globalState: DriftState | null;
  readonly projectState: DriftState | null;
}

/** Probe presence/version and (for participants) global/project drift for one target. */
async function detectTarget(io: Io, target: SetupTarget): Promise<TargetDetection> {
  const probe = await probeVersion(io, target);
  if (target.category === 'backend') {
    return {
      present: probe.present,
      version: probe.version,
      globalState: null,
      projectState: null,
    };
  }
  let globalState: DriftState | null = null;
  try {
    globalState = computeState(globalAbsPath(io, target));
  } catch (err) {
    // $HOME unset: the global path is unresolvable, so report a null state (like
    // doctor) rather than failing the whole detection listing.
    if (!(err instanceof CrewError && err.code === 'DEPENDENCY_MISSING')) throw err;
  }
  const projectPath = projectAbsPath(io, target);
  const projectState = projectPath === null ? null : computeState(projectPath);
  return { present: probe.present, version: probe.version, globalState, projectState };
}

function setupTargetRecord(target: SetupTarget, d: TargetDetection): Record<string, unknown> {
  const base = {
    type: 'setup_target',
    schema_version: 1,
    id: target.id,
    category: target.category,
    executable: target.executable,
    present: d.present,
    version: d.version,
  };
  if (target.category === 'backend') {
    return {
      ...base,
      global_path: null,
      global_state: null,
      project_path: null,
      project_state: null,
    };
  }
  return {
    ...base,
    global_path: `~/${target.userPath}`,
    global_state: d.globalState,
    project_path: target.projectPath,
    project_state: d.projectState,
  };
}

/** `crew setup` / `crew setup --list`: detect every target, write nothing (FR-G02). */
async function runSetupList(io: Io, options: SetupOptions): Promise<void> {
  const detections = await Promise.all(ALL_TARGETS.map((t) => detectTarget(io, t)));
  if (options.json) {
    ALL_TARGETS.forEach((t, i) => writeJsonLine(io, setupTargetRecord(t, detections[i]!)));
    return;
  }
  writeLine(io, 'TARGET        CATEGORY     CLI                 GLOBAL          PROJECT');
  ALL_TARGETS.forEach((target, i) => {
    const d = detections[i]!;
    const cli = d.present
      ? `${target.executable} ${d.version ?? '(unknown)'}`
      : `${target.executable} (absent)`;
    const global = target.category === 'backend' ? '-' : (d.globalState ?? '-');
    const project = target.category === 'backend' ? '-' : (d.projectState ?? 'no workspace');
    writeLine(
      io,
      `${target.id.padEnd(13)} ${target.category.padEnd(12)} ${cli.padEnd(19)} ${global.padEnd(15)} ${project}`,
    );
  });
}

export interface ArtifactDrift {
  readonly id: string;
  readonly targets: readonly string[];
  readonly scope: SetupScope;
  readonly path: string;
  readonly state: DriftState;
}

/** Drift states that are always worth a doctor finding (`managed-current` is healthy). */
const ALWAYS_NOTEWORTHY: ReadonlySet<DriftState> = new Set([
  'managed-edited',
  'unmanaged',
  'managed-outdated',
]);

/**
 * A global artifact is reportable when always-noteworthy, or `absent` while the Participant CLI
 * itself is installed — an installed CLI with no global crew artifact is the "report not
 * installed" case of the drift table (setup-integration.md §6). An absent artifact for an
 * uninstalled CLI is the normal pre-setup state and is not reported. Project artifacts are
 * opt-in, so their absence is never a finding (only an edited/unmanaged/outdated one is).
 */
function isReportableGlobal(state: DriftState, cliPresent: boolean): boolean {
  return ALWAYS_NOTEWORTHY.has(state) || (state === 'absent' && cliPresent);
}

/**
 * Collect reportable Participant artifact drift for `doctor`. Global artifacts are
 * always checked (when $HOME resolves); project artifacts only when `includeProject`
 * and a `.crew/` workspace exists. Pure read-only classification; spawns nothing.
 */
export function collectArtifactDrift(io: Io, includeProject: boolean): ArtifactDrift[] {
  const globalDrifts = new Map<string, ArtifactDrift>();
  const projectDrifts = new Map<string, ArtifactDrift>();
  let home: string | null = null;
  try {
    home = homeDir(io);
  } catch {
    // $HOME unset: global artifacts are simply not checked
  }
  const root = includeProject ? findWorkspaceRoot(io.cwd) : null;
  for (const target of PARTICIPANT_TARGETS) {
    const cliPresent = isExecutableOnPath(io.env, target.executable);
    if (home !== null) {
      const state = computeState(join(home, target.userPath));
      if (isReportableGlobal(state, cliPresent)) {
        const absPath = join(home, target.userPath);
        const existing = globalDrifts.get(absPath);
        if (existing === undefined) {
          globalDrifts.set(absPath, {
            id: target.id,
            targets: [target.id],
            scope: 'global',
            path: `~/${target.userPath}`,
            state,
          });
        } else {
          globalDrifts.set(absPath, {
            ...existing,
            targets: [...existing.targets, target.id],
          });
        }
      }
    }
    if (root !== null) {
      const absPath = join(root, target.projectPath);
      const state = computeState(absPath);
      if (ALWAYS_NOTEWORTHY.has(state)) {
        // Multiple targets can share one physical project artifact (e.g. codex-cli and
        // antigravity-cli both manage .agents/skills/crew/SKILL.md). Dedup by absolute
        // path so doctor emits one finding whose `details.targets` names every affected
        // target: running `crew setup` for the first (canonical) target rewrites the
        // shared file and thereby remediates all of them at once.
        const existing = projectDrifts.get(absPath);
        if (existing === undefined) {
          projectDrifts.set(absPath, {
            id: target.id,
            targets: [target.id],
            scope: 'project',
            path: target.projectPath,
            state,
          });
        } else {
          projectDrifts.set(absPath, {
            ...existing,
            targets: [...existing.targets, target.id],
          });
        }
      }
    }
  }
  return [...globalDrifts.values(), ...projectDrifts.values()];
}

/** Dispatch `crew setup [target]` to detection, a Participant write, or a Backend recipe. */
export async function runSetup(io: Io, options: SetupOptions): Promise<void> {
  if (options.target === undefined) {
    if (options.project || options.force) {
      throw new CrewError('USAGE', '--project and --force require an explicit setup target');
    }
    await runSetupList(io, options);
    return;
  }
  if (options.list) {
    throw new CrewError('USAGE', '--list cannot be combined with an explicit setup target');
  }
  const target = getTarget(options.target);
  if (target === undefined) {
    const ids = ALL_TARGETS.map((t) => t.id).join(', ');
    throw new CrewError(
      'UNSUPPORTED_PLATFORM',
      `unknown setup target "${options.target}"; expected one of: ${ids}`,
    );
  }
  if (target.category === 'backend') {
    await runSetupBackend(io, target, options);
    return;
  }
  runSetupParticipant(io, target, options);
}
