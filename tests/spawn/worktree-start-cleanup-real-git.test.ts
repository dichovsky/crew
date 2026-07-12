/**
 * Real-git proof for issue #53's `task start` compensating-cleanup fix. Every
 * scripted-double test for this path (tests/integration/commands/tasks.test.ts)
 * asserts the exact argv crew SHOULD issue — it cannot catch a bug in what
 * real git actually refuses to do. This file spawns actual `git` processes
 * against a real temporary repository, with no double at all
 * (`nodeRunProcess`, the real Io.runProcess implementation), to prove: when a
 * `task start` transition fails after the fresh per-Task worktree was
 * created, the just-created worktree and its branch are ACTUALLY removed —
 * not merely reported as removed by a scripted double that never exercises
 * git's untracked-files refusal (crew itself writes an untracked
 * `.crew/state/workspace-pointer` file into the fresh worktree before the
 * transition is attempted; without `{ force: true }` real git refuses the
 * removal every time this path runs).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initWorkspace } from '../../src/init.js';
import type { Io } from '../../src/io.js';
import { nodeRunProcess } from '../../src/process.js';
import { run } from '../../src/run.js';
import { deriveTaskWorktreePath } from '../../src/worktree.js';
import { captureIo } from '../helpers/io.js';

const made: string[] = [];

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

/** A real, minimal git repository with one commit on `main`. */
function initRealRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-start-cleanup-real-'));
  made.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

async function joinAgents(io: Io, ...ids: string[]): Promise<void> {
  for (const id of ids) expect(await run(['join', id, '--json'], io)).toBe(0);
}

function records(output: readonly string[]): Array<Record<string, unknown>> {
  return output
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Extract the JSON error envelope from stderr. When the compensating cleanup
 * itself warns first (the unforced pre-fix behavior), that warning line
 * shares stderr with the JSON envelope — so pick the last line that parses,
 * rather than assuming the whole buffer is one JSON document.
 */
function errorCode(output: readonly string[]): string {
  const lines = output.join('').split('\n').filter(Boolean);
  const jsonLine = [...lines].reverse().find((line) => line.startsWith('{'));
  if (jsonLine === undefined) throw new Error(`no JSON error line in stderr: ${lines.join('\n')}`);
  const envelope = JSON.parse(jsonLine) as { error: { code: string } };
  return envelope.error.code;
}

describe('`task start` orphan-worktree cleanup against REAL git (issue #53 fix, not a scripted double)', () => {
  it('actually removes the just-created worktree and its branch when the start transition fails', async () => {
    const repo = initRealRepo();
    const dataHome = mkdtempSync(join(tmpdir(), 'crew-start-cleanup-real-data-'));
    made.push(dataHome);
    const { io, out, err } = captureIo({
      cwd: repo,
      env: { XDG_DATA_HOME: dataHome },
      runProcess: nodeRunProcess,
    });
    initWorkspace(io, { withGuides: false, json: false });
    out.length = 0;

    writeFileSync(
      join(repo, '.crew', 'config.yaml'),
      'version: 1\nworker_worktrees:\n  enabled: true\n  base_ref: main\n',
    );

    await joinAgents(io, 'manager', 'worker', 'inspector');
    out.length = 0;

    expect(
      await run(
        [
          'task',
          'create',
          'manager',
          'worker',
          '--reviewer',
          'inspector',
          '--title',
          'Add X',
          '--json',
        ],
        io,
      ),
    ).toBe(0);
    const taskId = records(out)[0]?.id as string;
    out.length = 0;

    const derived = deriveTaskWorktreePath(io.env, taskId, 'Add X', repo);
    expect(existsSync(derived.path)).toBe(false);

    // A non-assignee actor: the per-Task worktree is created BEFORE the
    // assignee check runs inside store.startTask, so this fails the Task
    // transition itself after real git has already created the worktree (and
    // crew has already written the untracked workspace-pointer file into it).
    err.length = 0;
    expect(await run(['task', 'start', 'eve', taskId, '--json'], io)).toBe(1);
    expect(errorCode(err)).toBe('TASK_CONFLICT');

    // Prove BOTH the worktree directory and its branch are actually gone from
    // real git's own bookkeeping — not merely reported gone by a scripted
    // double. `not.toContain` (substring, not exact equality) is deliberate:
    // git prints realpath-canonicalized paths (`/private/var/...` on macOS)
    // while `derived.path` keeps the raw `/var/...` tmpdir prefix, and the
    // canonicalized form still ends with the raw path as a substring — an
    // exact-match assertion would falsely pass on a leaked worktree.
    const worktreeList = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    });
    expect(worktreeList).not.toContain(derived.path);

    const branchList = execFileSync('git', ['-C', repo, 'branch', '--list', derived.branch], {
      encoding: 'utf8',
    });
    expect(branchList.trim()).toBe('');

    expect(existsSync(derived.path)).toBe(false);
  }, 30_000);
});
