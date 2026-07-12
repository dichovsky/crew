/**
 * Shared git worktree primitives: the whole-Crew worktree resolver
 * (FR-H10/H21) plus the per-Task worktree primitives that back a Task-scoped
 * worktree lifecycle (derive, checkout, deletion-safety check, remove). Git runs
 * ONLY through the capture-only {@link Io.runProcess} in `git -C <dir> …` argv
 * form — never a shell string and never a new Io method.
 *
 * This module lives at the `src/` root (not under `src/launcher/`) because it is
 * called from both `src/launcher/session.ts` (the live tmux launch) and
 * Task-worktree callers outside the launcher domain.
 */
import { resolve } from 'node:path';
import { CrewError } from './errors.js';
import { assertNoSymlinkComponents, assertWithin } from './fs-safe.js';
import type { Io } from './io.js';
import { worktreePath as deriveWorktreePath } from './launcher/derive.js';
import { assertValidBranch, assertValidRevision } from './launcher/ref.js';

/** Bounded timeout for each git invocation; a hung git must not stall the caller. */
const GIT_TIMEOUT_MS = 10_000;

export interface WorktreeResolution {
  readonly path: string;
  readonly action: 'create' | 'reuse';
  readonly branch: string;
  readonly baseRef: string;
}

export interface WorktreeRequest {
  readonly repoRoot: string;
  readonly targetPath: string;
  readonly managedBase: string;
  readonly branch: string;
  readonly baseRef: string;
}

async function git(
  io: Io,
  args: readonly string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const result = await io.runProcess('git', args, { timeoutMs: GIT_TIMEOUT_MS });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Parse `git worktree list --porcelain` into a resolved-path → branch-ref (or null)
 * map. Blocks and lines are split on `\r?\n` so CRLF output (Windows git) parses too.
 */
function parseWorktreeList(porcelain: string): Map<string, string | null> {
  const byPath = new Map<string, string | null>();
  for (const block of porcelain.split(/\r?\n\r?\n+/)) {
    let path: string | null = null;
    let branch: string | null = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim();
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).trim();
    }
    if (path !== null) byPath.set(resolve(path), branch);
  }
  return byPath;
}

/** Resolve (create/reuse/refuse) the single whole-Crew worktree for a launch. */
export async function resolveWorktree(io: Io, req: WorktreeRequest): Promise<WorktreeResolution> {
  // Defense-in-depth: even if a caller bypassed config validation, never hand git an
  // option-looking or malformed ref (FR-H22).
  assertValidBranch(req.branch, 'worktree branch');
  assertValidRevision(req.baseRef, 'worktree base_ref');

  // Containment: a derived path that escapes the managed base — lexically OR through an
  // existing symlinked component — is rejected before any git command runs (FR-H10).
  const safeTarget = assertWithin(req.managedBase, req.targetPath);
  assertNoSymlinkComponents(req.managedBase, safeTarget);

  const top = await git(io, ['-C', req.repoRoot, 'rev-parse', '--show-toplevel']);
  if (top.status !== 0) {
    throw new CrewError('NOT_FOUND', `not a git repository: ${req.repoRoot}`);
  }
  const repoTop = top.stdout.trim();

  // Probe the SPECIFIC head ref (not an ambiguous rev a tag could satisfy). A null
  // status is a spawn/timeout failure, not "branch absent" — fail rather than mutate.
  const wantRef = `refs/heads/${req.branch}`;
  const headProbe = await git(io, ['-C', repoTop, 'rev-parse', '--verify', '--quiet', wantRef]);
  if (headProbe.status === null) {
    throw new CrewError('NOT_FOUND', `git rev-parse failed to run in ${repoTop}`);
  }
  const branchExists = headProbe.status === 0;

  const list = await git(io, ['-C', repoTop, 'worktree', 'list', '--porcelain']);
  if (list.status !== 0) {
    // Fail loudly: a non-zero list status would otherwise parse to an empty map
    // and fall through to `worktree add`, masking the real cause.
    throw new CrewError('NOT_FOUND', `cannot list worktrees in ${repoTop}: ${list.stderr.trim()}`);
  }
  const existing = parseWorktreeList(list.stdout);
  const resolvedTarget = resolve(req.targetPath);

  if (existing.has(resolvedTarget)) {
    const existingRef = existing.get(resolvedTarget) ?? null;
    if (branchExists && existingRef === wantRef) {
      return { path: req.targetPath, action: 'reuse', branch: req.branch, baseRef: req.baseRef };
    }
    throw new CrewError(
      'ALREADY_EXISTS',
      `a worktree at ${req.targetPath} is checked out on ${existingRef ?? 'a detached HEAD'}, not ${req.branch}`,
    );
  }

  // Absent: create. An existing branch is checked out by its full head ref; a new
  // branch is created from baseRef. Branch/base are validated above and passed as
  // separate, non-option argv elements.
  const addArgs = branchExists
    ? ['-C', repoTop, 'worktree', 'add', req.targetPath, wantRef]
    : ['-C', repoTop, 'worktree', 'add', '-b', req.branch, req.targetPath, req.baseRef];
  const add = await git(io, addArgs);
  if (add.status !== 0) {
    // The target was verified absent from git's worktree registry, so this is an
    // operational git failure (locked branch, fs permission, …), not ALREADY_EXISTS.
    throw new CrewError(
      'NOT_FOUND',
      `git worktree add failed for ${req.targetPath}: ${add.stderr.trim()}`,
    );
  }
  return { path: req.targetPath, action: 'create', branch: req.branch, baseRef: req.baseRef };
}

// ---------------------------------------------------------------------------
// Per-Task worktree primitives
// ---------------------------------------------------------------------------

/** Cap on the slugified title segment of a Task branch name (mirrors derive.ts's BRANCH_MAX use). */
const TASK_TITLE_SLUG_MAX = 40;

/**
 * Slugify a Task title for embedding in a branch name: lower-case, collapse
 * every run of non-alphanumeric characters to `-`, trim leading/trailing `-`,
 * cap at {@link TASK_TITLE_SLUG_MAX} characters, and fall back to `task` when
 * the result is empty (mirrors the slugify convention in `launcher/derive.ts`).
 */
function slugifyTaskTitle(title: string): string {
  const collapsed = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const trimmed = collapsed.replace(/^-+/, '').replace(/-+$/, '');
  const truncated = trimmed.slice(0, TASK_TITLE_SLUG_MAX);
  return truncated.length === 0 ? 'task' : truncated;
}

export interface TaskWorktreeDerivation {
  readonly path: string;
  readonly branch: string;
}

/**
 * Derive a per-Task worktree path and branch name. The branch is
 * `crew/task-<taskId>-<slugified title>` (deterministic, collision-free given a
 * unique `taskId`) and is validated with {@link assertValidBranch} before ever
 * being used to derive a path or passed to git. The path is derived through the
 * SAME managed-base convention as the whole-Crew worktree
 * (`{@link worktreePath}` from `launcher/derive.ts`: `<base>/<repo-hash>/<branch-slug>-<ref-hash>`),
 * so a Task's worktree lands in the same managed location family — keyed
 * additionally by the Task id via the branch name baked into that path's hash.
 *
 * `env` is accepted (not just `repoRoot`) because the managed base is derived
 * from `XDG_DATA_HOME`/`HOME`/`USERPROFILE` (`managedWorktreeBase`); this
 * mirrors `worktreePath`'s own `(env, canonicalRepoRoot, branch)` signature so
 * the derivation stays pure (no reach into `process.env`).
 */
export function deriveTaskWorktreePath(
  env: NodeJS.ProcessEnv,
  taskId: string,
  title: string,
  repoRoot: string,
): TaskWorktreeDerivation {
  const branch = `crew/task-${taskId}-${slugifyTaskTitle(title)}`;
  assertValidBranch(branch, 'task worktree branch');
  const path = deriveWorktreePath(env, repoRoot, branch);
  return { path, branch };
}

export interface ReviewWorktreeDerivation {
  readonly path: string;
  readonly branch: string;
}

/**
 * Git branch syntax is narrower than the public Agent-id grammar (notably,
 * `.lock`, a trailing dot, and `..` are valid in an id but invalid in a
 * branch). Hex-encode every ASCII id character so the review branch remains
 * deterministic, collision-free, and git-safe without narrowing Agent ids.
 */
function reviewAgentBranchSegment(agentId: string): string {
  return Array.from(agentId, (char) => char.codePointAt(0)!.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive an Agent's ONE dedicated review worktree path and branch name
 * (`crew/review-<hex-agent-id>`, deterministic and stable across every Task that
 * Agent ever reviews — {@link checkoutRef} is what moves it between Task
 * branches). Validated with {@link assertValidBranch} before ever reaching a
 * path or git, and derived through the same managed-base convention as the
 * whole-Crew and per-Task worktrees (`{@link worktreePath}` from
 * `launcher/derive.ts`).
 */
export function deriveReviewWorktreePath(
  env: NodeJS.ProcessEnv,
  agentId: string,
  repoRoot: string,
): ReviewWorktreeDerivation {
  const branch = `crew/review-${reviewAgentBranchSegment(agentId)}`;
  assertValidBranch(branch, 'review worktree branch');
  const path = deriveWorktreePath(env, repoRoot, branch);
  return { path, branch };
}

/**
 * Resolve a configured base ref to a concrete branch name. The literal `HEAD`
 * is resolved via `git rev-parse --abbrev-ref HEAD` run in `repoRoot`, so a
 * persisted `worktree_base_ref` is never the literal "HEAD" (see the schema v4
 * `tasks` CHECK comment: a later "has this landed" check needs a fixed
 * ancestor, not whatever HEAD means evaluated from a different working
 * directory). Any other configured value is used as-is. Either way, the result
 * is validated with {@link assertValidBranch} before it is ever used again.
 */
export async function resolveConcreteBaseRef(
  io: Io,
  repoRoot: string,
  configuredBaseRef: string,
): Promise<string> {
  if (configuredBaseRef !== 'HEAD') {
    assertValidBranch(configuredBaseRef, 'configured base ref');
    return configuredBaseRef;
  }
  const result = await git(io, ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (result.status !== 0) {
    throw new CrewError(
      'NOT_FOUND',
      `git rev-parse --abbrev-ref HEAD failed in ${repoRoot}: ${result.stderr.trim()}`,
    );
  }
  const branch = result.stdout.trim();
  // `--abbrev-ref HEAD` itself prints the literal "HEAD" for a detached checkout
  // (no branch to abbreviate to) — the one case resolution must refuse rather
  // than silently persist, since it is exactly the value this function exists
  // to resolve AWAY from.
  if (branch === 'HEAD') {
    throw new CrewError(
      'NOT_FOUND',
      `cannot resolve HEAD to a branch in ${repoRoot}: it is in a detached HEAD state`,
    );
  }
  assertValidBranch(branch, 'resolved base ref');
  return branch;
}

/**
 * Point an EXISTING worktree at `worktreePath` at `ref` (a branch or
 * revision) via a DETACHED checkout (`git checkout --detach`). Distinct from
 * {@link resolveWorktree}, which creates/reuses a NEW worktree: this is the
 * Reviewer's dedicated, reusable worktree switching between its resting
 * `base_ref` and a Task's branch. The checkout is ALWAYS detached — never a
 * real branch checkout — because `ref` is, in the normal case, already
 * checked out somewhere else: a Task's branch is held by the assignee's own
 * task worktree for as long as the Task is `submitted`/`completed` (only
 * `task land`/`abandon` release it), and `base_ref` is typically whatever the
 * shared Workspace itself has checked out. Git refuses a real (non-detached)
 * checkout of a branch already checked out in another worktree; a detached
 * checkout resolves `ref` to its current commit without claiming the branch
 * name, so it never collides. `ref` is validated with the more permissive
 * {@link assertValidRevision} (it may be a branch OR a revision) before ever
 * reaching git.
 */
export async function checkoutRef(io: Io, worktreePath: string, ref: string): Promise<void> {
  assertValidRevision(ref, 'checkout ref');
  const result = await git(io, ['-C', worktreePath, 'checkout', '--detach', ref]);
  if (result.status !== 0) {
    throw new CrewError(
      'NOT_FOUND',
      `git checkout --detach ${ref} failed in ${worktreePath}: ${result.stderr.trim()}`,
    );
  }
}

/**
 * Deletion-safety check for a Task's worktree: returns `true` (UNSAFE to
 * delete) when EITHER the working tree has uncommitted changes (`git status
 * --porcelain` is non-empty) OR `branch`'s commits are not yet reachable from
 * `baseRef` (`git merge-base --is-ancestor branch baseRef` exits non-zero).
 * This is the local-git-native way to know whether a Task's change has
 * genuinely landed, since crew has no GitHub/remote awareness.
 */
export async function hasUnlandedChanges(
  io: Io,
  worktreePath: string,
  branch: string,
  baseRef: string,
): Promise<boolean> {
  assertValidBranch(branch, 'unlanded-check branch');
  assertValidRevision(baseRef, 'unlanded-check base_ref');

  const status = await git(io, ['-C', worktreePath, 'status', '--porcelain']);
  if (status.status !== 0) {
    throw new CrewError(
      'NOT_FOUND',
      `git status failed in ${worktreePath}: ${status.stderr.trim()}`,
    );
  }
  if (status.stdout.trim().length > 0) {
    return true; // uncommitted working-tree changes
  }

  const ancestor = await git(io, [
    '-C',
    worktreePath,
    'merge-base',
    '--is-ancestor',
    branch,
    baseRef,
  ]);
  if (ancestor.status === null) {
    throw new CrewError(
      'NOT_FOUND',
      `git merge-base --is-ancestor failed to run in ${worktreePath}`,
    );
  }
  // A non-zero (but non-null) exit means "not an ancestor": the branch's work
  // is not yet merged into baseRef, so it is unsafe to delete.
  return ancestor.status !== 0;
}

/** Outcome of {@link removeTaskWorktree}'s branch delete, once the worktree itself is gone. */
export interface RemoveTaskWorktreeResult {
  readonly branchDeleted: boolean;
  /** Raw stderr when `branchDeleted` is `false`; `null` otherwise. */
  readonly branchDeleteError: string | null;
}

/**
 * Remove a Task's worktree and its branch. Runs `git -C <repoRoot> worktree
 * remove [--force] <worktreePath>` then, only on success, the SAFE
 * `git -C <repoRoot> branch -d <branch>` (which itself refuses an unmerged
 * branch — a deliberate second, independent safety net kept even under
 * `force`, matching this codebase's existing defense-in-depth style).
 * `repoRoot` is required — `git worktree remove` can refuse to remove the
 * very worktree a process is running from, and {@link Io.runProcess} passes
 * no `cwd`, so without an explicit `-C` these calls would silently run
 * against whatever directory the crew process happens to be started in
 * instead of the resolved Workspace root, matching every other git call in
 * this file and the sibling `removeCreatedWorktree` in
 * `src/launcher/session.ts`.
 *
 * `force`: real git refuses `worktree remove` on a worktree with uncommitted
 * or untracked changes unless `--force` is passed — pass `true` exactly when
 * the caller already decided to proceed despite crew's own
 * {@link hasUnlandedChanges} heuristic (i.e. an explicit `--force` from the
 * operator, or an unconditional removal like Task abandonment), never as a
 * blanket default.
 *
 * If `worktree remove` itself fails, this throws and state is left
 * unchanged — genuinely nothing happened, safe to retry/investigate. If it
 * SUCCEEDS but the branch delete then fails (typically: the branch is not
 * merged, which `--force` deliberately does not override), this does NOT
 * throw — the worktree is really gone, which is the caller's primary
 * concern, so leaving the caller's own bookkeeping permanently stuck over a
 * leftover local branch object would be worse than surfacing it as a
 * non-fatal result the caller can warn about.
 */
export async function removeTaskWorktree(
  io: Io,
  repoRoot: string,
  worktreePath: string,
  branch: string,
  options?: { readonly force?: boolean },
): Promise<RemoveTaskWorktreeResult> {
  assertValidBranch(branch, 'worktree removal branch');

  const removeArgs = ['-C', repoRoot, 'worktree', 'remove'];
  if (options?.force === true) removeArgs.push('--force');
  removeArgs.push(worktreePath);
  const remove = await git(io, removeArgs);
  if (remove.status !== 0) {
    throw new CrewError(
      'NOT_FOUND',
      `git worktree remove failed for ${worktreePath}: ${remove.stderr.trim()}`,
    );
  }

  const del = await git(io, ['-C', repoRoot, 'branch', '-d', branch]);
  if (del.status !== 0) {
    return { branchDeleted: false, branchDeleteError: del.stderr.trim() };
  }
  return { branchDeleted: true, branchDeleteError: null };
}
