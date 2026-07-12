import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkoutRef,
  deriveReviewWorktreePath,
  deriveTaskWorktreePath,
  hasUnlandedChanges,
  removeTaskWorktree,
  resolveConcreteBaseRef,
  resolveWorktree,
} from '../../src/worktree.js';
import { CrewError } from '../../src/errors.js';
import { worktreePath as deriveWorktreePath } from '../../src/launcher/derive.js';
import { assertValidBranch } from '../../src/launcher/ref.js';
import { captureIo, recordingRunProcess } from '../helpers/io.js';
import type { ProcessResult } from '../../src/io.js';

const MANAGED_BASE = '/data/crew/worktrees';
const TARGET = '/data/crew/worktrees/abc123/feature-x';
const REPO_ROOT = '/repo';

function ok(stdout = ''): ProcessResult {
  return { status: 0, stdout, stderr: '' };
}
function fail(): ProcessResult {
  return { status: 128, stdout: '', stderr: 'fatal' };
}
/** A spawn/timeout failure: runProcess could not start git (status null). */
function nullStatus(): ProcessResult {
  return { status: null, stdout: '', stderr: '' };
}

function runIo(script: ProcessResult[]) {
  const rec = recordingRunProcess(script);
  return { io: captureIo({ runProcess: rec.runProcess }).io, calls: rec.calls };
}

const OPTS = {
  repoRoot: REPO_ROOT,
  targetPath: TARGET,
  managedBase: MANAGED_BASE,
  branch: 'feature/x',
  baseRef: 'HEAD',
};

describe('resolveWorktree', () => {
  it('creates a new branch worktree with an argv array when absent', async () => {
    const { io, calls } = runIo([
      ok('/repo\n'), // rev-parse --show-toplevel
      fail(), // rev-parse --symbolic-full-name (branch does not exist yet)
      ok('worktree /repo\nHEAD aaaa\nbranch refs/heads/main\n\n'), // worktree list
      ok(''), // worktree add
    ]);
    const res = await resolveWorktree(io, OPTS);
    expect(res).toEqual({ path: TARGET, action: 'create', branch: 'feature/x', baseRef: 'HEAD' });
    expect(calls.map((c) => c.file)).toEqual(['git', 'git', 'git', 'git']);
    expect(calls[0]!.args).toEqual(['-C', '/repo', 'rev-parse', '--show-toplevel']);
    expect(calls[3]!.args).toEqual([
      '-C',
      '/repo',
      'worktree',
      'add',
      '-b',
      'feature/x',
      TARGET,
      'HEAD',
    ]);
  });

  it('reuses an existing worktree only on an exact ref match (no add call)', async () => {
    const { io, calls } = runIo([
      ok('/repo\n'),
      ok('refs/heads/feature/x\n'), // normalized full ref
      ok(`worktree ${TARGET}\nHEAD bbbb\nbranch refs/heads/feature/x\n\n`),
    ]);
    const res = await resolveWorktree(io, OPTS);
    expect(res.action).toBe('reuse');
    expect(calls).toHaveLength(3); // no worktree add
  });

  it('refuses to reuse a worktree checked out on a different branch', async () => {
    const { io } = runIo([
      ok('/repo\n'),
      ok('refs/heads/feature/x\n'),
      ok(`worktree ${TARGET}\nHEAD cccc\nbranch refs/heads/other\n\n`),
    ]);
    await expect(resolveWorktree(io, OPTS)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('creates a worktree for an EXISTING branch with the no-"-b" argv form', async () => {
    const { io, calls } = runIo([
      ok('/repo\n'), // rev-parse --show-toplevel
      ok('refs/heads/feature/x\n'), // branch already exists (non-empty full ref)
      ok('worktree /repo\nHEAD aaaa\nbranch refs/heads/main\n\n'), // target path absent
      ok(''), // worktree add
    ]);
    const res = await resolveWorktree(io, OPTS);
    expect(res.action).toBe('create');
    // an existing branch is checked out by its full head ref (unambiguous, non-option)
    expect(calls[3]!.args).toEqual([
      '-C',
      '/repo',
      'worktree',
      'add',
      TARGET,
      'refs/heads/feature/x',
    ]);
  });

  it('refuses to reuse a worktree in detached-HEAD state at the target path', async () => {
    const { io } = runIo([
      ok('/repo\n'),
      ok('refs/heads/feature/x\n'),
      ok(`worktree ${TARGET}\nHEAD dddd\ndetached\n\n`), // no branch line = detached HEAD
    ]);
    await expect(resolveWorktree(io, OPTS)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('rejects a target path outside the managed base before any git call', async () => {
    const { io, calls } = runIo([]);
    await expect(
      resolveWorktree(io, { ...OPTS, targetPath: '/etc/passwd' }),
    ).rejects.toBeInstanceOf(CrewError);
    expect(calls).toHaveLength(0);
  });

  it('errors when the repo root is not a git repository', async () => {
    const { io } = runIo([fail()]);
    await expect(resolveWorktree(io, OPTS)).rejects.toBeInstanceOf(CrewError);
  });

  it('errors (NOT_FOUND) when git worktree add fails, surfacing git stderr', async () => {
    const { io } = runIo([
      ok('/repo\n'),
      fail(), // new branch
      ok('worktree /repo\nHEAD aaaa\nbranch refs/heads/main\n\n'),
      fail(), // worktree add fails
    ]);
    const error = await resolveWorktree(io, OPTS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrewError);
    expect((error as CrewError).code).toBe('NOT_FOUND');
    expect((error as CrewError).message).toContain('fatal');
  });

  it('errors when git worktree list fails instead of silently falling through to add', async () => {
    const { io, calls } = runIo([
      ok('/repo\n'),
      fail(), // ref probe: branch does not exist
      fail(), // worktree list fails
    ]);
    await expect(resolveWorktree(io, OPTS)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(calls).toHaveLength(3); // never attempted `worktree add`
  });

  it('treats a null ref-probe status (spawn/timeout) as a failure, not "branch absent"', async () => {
    const { io, calls } = runIo([
      ok('/repo\n'), // rev-parse --show-toplevel
      nullStatus(), // rev-parse --verify could not run
    ]);
    await expect(resolveWorktree(io, OPTS)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(calls).toHaveLength(2); // never listed or added
  });

  it('parses CRLF porcelain output (Windows git) and reuses on an exact match', async () => {
    const { io, calls } = runIo([
      ok('/repo\n'),
      ok(), // ref probe: branch exists
      ok(`worktree ${TARGET}\r\nHEAD bbbb\r\nbranch refs/heads/feature/x\r\n\r\n`),
    ]);
    const res = await resolveWorktree(io, OPTS);
    expect(res.action).toBe('reuse');
    expect(calls).toHaveLength(3);
  });

  it('rejects an option-injecting branch before any git call', async () => {
    const { io, calls } = runIo([]);
    await expect(
      resolveWorktree(io, { ...OPTS, branch: '--upload-pack=evil' }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(calls).toHaveLength(0);
  });

  describe('symlink containment (real filesystem)', () => {
    const made: string[] = [];
    afterEach(() => {
      while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
    });

    it('rejects a target reached through a symlinked component before any git call', async () => {
      const base = mkdtempSync(join(tmpdir(), 'crew-wt-base-'));
      const outside = mkdtempSync(join(tmpdir(), 'crew-wt-out-'));
      made.push(base, outside);
      // <base>/hash -> <outside>: a launch target under <base>/hash/leaf escapes the base.
      symlinkSync(outside, join(base, 'hash'));
      mkdirSync(join(outside, 'leaf'), { recursive: true });
      const { io, calls } = runIo([]);
      await expect(
        resolveWorktree(io, {
          ...OPTS,
          managedBase: base,
          targetPath: join(base, 'hash', 'leaf'),
        }),
      ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
      expect(calls).toHaveLength(0);
    });
  });
});

describe('deriveTaskWorktreePath', () => {
  const ENV = { XDG_DATA_HOME: '/data' };
  const TASK_ID = 'e2f7b6b0-7f8b-4d3e-9a1a-0f1f2f3f4f5f';

  it('derives a deterministic branch and a path in the same managed-base family', () => {
    const a = deriveTaskWorktreePath(ENV, TASK_ID, 'Fix the login bug', REPO_ROOT);
    const b = deriveTaskWorktreePath(ENV, TASK_ID, 'Fix the login bug', REPO_ROOT);
    expect(a).toEqual(b); // deterministic given the same inputs

    expect(a.branch).toBe(`crew/task-${TASK_ID}-fix-the-login-bug`);
    // the branch itself must be git-valid (defense-in-depth, not just hoped for)
    expect(() => assertValidBranch(a.branch, 'test')).not.toThrow();
    // the path lands under the SAME managed-base convention as the whole-Crew worktree
    expect(a.path).toBe(deriveWorktreePath(ENV, REPO_ROOT, a.branch));
    expect(a.path.startsWith('/data/crew/worktrees/')).toBe(true);
  });

  it('keys distinct Task ids to distinct branches/paths even with an identical title', () => {
    const a = deriveTaskWorktreePath(ENV, TASK_ID, 'Same title', REPO_ROOT);
    const b = deriveTaskWorktreePath(
      ENV,
      'a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5',
      'Same title',
      REPO_ROOT,
    );
    expect(a.branch).not.toBe(b.branch);
    expect(a.path).not.toBe(b.path);
  });

  it('produces a valid, bounded branch name for a very long, weird-character title', () => {
    const wildTitle = '  ***Ünïcode!! & <script>alert(1)</script>  '.repeat(10);
    const res = deriveTaskWorktreePath(ENV, TASK_ID, wildTitle, REPO_ROOT);
    expect(() => assertValidBranch(res.branch, 'test')).not.toThrow();
    // the slugified title segment is capped, so the branch does not grow unbounded
    expect(res.branch.length).toBeLessThan(200);
    expect(res.branch).toMatch(/^crew\/task-[0-9a-f-]+-[a-z0-9-]+$/);
  });

  it('falls back to a "task" slug when the title has no slug-safe characters', () => {
    const res = deriveTaskWorktreePath(ENV, TASK_ID, '!!!###', REPO_ROOT);
    expect(res.branch).toBe(`crew/task-${TASK_ID}-task`);
    expect(() => assertValidBranch(res.branch, 'test')).not.toThrow();
  });
});

describe('checkoutRef', () => {
  const WT = '/data/crew/worktrees/abc123/feature-x';

  it('runs a bounded, DETACHED git checkout with the exact argv', async () => {
    const { io, calls } = runIo([ok()]);
    await checkoutRef(io, WT, 'main');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['-C', WT, 'checkout', '--detach', 'main']);
    expect(calls[0]!.timeoutMs).toBe(10_000);
  });

  it('accepts a revision (SHA/HEAD), not only a branch name', async () => {
    const { io, calls } = runIo([ok()]);
    await checkoutRef(io, WT, 'HEAD');
    expect(calls[0]!.args).toEqual(['-C', WT, 'checkout', '--detach', 'HEAD']);
  });

  it('is always detached, even when ref is a branch already checked out in another worktree', async () => {
    // The whole point of --detach: git refuses a REAL checkout of a branch
    // already claimed by another worktree, but a detached checkout of that
    // same branch's commit is always safe. This test just pins the argv;
    // real-git behavior around this exact scenario is asserted separately.
    const { io, calls } = runIo([ok()]);
    await checkoutRef(io, WT, 'crew/task-1-fix-login');
    expect(calls[0]!.args).toContain('--detach');
  });

  it('throws CrewError with git stderr when checkout fails', async () => {
    const { io } = runIo([fail()]);
    const error = await checkoutRef(io, WT, 'main').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrewError);
    expect((error as CrewError).message).toContain('fatal');
  });

  it('rejects an invalid ref before any git call', async () => {
    const { io, calls } = runIo([]);
    await expect(checkoutRef(io, WT, 'bad..ref')).rejects.toBeInstanceOf(CrewError);
    expect(calls).toHaveLength(0);
  });
});

describe('hasUnlandedChanges', () => {
  const WT = '/data/crew/worktrees/abc123/feature-x';
  const BRANCH = 'crew/task-x';
  const BASE = 'main';

  it('is false when the tree is clean and the branch is merged into base', async () => {
    const { io, calls } = runIo([
      ok(''), // status --porcelain: clean
      ok(''), // merge-base --is-ancestor: exit 0 = ancestor (merged)
    ]);
    await expect(hasUnlandedChanges(io, WT, BRANCH, BASE)).resolves.toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual(['-C', WT, 'status', '--porcelain']);
    expect(calls[1]!.args).toEqual(['-C', WT, 'merge-base', '--is-ancestor', BRANCH, BASE]);
  });

  it('is true when the working tree has uncommitted changes (dirty)', async () => {
    const { io, calls } = runIo([ok(' M src/foo.ts\n')]);
    await expect(hasUnlandedChanges(io, WT, BRANCH, BASE)).resolves.toBe(true);
    // short-circuits: dirty is decisive, merge-base is never consulted
    expect(calls).toHaveLength(1);
  });

  it('is true when the tree is clean but the branch is not an ancestor of base (unmerged)', async () => {
    const { io, calls } = runIo([ok(''), fail()]);
    await expect(hasUnlandedChanges(io, WT, BRANCH, BASE)).resolves.toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('is true when BOTH dirty and unmerged (dirty alone is enough to decide)', async () => {
    const { io, calls } = runIo([ok(' M src/foo.ts\n')]);
    await expect(hasUnlandedChanges(io, WT, BRANCH, BASE)).resolves.toBe(true);
    expect(calls).toHaveLength(1); // merge-base never called once dirty is known
  });

  it('throws CrewError when git status itself fails to run', async () => {
    const { io } = runIo([fail()]);
    await expect(hasUnlandedChanges(io, WT, BRANCH, BASE)).rejects.toBeInstanceOf(CrewError);
  });

  it('throws CrewError when merge-base could not be spawned (null status)', async () => {
    const { io } = runIo([ok(''), nullStatus()]);
    await expect(hasUnlandedChanges(io, WT, BRANCH, BASE)).rejects.toBeInstanceOf(CrewError);
  });

  it('rejects an invalid branch/baseRef before any git call', async () => {
    const { io, calls } = runIo([]);
    await expect(hasUnlandedChanges(io, WT, '--evil', BASE)).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('removeTaskWorktree', () => {
  const WT = '/data/crew/worktrees/abc123/feature-x';
  const BRANCH = 'crew/task-x';

  it('removes the worktree then safe-deletes the branch, in order, both -C the repo root', async () => {
    const { io, calls } = runIo([ok(), ok()]);
    const result = await removeTaskWorktree(io, REPO_ROOT, WT, BRANCH);
    expect(result).toEqual({ branchDeleted: true, branchDeleteError: null });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual(['-C', REPO_ROOT, 'worktree', 'remove', WT]);
    expect(calls[1]!.args).toEqual(['-C', REPO_ROOT, 'branch', '-d', BRANCH]);
  });

  it('passes --force to `worktree remove` only when explicitly asked', async () => {
    const { io, calls } = runIo([ok(), ok()]);
    await removeTaskWorktree(io, REPO_ROOT, WT, BRANCH, { force: true });
    expect(calls[0]!.args).toEqual(['-C', REPO_ROOT, 'worktree', 'remove', '--force', WT]);
  });

  it('throws and never attempts the branch delete when `worktree remove` fails', async () => {
    const { io, calls } = runIo([fail()]);
    const error = await removeTaskWorktree(io, REPO_ROOT, WT, BRANCH).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrewError);
    expect((error as CrewError).message).toContain('fatal');
    expect(calls).toHaveLength(1); // branch -d never attempted
  });

  it('does NOT throw when the safe `branch -d` refuses an unmerged branch — the worktree is already gone, that is the primary result', async () => {
    const { io, calls } = runIo([ok(), fail()]);
    const result = await removeTaskWorktree(io, REPO_ROOT, WT, BRANCH);
    expect(result).toEqual({ branchDeleted: false, branchDeleteError: 'fatal' });
    expect(calls).toHaveLength(2); // worktree remove already ran
  });

  it('rejects an invalid branch before any git call', async () => {
    const { io, calls } = runIo([]);
    await expect(removeTaskWorktree(io, REPO_ROOT, WT, '--evil')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('deriveReviewWorktreePath', () => {
  const ENV = { XDG_DATA_HOME: '/data' };

  it('derives a deterministic, agent-keyed branch and a path in the same managed-base family', () => {
    const a = deriveReviewWorktreePath(ENV, 'inspector', REPO_ROOT);
    const b = deriveReviewWorktreePath(ENV, 'inspector', REPO_ROOT);
    expect(a).toEqual(b); // deterministic given the same inputs

    expect(a.branch).toBe('crew/review-696e73706563746f72');
    expect(() => assertValidBranch(a.branch, 'test')).not.toThrow();
    expect(a.path).toBe(deriveWorktreePath(ENV, REPO_ROOT, a.branch));
    expect(a.path.startsWith('/data/crew/worktrees/')).toBe(true);
  });

  it('keys distinct Agent ids to distinct branches/paths (one dedicated worktree per Agent)', () => {
    const a = deriveReviewWorktreePath(ENV, 'inspector', REPO_ROOT);
    const b = deriveReviewWorktreePath(ENV, 'inspector-2', REPO_ROOT);
    expect(a.branch).not.toBe(b.branch);
    expect(a.path).not.toBe(b.path);
  });

  it('encodes a valid Agent id that would otherwise produce an invalid branch', () => {
    const derived = deriveReviewWorktreePath(ENV, 'x.lock', REPO_ROOT);
    expect(derived.branch).toBe('crew/review-782e6c6f636b');
    expect(() => assertValidBranch(derived.branch, 'test')).not.toThrow();
  });
});

describe('resolveConcreteBaseRef', () => {
  it('uses a configured non-HEAD value as-is, with no git call', async () => {
    const { io, calls } = runIo([]);
    await expect(resolveConcreteBaseRef(io, REPO_ROOT, 'main')).resolves.toBe('main');
    expect(calls).toHaveLength(0);
  });

  it('resolves the literal "HEAD" via git rev-parse --abbrev-ref HEAD', async () => {
    const { io, calls } = runIo([ok('main\n')]);
    await expect(resolveConcreteBaseRef(io, REPO_ROOT, 'HEAD')).resolves.toBe('main');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['-C', REPO_ROOT, 'rev-parse', '--abbrev-ref', 'HEAD']);
    expect(calls[0]!.timeoutMs).toBe(10_000);
  });

  it('refuses to resolve HEAD to itself on a detached checkout, rather than persisting the literal "HEAD"', async () => {
    const { io } = runIo([ok('HEAD\n')]); // git's own detached-HEAD echo
    await expect(resolveConcreteBaseRef(io, REPO_ROOT, 'HEAD')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('throws CrewError with git stderr when the rev-parse fails', async () => {
    const { io } = runIo([fail()]);
    const error = await resolveConcreteBaseRef(io, REPO_ROOT, 'HEAD').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrewError);
    expect((error as CrewError).message).toContain('fatal');
  });

  it('rejects an option-injecting configured base ref before any git call', async () => {
    const { io, calls } = runIo([]);
    await expect(resolveConcreteBaseRef(io, REPO_ROOT, '--evil')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects a resolved branch name that turns out invalid', async () => {
    const { io } = runIo([ok('bad..name\n')]);
    await expect(resolveConcreteBaseRef(io, REPO_ROOT, 'HEAD')).rejects.toMatchObject({
      code: 'INVALID_CONFIG',
    });
  });
});
