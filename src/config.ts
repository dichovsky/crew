/**
 * Strict `.crew/config.yaml` parsing for workspace-level opt-in features
 * (currently only the per-Worker Task worktree isolation gate).
 * Follows the same hardened strict-key-rejection YAML discipline as
 * `launcher/config.ts` (single mapping, no aliases/merge/custom tags, 256 KiB
 * cap, unknown-key rejection) via the shared `loadYamlMapping` helper. Absent
 * file = all defaults (worker Task worktrees disabled).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CrewError } from './errors.js';
import { MAX_CONFIG_BYTES, readManagedFile } from './fs-safe.js';
import { assertValidBranch } from './launcher/ref.js';
import { workspacePaths } from './workspace.js';
import { loadYamlMapping } from './yaml-load.js';

const CONFIG_KEYS = new Set(['version', 'worker_worktrees']);
const WORKER_WORKTREES_KEYS = new Set(['enabled', 'base_ref']);

const CONFIG_REL = join('.crew', 'config.yaml');

export interface WorkspaceConfig {
  readonly workerWorktrees: {
    readonly enabled: boolean;
    readonly baseRef: string;
  };
}

function invalid(label: string, detail: string): never {
  throw new CrewError('INVALID_CONFIG', `${label}: ${detail}`);
}

function mapping(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(label, 'must be a mapping');
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  const extras = Object.keys(obj).filter((key) => !allowed.has(key));
  if (extras.length > 0) {
    invalid(label, `unknown key(s): ${extras.join(', ')}`);
  }
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

function parseWorkerWorktrees(
  doc: Record<string, unknown>,
  label: string,
): WorkspaceConfig['workerWorktrees'] {
  if (doc.worker_worktrees === undefined) return { enabled: false, baseRef: 'HEAD' };
  const worktrees = mapping(doc.worker_worktrees, `${label} worker_worktrees`);
  rejectUnknownKeys(worktrees, WORKER_WORKTREES_KEYS, `${label} worker_worktrees`);
  const enabled = optBool(worktrees, 'enabled', false, `${label} worker_worktrees`);
  const baseRef = optString(worktrees, 'base_ref', `${label} worker_worktrees`) ?? 'HEAD';
  // `base_ref` is the branch each new worktree is created from. Validate the
  // same branch-only contract here that resolveConcreteBaseRef enforces at use
  // time, so a Workspace can never load a configuration its worktrees cannot
  // use (for example, a revision expression such as `main~1`).
  assertValidBranch(baseRef, `${label} worker_worktrees.base_ref`);
  return { enabled, baseRef };
}

/** Strict-parse and validate a `config.yaml` document. All sections optional but `version: 1`. */
export function parseWorkspaceConfig(src: string, label: string): WorkspaceConfig {
  const doc = loadYamlMapping(src, label);
  rejectUnknownKeys(doc, CONFIG_KEYS, label);
  if (doc.version !== 1) {
    invalid(label, 'version must be exactly 1');
  }
  return { workerWorktrees: parseWorkerWorktrees(doc, label) };
}

/** Default workspace config used when `.crew/config.yaml` is absent. */
const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = parseWorkspaceConfig(
  'version: 1\n',
  'config.yaml',
);

/** Load `.crew/config.yaml` for a Workspace, returning defaults when it is absent. */
export function loadWorkspaceConfig(root: string): WorkspaceConfig {
  const path = join(workspacePaths(root).crew, 'config.yaml');
  if (!existsSync(path)) return DEFAULT_WORKSPACE_CONFIG;
  return parseWorkspaceConfig(readManagedFile(root, CONFIG_REL, MAX_CONFIG_BYTES), 'config.yaml');
}
