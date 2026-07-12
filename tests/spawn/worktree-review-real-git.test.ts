/**
 * Real-git proof for the review-worktree fix. Every other worktree test
 * in this repo drives a SCRIPTED git subprocess double — which cannot catch a
 * bug in what real git actually refuses to do. This file spawns actual `git`
 * processes against a real temporary repository, with no double at all
 * (`nodeRunProcess`, the real Io.runProcess implementation), specifically to
 * prove: a Task's branch, already checked out in the assignee's own task
 * worktree, can still be reviewed via `checkoutRef`'s DETACHED checkout in
 * the reviewer's separate worktree — something a real, non-detached
 * `git checkout` of that same branch would refuse.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeRunProcess } from '../../src/process.js';
import { checkoutRef, resolveWorktree } from '../../src/worktree.js';
import { captureIo } from '../helpers/io.js';

const made: string[] = [];

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

/** A real, minimal git repository with one commit on `main`. */
function initRealRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-worktree-real-'));
  made.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

describe('review-worktree checkout against REAL git (not a scripted double)', () => {
  it("detached-checks-out a Task branch already held by the assignee's own worktree", async () => {
    const repo = initRealRepo();
    const base = mkdtempSync(join(tmpdir(), 'crew-worktree-real-base-'));
    made.push(base);
    const { io } = captureIo({ cwd: repo, env: {}, runProcess: nodeRunProcess });

    // The assignee's own task worktree: a real `git worktree add` on a new branch.
    const taskWorktreePath = join(base, 'task-1');
    const taskResolution = await resolveWorktree(io, {
      repoRoot: repo,
      targetPath: taskWorktreePath,
      managedBase: base,
      branch: 'crew/task-1-fix-login',
      baseRef: 'main',
    });
    expect(taskResolution.action).toBe('create');

    // Real progress on the Task branch, distinct from `main`'s tip — so the
    // reviewer's later detached checkout landing on THIS commit (not just
    // coincidentally on the shared starting commit) is actually load-bearing.
    execFileSync(
      'git',
      ['-C', taskWorktreePath, 'commit', '--allow-empty', '-q', '-m', 'wip: fix login'],
      {
        stdio: 'pipe',
      },
    );

    // The reviewer's own, separate worktree, on its own distinct branch.
    const reviewWorktreePath = join(base, 'review-inspector');
    await resolveWorktree(io, {
      repoRoot: repo,
      targetPath: reviewWorktreePath,
      managedBase: base,
      branch: 'crew/review-inspector',
      baseRef: 'main',
    });

    // Regression control FIRST: prove the underlying git constraint is real,
    // not assumed — a genuine, non-detached checkout of the Task's branch
    // from the reviewer's worktree must be refused by real git, since the
    // assignee's task worktree already holds that branch.
    expect(() =>
      execFileSync('git', ['-C', reviewWorktreePath, 'checkout', 'crew/task-1-fix-login'], {
        stdio: 'pipe',
      }),
    ).toThrow();

    // The actual fix: checkoutRef's DETACHED checkout succeeds regardless,
    // because it never claims the branch name.
    await expect(
      checkoutRef(io, reviewWorktreePath, 'crew/task-1-fix-login'),
    ).resolves.toBeUndefined();
    const detachedBranch = execFileSync(
      'git',
      ['-C', reviewWorktreePath, 'branch', '--show-current'],
      { encoding: 'utf8' },
    );
    expect(detachedBranch.trim()).toBe(''); // empty = detached HEAD, branch never claimed
    const detachedLog = execFileSync('git', ['-C', reviewWorktreePath, 'log', '-1', '--oneline'], {
      encoding: 'utf8',
    });
    // The Task branch's OWN commit, not merely the shared starting point —
    // load-bearing proof the checkout actually moved, not just resolved to
    // wherever it already happened to be.
    expect(detachedLog).toContain('wip: fix login');

    // Restoring to base_ref ('main') also succeeds via checkoutRef, even
    // though the repo's OWN primary checkout is also on 'main' right now —
    // a second real-git constraint this same detached-checkout fix resolves.
    await expect(checkoutRef(io, reviewWorktreePath, 'main')).resolves.toBeUndefined();

    // The assignee's task worktree is completely undisturbed throughout.
    const taskBranch = execFileSync('git', ['-C', taskWorktreePath, 'branch', '--show-current'], {
      encoding: 'utf8',
    });
    expect(taskBranch.trim()).toBe('crew/task-1-fix-login');
  });
});
