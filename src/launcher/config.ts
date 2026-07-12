/**
 * Strict `.crew/launcher.yaml` parsing and the single precedence merge
 * (FR-H03/H05/H07).
 *
 * `parseLauncherConfig` validates the launcher document with the same hardened
 * rules as Team/Role config (single mapping, no aliases/merge/custom tags,
 * 256 KiB cap, unknown-key rejection) and per-field ranges from
 * `configuration.md`. It additionally refuses any executable / CLI-args / env /
 * permission / worktree filesystem-location / setup-scope field (security.md:
 * repo config can never select an executable or escape the managed worktree
 * base). `mergeEffectiveConfig` folds built-in defaults < launcher.yaml < CLI
 * flags into one immutable {@link EffectiveLaunchConfig} carrying client
 * provenance; CLI flag-syntax validation lives here.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { CrewError } from '../errors.js';
import { MAX_CONFIG_BYTES, readManagedFile } from '../fs-safe.js';
import { isParticipantId, PARTICIPANT_IDS, type ParticipantId } from '../participants.js';
import { workspacePaths } from '../workspace.js';
import { loadYamlMapping } from '../yaml-load.js';
import { assertValidBranch, assertValidRevision } from './ref.js';

const LAUNCHER_KEYS = new Set([
  'version',
  'project',
  'runtime',
  'workspace',
  'relay',
  'focus',
  'constraints',
]);
const PROJECT_KEYS = new Set(['name', 'session_name']);
const RUNTIME_KEYS = new Set(['client']);
const WORKSPACE_KEYS = new Set(['worktree']);
const WORKTREE_KEYS = new Set(['enabled', 'branch', 'base_ref']);
const RELAY_KEYS = new Set(['enabled', 'poll_seconds', 'reminder_seconds']);
const FOCUS_KEYS = new Set(['files', 'docs']);

// Repo config can never pick an executable, pass CLI args/env, relax permissions,
// place the worktree at an arbitrary filesystem location, or set a setup scope
// (security.md). These are refused with a security-specific message even though
// the generic unknown-key check would also reject them.
const FORBIDDEN_KEYS = new Set([
  'executable',
  'command',
  'cmd',
  'args',
  'cli_args',
  'argv',
  'env',
  'environment',
  'permission',
  'permissions',
  'bypass',
  'dangerously_skip_permissions',
  'path',
  'worktree_path',
  'location',
  'setup',
  'scope',
]);

const SESSION_NAME = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_PROJECT_NAME = 80;
const MAX_FOCUS_ENTRIES = 100;
const MAX_CONSTRAINTS = 100;
const MAX_CONSTRAINT_LEN = 2000;
const MAX_WORKERS = 32;
const POLL_MIN = 1;
const POLL_MAX = 60;
const REMINDER_MIN = 10;
const REMINDER_MAX = 3600;
const DEFAULT_CLIENT: ParticipantId = 'claude-code';

const LAUNCHER_REL = join('.crew', 'launcher.yaml');

export interface LauncherFile {
  readonly project: { readonly name: string | null; readonly sessionName: string | null };
  readonly runtime: { readonly client: ParticipantId | null };
  readonly worktree: {
    readonly enabled: boolean;
    readonly branch: string | null;
    readonly baseRef: string;
  };
  readonly relay: {
    readonly enabled: boolean;
    readonly pollSeconds: number;
    readonly reminderSeconds: number;
  };
  readonly focus: { readonly files: readonly string[]; readonly docs: readonly string[] };
  readonly constraints: readonly string[];
}

export type ClientSource = 'flag' | 'config' | 'default';

export interface EffectiveLaunchConfig {
  readonly client: ParticipantId;
  readonly clientSource: ClientSource;
  readonly workers: number | null;
  readonly taskFile: string | null;
  readonly worktree: {
    readonly enabled: boolean;
    readonly branch: string | null;
    readonly baseRef: string;
  };
  readonly relay: {
    readonly enabled: boolean;
    readonly pollSeconds: number;
    readonly reminderSeconds: number;
    readonly attach: boolean;
  };
  readonly focus: { readonly files: readonly string[]; readonly docs: readonly string[] };
  readonly constraints: readonly string[];
  readonly project: { readonly name: string | null; readonly sessionName: string | null };
}

/** CLI flags for `crew team <name> --launch`; commander collapses `--worktree`/`--no-worktree`. */
export interface LaunchFlags {
  readonly client?: string;
  readonly workers?: string;
  readonly taskFile?: string;
  /** string = `--worktree <branch>`; false = `--no-worktree`; undefined = neither (use config). */
  readonly worktree?: string | false;
  readonly noRelay?: boolean;
  readonly noAttach?: boolean;
}

function invalid(label: string, detail: string): never {
  throw new CrewError('INVALID_CONFIG', `${label}: ${detail}`);
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key)) {
      invalid(label, `field "${key}" is forbidden in repo config (security.md)`);
    }
  }
  const extras = Object.keys(obj).filter((key) => !allowed.has(key));
  if (extras.length > 0) {
    invalid(label, `unknown key(s): ${extras.join(', ')}`);
  }
}

function mapping(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(label, 'must be a mapping');
  }
  return value as Record<string, unknown>;
}

function optString(obj: Record<string, unknown>, key: string, label: string): string | null {
  const value = obj[key];
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    invalid(label, `${key} must be a string`);
  }
  return value;
}

function optBool(
  obj: Record<string, unknown>,
  key: string,
  fallback: boolean,
  label: string,
): boolean {
  const value = obj[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    invalid(label, `${key} must be a boolean`);
  }
  return value;
}

function optInt(
  obj: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  const value = obj[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    invalid(label, `${key} must be an integer ${min}-${max}`);
  }
  return value;
}

/** Reject an absolute or `..`-escaping workspace-relative path lexically (no IO). */
function assertContainedPath(raw: string, label: string): void {
  // Reject POSIX-absolute, UNC/backslash, and Windows drive-letter (e.g. `C:\`) paths
  // regardless of the host OS (isAbsolute only sees drive letters when running on Windows).
  if (isAbsolute(raw) || raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:/.test(raw)) {
    invalid(label, `path must be workspace-relative: ${raw}`);
  }
  const segments = raw.split(/[/\\]/);
  if (segments.includes('..')) {
    invalid(label, `path must not escape the workspace: ${raw}`);
  }
}

function parseStringList(value: unknown, max: number, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    invalid(label, 'must be a sequence');
  }
  if (value.length > max) {
    invalid(label, `must have at most ${max} entries`);
  }
  return value.map((item, i) => {
    if (typeof item !== 'string') {
      invalid(label, `entry ${i} must be a string`);
    }
    return item;
  });
}

function parseProject(obj: Record<string, unknown>, label: string): LauncherFile['project'] {
  if (obj.project === undefined) return { name: null, sessionName: null };
  const project = mapping(obj.project, `${label} project`);
  rejectUnknownKeys(project, PROJECT_KEYS, `${label} project`);
  const name = optString(project, 'name', `${label} project`);
  if (name !== null && name.length > MAX_PROJECT_NAME) {
    invalid(`${label} project`, `name must be at most ${MAX_PROJECT_NAME} characters`);
  }
  const sessionName = optString(project, 'session_name', `${label} project`);
  if (sessionName !== null && !SESSION_NAME.test(sessionName)) {
    invalid(`${label} project`, `session_name must match ${SESSION_NAME.source}`);
  }
  return { name, sessionName };
}

function parseRuntime(obj: Record<string, unknown>, label: string): LauncherFile['runtime'] {
  if (obj.runtime === undefined) return { client: null };
  const runtime = mapping(obj.runtime, `${label} runtime`);
  rejectUnknownKeys(runtime, RUNTIME_KEYS, `${label} runtime`);
  const client = optString(runtime, 'client', `${label} runtime`);
  if (client !== null && !isParticipantId(client)) {
    invalid(`${label} runtime`, `client must be one of ${PARTICIPANT_IDS.join(', ')}`);
  }
  return { client };
}

function parseWorktree(obj: Record<string, unknown>, label: string): LauncherFile['worktree'] {
  if (obj.workspace === undefined) return { enabled: false, branch: null, baseRef: 'HEAD' };
  const workspace = mapping(obj.workspace, `${label} workspace`);
  rejectUnknownKeys(workspace, WORKSPACE_KEYS, `${label} workspace`);
  if (workspace.worktree === undefined) return { enabled: false, branch: null, baseRef: 'HEAD' };
  const worktree = mapping(workspace.worktree, `${label} workspace.worktree`);
  rejectUnknownKeys(worktree, WORKTREE_KEYS, `${label} workspace.worktree`);
  const enabled = optBool(worktree, 'enabled', false, `${label} workspace.worktree`);
  const branch = optString(worktree, 'branch', `${label} workspace.worktree`);
  const baseRef = optString(worktree, 'base_ref', `${label} workspace.worktree`) ?? 'HEAD';
  // Validate ref syntax now (pure, no subprocess) so `--print` reports a plan git can run.
  if (branch !== null) assertValidBranch(branch, `${label} workspace.worktree.branch`);
  assertValidRevision(baseRef, `${label} workspace.worktree.base_ref`);
  return { enabled, branch, baseRef };
}

function parseRelay(obj: Record<string, unknown>, label: string): LauncherFile['relay'] {
  if (obj.relay === undefined) return { enabled: true, pollSeconds: 2, reminderSeconds: 30 };
  const relay = mapping(obj.relay, `${label} relay`);
  rejectUnknownKeys(relay, RELAY_KEYS, `${label} relay`);
  const enabled = optBool(relay, 'enabled', true, `${label} relay`);
  const pollSeconds = optInt(relay, 'poll_seconds', 2, POLL_MIN, POLL_MAX, `${label} relay`);
  const reminderSeconds = optInt(
    relay,
    'reminder_seconds',
    30,
    REMINDER_MIN,
    REMINDER_MAX,
    `${label} relay`,
  );
  if (reminderSeconds < pollSeconds) {
    invalid(`${label} relay`, 'reminder_seconds must be >= poll_seconds');
  }
  return { enabled, pollSeconds, reminderSeconds };
}

function parseFocus(obj: Record<string, unknown>, label: string): LauncherFile['focus'] {
  if (obj.focus === undefined) return { files: [], docs: [] };
  const focus = mapping(obj.focus, `${label} focus`);
  rejectUnknownKeys(focus, FOCUS_KEYS, `${label} focus`);
  const files = parseStringList(focus.files, MAX_FOCUS_ENTRIES, `${label} focus.files`);
  const docs = parseStringList(focus.docs, MAX_FOCUS_ENTRIES, `${label} focus.docs`);
  for (const file of files) assertContainedPath(file, `${label} focus.files`);
  for (const doc of docs) assertContainedPath(doc, `${label} focus.docs`);
  return { files, docs };
}

function parseConstraints(obj: Record<string, unknown>, label: string): string[] {
  const constraints = parseStringList(obj.constraints, MAX_CONSTRAINTS, `${label} constraints`);
  for (const [i, constraint] of constraints.entries()) {
    if (constraint.length > MAX_CONSTRAINT_LEN) {
      invalid(`${label} constraints`, `entry ${i} exceeds ${MAX_CONSTRAINT_LEN} characters`);
    }
  }
  return constraints;
}

/** Strict-parse and validate a `launcher.yaml` document. All sections optional but `version: 1`. */
export function parseLauncherConfig(src: string, label: string): LauncherFile {
  const doc = loadYamlMapping(src, label);
  rejectUnknownKeys(doc, LAUNCHER_KEYS, label);
  if (doc.version !== 1) {
    invalid(label, 'version must be exactly 1');
  }
  return {
    project: parseProject(doc, label),
    runtime: parseRuntime(doc, label),
    worktree: parseWorktree(doc, label),
    relay: parseRelay(doc, label),
    focus: parseFocus(doc, label),
    constraints: parseConstraints(doc, label),
  };
}

/** Default launcher config used when `.crew/launcher.yaml` is absent. */
const DEFAULT_LAUNCHER_FILE: LauncherFile = parseLauncherConfig('version: 1\n', 'launcher.yaml');

/** Load `.crew/launcher.yaml` for a Workspace, returning defaults when it is absent. */
export function loadLauncherConfig(root: string): LauncherFile {
  const path = join(workspacePaths(root).crew, 'launcher.yaml');
  if (!existsSync(path)) return DEFAULT_LAUNCHER_FILE;
  return parseLauncherConfig(
    readManagedFile(root, LAUNCHER_REL, MAX_CONFIG_BYTES),
    'launcher.yaml',
  );
}

function resolveClient(
  file: LauncherFile,
  flags: LaunchFlags,
): {
  client: ParticipantId;
  clientSource: ClientSource;
} {
  if (flags.client !== undefined) {
    if (!isParticipantId(flags.client)) {
      throw new CrewError(
        'USAGE',
        `invalid --client "${flags.client}"; expected one of ${PARTICIPANT_IDS.join(', ')}`,
      );
    }
    return { client: flags.client, clientSource: 'flag' };
  }
  if (file.runtime.client !== null) {
    return { client: file.runtime.client, clientSource: 'config' };
  }
  return { client: DEFAULT_CLIENT, clientSource: 'default' };
}

function resolveWorkers(flags: LaunchFlags): number | null {
  if (flags.workers === undefined) return null;
  if (!/^[1-9]\d*$/.test(flags.workers) || Number(flags.workers) > MAX_WORKERS) {
    throw new CrewError('USAGE', `--workers must be an integer 1-${MAX_WORKERS}`);
  }
  return Number(flags.workers);
}

function resolveTaskFile(flags: LaunchFlags): string | null {
  if (flags.taskFile === undefined) return null;
  if (flags.taskFile.length === 0) {
    throw new CrewError('USAGE', '--task-file must not be empty');
  }
  return flags.taskFile;
}

function resolveWorktree(
  file: LauncherFile,
  flags: LaunchFlags,
): EffectiveLaunchConfig['worktree'] {
  if (flags.worktree === false) {
    return { enabled: false, branch: file.worktree.branch, baseRef: file.worktree.baseRef };
  }
  if (typeof flags.worktree === 'string') {
    if (flags.worktree.length === 0) {
      throw new CrewError('USAGE', '--worktree branch must not be empty');
    }
    assertValidBranch(flags.worktree, '--worktree');
    return { enabled: true, branch: flags.worktree, baseRef: file.worktree.baseRef };
  }
  return { ...file.worktree };
}

/** Fold defaults < launcher.yaml < CLI flags into one immutable config with provenance. */
export function mergeEffectiveConfig(
  file: LauncherFile,
  flags: LaunchFlags,
): EffectiveLaunchConfig {
  const { client, clientSource } = resolveClient(file, flags);
  return {
    client,
    clientSource,
    workers: resolveWorkers(flags),
    taskFile: resolveTaskFile(flags),
    worktree: resolveWorktree(file, flags),
    relay: {
      enabled: file.relay.enabled && flags.noRelay !== true,
      pollSeconds: file.relay.pollSeconds,
      reminderSeconds: file.relay.reminderSeconds,
      attach: flags.noAttach !== true,
    },
    focus: file.focus,
    constraints: file.constraints,
    project: file.project,
  };
}
