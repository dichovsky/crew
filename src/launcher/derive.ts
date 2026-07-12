/**
 * Pure, deterministic launch derivations (configuration.md "Derived
 * names and paths"). No IO: every input — including the canonical (already
 * symlink-resolved) repository root and the injected environment — is passed in,
 * so `--print` can show exact target paths without touching the filesystem.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { CrewError } from '../errors.js';

const SESSION_MAX = 80;
const BRANCH_MAX = 64;
const REPO_HASH_LEN = 12;
const REF_HASH_LEN = 8;
const FALLBACK = 'crew';

/** Return `value` when it is a non-empty string, else `undefined`. */
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * Slugify per configuration.md: lower-case, replace each run of characters
 * outside `allowed` with `-`, trim leading/trailing `-`, truncate to `max`, and
 * fall back to `crew` when the result is empty.
 */
function slugify(raw: string, allowed: RegExp, max: number): string {
  const collapsed = raw.toLowerCase().replace(allowed, '-');
  const trimmed = collapsed.replace(/^-+/, '').replace(/-+$/, '');
  const truncated = trimmed.slice(0, max);
  return truncated.length === 0 ? FALLBACK : truncated;
}

/** Slugify a `session_name`: keep `[a-z0-9_-]` after lower-casing; truncate to 80. */
function slugifySession(raw: string): string {
  return slugify(raw, /[^a-z0-9_-]+/g, SESSION_MAX);
}

/** Derive the session name from `session_name`, else `project.name`, else the workspace dir. */
export function deriveSessionName(
  sessionName: string | null,
  projectName: string | null,
  workspaceDirName: string,
): string {
  const source = sessionName ?? projectName ?? workspaceDirName;
  return slugifySession(source);
}

/** Derive the `<branch-slug>`: keep `[a-z0-9-]` after lower-casing (`/` collapses); truncate to 64. */
export function branchSlug(branch: string): string {
  return slugify(branch, /[^a-z0-9-]+/g, BRANCH_MAX);
}

/** First 12 lower-hex characters of the SHA-256 of the canonical repo root path. */
export function repoHash(canonicalRepoRoot: string): string {
  return createHash('sha256')
    .update(canonicalRepoRoot, 'utf8')
    .digest('hex')
    .slice(0, REPO_HASH_LEN);
}

/**
 * The crew-managed worktree base: `${XDG_DATA_HOME or <home>/.local/share}/crew/worktrees`,
 * where `<home>` is `HOME` or (on Windows) `USERPROFILE` — matching `src/setup` home discovery.
 */
export function managedWorktreeBase(env: NodeJS.ProcessEnv): string {
  const home = nonEmpty(env.HOME) ?? nonEmpty(env.USERPROFILE);
  // XDG Base Directory spec: relative values are invalid and must be ignored.
  // Do this before joining so a malformed shell setting can never turn the
  // managed base into a path relative to the repository passed to git.
  const xdgDataHome = nonEmpty(env.XDG_DATA_HOME);
  const dataHome =
    (xdgDataHome !== undefined && isAbsolute(xdgDataHome) ? xdgDataHome : undefined) ??
    (home !== undefined ? join(home, '.local', 'share') : undefined);
  if (dataHome === undefined) {
    throw new CrewError(
      'NOT_FOUND',
      'cannot derive the worktree base: set XDG_DATA_HOME, HOME, or USERPROFILE',
    );
  }
  return join(dataHome, 'crew', 'worktrees');
}

/** First 8 lower-hex of the SHA-256 of the full branch ref (the path-uniqueness discriminator). */
function refHash(branch: string): string {
  return createHash('sha256').update(branch, 'utf8').digest('hex').slice(0, REF_HASH_LEN);
}

/**
 * The absolute managed worktree path `<base>/<repo-hash>/<branch-slug>-<ref-hash>`. The
 * readable slug can collide (`Feature/X` and `feature-x` both slug to `feature-x`), so a
 * short hash of the full branch ref is appended to keep distinct refs at distinct paths
 * (configuration.md). The validated ref — not the slug — is what git ever receives.
 */
export function worktreePath(
  env: NodeJS.ProcessEnv,
  canonicalRepoRoot: string,
  branch: string,
): string {
  const leaf = `${branchSlug(branch)}-${refHash(branch)}`;
  return join(managedWorktreeBase(env), repoHash(canonicalRepoRoot), leaf);
}
