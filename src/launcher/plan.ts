/**
 * Assemble and fully validate the immutable {@link LaunchPlan}
 * (FR-H03/H05). Every cross-field invariant — roster homogeneity, worktree
 * containment, and `--task-file` readability — is checked here, before any side
 * effect. The plan is the single object `--print` emits; the Task brief BODY is
 * never embedded (only its metadata), so the JSON plan never carries untrusted
 * content.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { CrewError } from '../errors.js';
import { assertWithin, MAX_CONFIG_BYTES, readManagedFile } from '../fs-safe.js';
import type { Io } from '../io.js';
import type { ParticipantId } from '../participants.js';
import { getTarget } from '../platforms/registry.js';
import {
  expandRoster,
  loadTeam,
  type ParticipantPlatform,
  type RosterEntry,
  type Team,
} from '../teams.js';
import { resolveWorkspaceRoot, workspacePaths } from '../workspace.js';
import type { ClientSource, EffectiveLaunchConfig } from './config.js';
import { deriveSessionName, managedWorktreeBase, worktreePath } from './derive.js';

/** Fixed list of additional artifacts a live launch writes (configuration.md). */
const ARTIFACTS = [
  'pane-map.json',
  'manager-prompt.md',
  'inspector-prompt.md',
  'run-summary.md',
] as const;

const BRIEF_BASENAME = 'run-task.md';
const BRIEF_REL = join('.crew', BRIEF_BASENAME);

export interface PlanRosterEntry {
  readonly agent_id: string;
  readonly role: string;
  readonly replica_base: string;
}

export interface LaunchPlan {
  readonly schema_version: 1;
  readonly session_name: string;
  readonly created_at: number;
  readonly team: string;
  readonly client: ParticipantId;
  readonly executable: string;
  readonly worktree: {
    readonly enabled: boolean;
    readonly path: string | null;
    readonly branch: string | null;
    readonly base_ref: string;
  };
  readonly relay: {
    readonly enabled: boolean;
    readonly poll_seconds: number;
    readonly reminder_seconds: number;
    readonly attach: boolean;
  };
  readonly roster: readonly PlanRosterEntry[];
  readonly focus: { readonly files: readonly string[]; readonly docs: readonly string[] };
  readonly constraints: readonly string[];
  readonly task_brief: {
    readonly present: boolean;
    readonly target_role: 'manager';
  };
  readonly artifacts: readonly string[];
}

/** Task-brief metadata for rendering; the body never enters the {@link LaunchPlan}. */
export interface BriefMeta {
  readonly present: boolean;
  /** Display path (the `.crew/run-task.md` default, or the explicit `--task-file`). */
  readonly path: string;
  readonly lineCount: number | null;
  /** True when an explicit `--task-file` was given. */
  readonly explicit: boolean;
  /**
   * The untrusted brief body, kept in memory for the live launch to embed under
   * guard in the Manager prompt; null when no brief is present. NEVER serialized
   * into the {@link LaunchPlan} JSON.
   */
  readonly body: string | null;
}

export interface LaunchAssembly {
  readonly plan: LaunchPlan;
  readonly clientSource: ClientSource;
  readonly brief: BriefMeta;
}

/** Apply `--workers` by overriding the replica count of every Worker-role member. */
function applyWorkers(team: Team, workers: number | null): Team {
  if (workers === null) return team;
  return {
    ...team,
    members: team.members.map((m) => (m.role === 'worker' ? { ...m, replicas: workers } : m)),
  };
}

/** Refuse a Team with mixed non-empty platform hints unless a client override is set (FR-H06). */
function assertHomogeneousClient(roster: readonly RosterEntry[], clientSource: ClientSource): void {
  if (clientSource !== 'default') return;
  const hints = new Set(
    roster.map((r) => r.platform).filter((p): p is ParticipantPlatform => p !== null),
  );
  if (hints.size > 1) {
    throw new CrewError(
      'USAGE',
      `the Team has mixed platform hints (${[...hints].join(', ')}); pass --client, set runtime.client, or launch the panes manually`,
    );
  }
}

/** Resolve the Participant executable for a client id from the authoritative registry (FR-H07). */
function participantExecutable(client: ParticipantId): string {
  const target = getTarget(client);
  if (target === undefined || target.category !== 'participant') {
    throw new CrewError('UNSUPPORTED_PLATFORM', `no registry target for client "${client}"`);
  }
  return target.executable;
}

function resolveWorktreePlan(
  io: Io,
  root: string,
  config: EffectiveLaunchConfig,
): LaunchPlan['worktree'] {
  const { enabled, branch, baseRef } = config.worktree;
  if (!enabled) {
    // A disabled worktree reports no branch/path (configuration.md); the tracked
    // branch is irrelevant until the worktree is enabled.
    return { enabled: false, path: null, branch: null, base_ref: baseRef };
  }
  if (branch === null || branch.length === 0) {
    throw new CrewError('INVALID_CONFIG', 'worktree is enabled but no branch is set');
  }
  // Symlink-resolve the repo root before hashing (configuration.md). This is a pure
  // read; `--print` derives the path here and never invokes git (worktree.ts is
  // the live-launch resolver).
  const path = worktreePath(io.env, realpathSync(root), branch);
  assertWithin(managedWorktreeBase(io.env), path); // FR-H10: derived path stays under the managed base
  return { enabled: true, path, branch, base_ref: baseRef };
}

function countLines(body: string): number {
  if (body.length === 0) return 0;
  const trimmed = body.endsWith('\n') ? body.slice(0, -1) : body;
  return trimmed.length === 0 ? 1 : trimmed.split('\n').length;
}

/** Resolve the Task brief metadata; the body is read only to count lines, never stored. */
function resolveBrief(io: Io, root: string, taskFile: string | null): BriefMeta {
  if (taskFile !== null) {
    const resolved = isAbsolute(taskFile) ? taskFile : resolve(io.cwd, taskFile);
    let raw: Buffer;
    try {
      const st = statSync(resolved);
      if (!st.isFile())
        throw new CrewError('NOT_FOUND', `task brief is not a regular file: ${resolved}`);
      if (st.size > MAX_CONFIG_BYTES)
        throw new CrewError(
          'INVALID_CONFIG',
          `task brief "${resolved}" exceeds the ${MAX_CONFIG_BYTES}-byte limit (${st.size} bytes)`,
        );
      raw = readFileSync(resolved);
    } catch (err) {
      if (err instanceof CrewError) throw err;
      throw new CrewError('NOT_FOUND', `no readable task brief at "${resolved}"`);
    }
    let body: string;
    try {
      body = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw new CrewError('INVALID_CONFIG', `task brief "${resolved}" is not valid UTF-8`);
    }
    return { present: true, path: resolved, lineCount: countLines(body), explicit: true, body };
  }
  const briefPath = join(workspacePaths(root).crew, BRIEF_BASENAME);
  if (existsSync(briefPath) && statSync(briefPath).isFile()) {
    const body = readManagedFile(root, BRIEF_REL, MAX_CONFIG_BYTES);
    return { present: true, path: BRIEF_REL, lineCount: countLines(body), explicit: false, body };
  }
  return { present: false, path: BRIEF_REL, lineCount: null, explicit: false, body: null };
}

/** Build and validate the launch plan for `name` under `config`. Pure of mutation/side effects. */
export function buildLaunchPlan(
  io: Io,
  name: string,
  config: EffectiveLaunchConfig,
): LaunchAssembly {
  const root = resolveWorkspaceRoot(io.cwd);
  const team = applyWorkers(loadTeam(io, name), config.workers);
  const roster = expandRoster(team, `team "${name}"`);
  assertHomogeneousClient(roster, config.clientSource);

  const executable = participantExecutable(config.client);
  const worktree = resolveWorktreePlan(io, root, config);
  const brief = resolveBrief(io, root, config.taskFile);

  const plan: LaunchPlan = {
    schema_version: 1,
    session_name: resolveSessionName(root, config),
    created_at: io.clock(),
    team: team.name,
    client: config.client,
    executable,
    worktree,
    relay: {
      enabled: config.relay.enabled,
      poll_seconds: config.relay.pollSeconds,
      reminder_seconds: config.relay.reminderSeconds,
      attach: config.relay.attach,
    },
    roster: roster.map((r) => ({
      agent_id: r.agentId,
      role: r.role,
      replica_base: r.replicaBase,
    })),
    focus: { files: config.focus.files, docs: config.focus.docs },
    constraints: config.constraints,
    task_brief: {
      present: brief.present,
      target_role: 'manager',
    },
    artifacts: ARTIFACTS,
  };
  return { plan, clientSource: config.clientSource, brief };
}

/** Pick the session-name source (config session_name / project name / workspace dir) and slugify. */
function resolveSessionName(root: string, config: EffectiveLaunchConfig): string {
  const dirName =
    root
      .split(/[/\\]/)
      .filter((s) => s.length > 0)
      .at(-1) ?? 'crew';
  return deriveSessionName(config.project.sessionName, config.project.name, dirName);
}
