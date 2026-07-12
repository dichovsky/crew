/**
 * Workspace discovery (FR-B01/B02).
 *
 * State commands operate on the nearest ancestor directory that contains a
 * `.crew/` directory. Discovery is pure over a starting directory (the injected
 * {@link Io.cwd} in commands) so it is testable without changing the process cwd.
 */
import { existsSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CrewError } from './errors.js';
import { ensureManagedDir, MAX_CONFIG_BYTES, readManagedFile, writeFileAtomic } from './fs-safe.js';

/** The marker directory that identifies a crew Workspace root. */
export const WORKSPACE_DIRNAME = '.crew';

/** The SQLite State Store filename below `.crew/state/`. */
export const STATE_DB_BASENAME = 'crew.db';

/**
 * Basename of the workspace-pointer file below `.crew/state/`. Its presence
 * redirects discovery from a locally-found `.crew/` to the real, shared
 * workspace root named by its (trimmed) contents — the fix for a git worktree
 * that checks out tracked `.crew/roles`/`.crew/teams` but not the gitignored
 * `.crew/state/`, which would otherwise look like a real but disconnected
 * Workspace. Nothing writes this file yet; a later worktree-creation stage
 * owns that.
 */
export const WORKSPACE_POINTER_BASENAME = 'workspace-pointer';

/**
 * Basenames of the State Store file and its WAL/SHM sidecars, in deletion order.
 * `clean` removes exactly these; nothing else under `.crew/state/`.
 */
export const STATE_DB_FILES = [
  STATE_DB_BASENAME,
  `${STATE_DB_BASENAME}-wal`,
  `${STATE_DB_BASENAME}-shm`,
] as const;

/** Absolute paths for the managed subtree of a Workspace, derived from its root. */
export interface WorkspacePaths {
  readonly root: string;
  readonly crew: string;
  readonly roles: string;
  readonly teams: string;
  readonly state: string;
  readonly db: string;
  readonly generated: string;
  readonly gitignore: string;
  readonly pointerFile: string;
}

/** Derive the managed paths under a Workspace root. Pure; touches no filesystem. */
export function workspacePaths(root: string): WorkspacePaths {
  const crew = join(root, WORKSPACE_DIRNAME);
  const state = join(crew, 'state');
  return {
    root,
    crew,
    roles: join(crew, 'roles'),
    teams: join(crew, 'teams'),
    state,
    db: join(state, STATE_DB_BASENAME),
    generated: join(crew, 'generated'),
    gitignore: join(crew, '.gitignore'),
    pointerFile: join(state, WORKSPACE_POINTER_BASENAME),
  };
}

/**
 * Workspace-relative path of a project Role file, for managed IO and display.
 * Handlers pass this to the managed-read helpers instead of hand-rolling the
 * `.crew/` prefix, so the marker-directory literal lives only here.
 */
export function roleRelPath(name: string): string {
  return join(WORKSPACE_DIRNAME, 'roles', `${name}.md`);
}

/** Workspace-relative path of a project Team file, for managed IO and display. */
export function teamRelPath(name: string): string {
  return join(WORKSPACE_DIRNAME, 'teams', `${name}.yaml`);
}

/** Workspace-relative path of the managed `.crew/.gitignore`. */
export function gitignoreRelPath(): string {
  return join(WORKSPACE_DIRNAME, '.gitignore');
}

// lstat (not stat) so a symlinked `.crew` is not accepted as a Workspace marker;
// following such a link would let config reads operate outside the resolved root.
function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read a workspace-pointer file's redirect target, or `null` if absent, empty,
 * oversized, non-UTF-8, or a symlink/escape — the same hardened
 * {@link readManagedFile} every other managed config read in this codebase
 * uses (size cap, symlink/containment check), not a raw `readFileSync`.
 * Whitespace/newlines are trimmed and the result is `resolve()`d so a
 * relative or malformed target can't silently resolve against whatever the
 * process's ambient cwd happens to be; the caller separately re-validates the
 * resolved target against the same `.crew/` check as ordinary discovery —
 * defense in depth against a stale or corrupt pointer.
 */
type PointerRead =
  | { readonly state: 'absent' | 'blank' }
  | { readonly state: 'invalid' }
  | { readonly state: 'target'; readonly target: string };

function readPointerTarget(root: string): PointerRead {
  const paths = workspacePaths(root);
  if (!existsSync(paths.pointerFile)) return { state: 'absent' };
  let content: string;
  try {
    content = readManagedFile(
      root,
      join(WORKSPACE_DIRNAME, 'state', WORKSPACE_POINTER_BASENAME),
      MAX_CONFIG_BYTES,
    );
  } catch {
    return { state: 'invalid' };
  }
  const trimmed = content.trim();
  if (trimmed === '') return { state: 'blank' };
  return { state: 'target', target: resolve(trimmed) };
}

/**
 * Walk up from `startDir` and return the nearest ancestor (inclusive) that
 * contains a `.crew/` directory, or `null` if none exists up to the filesystem
 * root. When the found `.crew/` carries a workspace-pointer file (see
 * {@link WORKSPACE_POINTER_BASENAME}), discovery follows it to the pointed-to
 * root instead — but only when that target independently passes the exact
 * same real-`.crew/`-directory check; an invalid pointer target is a
 * discovery failure, not a silent fall-back to the local (disconnected) root.
 */
export function findWorkspaceRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (isRealDirectory(join(dir, WORKSPACE_DIRNAME))) {
      const pointer = readPointerTarget(dir);
      switch (pointer.state) {
        case 'absent':
        case 'blank':
          return dir;
        case 'invalid':
          return null;
        case 'target':
          return isRealDirectory(join(pointer.target, WORKSPACE_DIRNAME)) ? pointer.target : null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/**
 * Resolve the Workspace root for a command, throwing `NOT_WORKSPACE` when the
 * starting directory has no `.crew/` ancestor.
 */
export function resolveWorkspaceRoot(startDir: string): string {
  const root = findWorkspaceRoot(startDir);
  if (root === null) {
    throw new CrewError(
      'NOT_WORKSPACE',
      'no .crew/ workspace found in this or any parent directory; run "crew init" first',
    );
  }
  return root;
}

/**
 * Write the workspace-pointer file into a freshly created Task worktree's
 * `.crew/state/` (see {@link WORKSPACE_POINTER_BASENAME}), redirecting
 * discovery from that worktree's own local, disconnected `.crew/` back to the
 * real, shared Workspace root. `.crew/state/` is created first: a fresh `git
 * worktree` checkout carries the tracked `.crew/roles`/`.crew/teams` but not
 * the gitignored `.crew/state/`.
 */
export function writeWorkspacePointer(worktreeRoot: string, sharedWorkspaceRoot: string): void {
  ensureManagedDir(worktreeRoot, join(WORKSPACE_DIRNAME, 'state'));
  writeFileAtomic(
    worktreeRoot,
    join(WORKSPACE_DIRNAME, 'state', WORKSPACE_POINTER_BASENAME),
    `${sharedWorkspaceRoot}\n`,
  );
}
