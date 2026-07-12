import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../../src/init.js';
import { run } from '../../../src/run.js';
import { Store } from '../../../src/store/index.js';
import { deriveReviewWorktreePath, deriveTaskWorktreePath } from '../../../src/worktree.js';
import { captureIo, recordingRunProcess } from '../../helpers/io.js';
import type { ProcessScriptEntry } from '../../helpers/io.js';
import type { Io, ProcessResult } from '../../../src/io.js';

const made: string[] = [];

function workspace(clock: () => number = () => 0) {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-task-command-'));
  made.push(cwd);
  const capture = captureIo({ cwd, clock });
  initWorkspace(capture.io, { withGuides: false, json: false });
  capture.out.length = 0;
  return { cwd, ...capture };
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

function errorCode(output: readonly string[]): string {
  const envelope = JSON.parse(output.join('')) as { error: { code: string } };
  return envelope.error.code;
}

/** Create a Task and return its id from the JSON record. */
async function createTask(io: Io, out: string[]): Promise<string> {
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
  const id = records(out)[0]?.id as string;
  out.length = 0;
  return id;
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('Task command lifecycle', () => {
  it('creates a queued Task and emits the stable Task NDJSON contract', async () => {
    const { io, out, err } = workspace(() => 1_000);
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
          '--body',
          'do it',
          '--json',
        ],
        io,
      ),
    ).toBe(0);
    expect(err).toEqual([]);
    const task = records(out)[0]!;
    expect(task).toMatchObject({
      type: 'task',
      schema_version: 1,
      title: 'Add X',
      body: 'do it',
      creator_id: 'manager',
      assignee_id: 'worker',
      reviewer_id: 'inspector',
      status: 'queued',
      revision: 0,
      lease_owner_id: null,
      lease_expires_at: null,
      submission_summary: null,
      submitted_at: null,
      review_summary: null,
      completed_at: null,
      created_at: 1_000,
      updated_at: 1_000,
      stale_lease: false,
    });
    expect(typeof task.id).toBe('string');
  });

  it('drives create -> start -> submit -> approve to completed revision 3', async () => {
    let now = 0;
    const { io, out } = workspace(() => now);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);

    now = 10;
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);
    expect(records(out)[0]).toMatchObject({
      status: 'in_progress',
      revision: 1,
      lease_owner_id: 'worker',
      lease_expires_at: 10 + 900,
    });
    out.length = 0;

    now = 20;
    expect(
      await run(['task', 'submit', 'worker', id, '--summary', 'Implemented X', '--json'], io),
    ).toBe(0);
    expect(records(out)[0]).toMatchObject({
      status: 'submitted',
      revision: 2,
      submission_summary: 'Implemented X',
      lease_owner_id: null,
    });
    out.length = 0;

    now = 30;
    expect(await run(['task', 'approve', 'inspector', id, '--summary', 'LGTM', '--json'], io)).toBe(
      0,
    );
    expect(records(out)[0]).toMatchObject({
      status: 'completed',
      revision: 3,
      review_summary: 'LGTM',
      completed_at: 30,
    });
  });

  it('emits one Task record then ordered Task Event records under show --events', async () => {
    const { io, out } = workspace(() => 0);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);
    out.length = 0;

    expect(await run(['task', 'show', id, '--events', '--json'], io)).toBe(0);
    const lines = records(out);
    expect(lines[0]?.type).toBe('task');
    expect(lines.slice(1).map((r) => r.type)).toEqual(['task_event', 'task_event']);
    expect(lines.slice(1).map((r) => r.event_type)).toEqual(['created', 'started']);
    expect((lines[1] as { revision: number }).revision).toBe(0);
    expect((lines[2] as { revision: number }).revision).toBe(1);
  });

  it('filters list by assignee/status/stale-lease and prints the empty contract', async () => {
    let now = 0;
    const { io, out } = workspace(() => now);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    // worker-2's default Role would be "worker-2", so give it the worker Role.
    expect(await run(['join', 'worker-2', '--role', 'worker', '--json'], io)).toBe(0);
    const first = await createTask(io, out);
    expect(
      await run(
        [
          'task',
          'create',
          'manager',
          'worker-2',
          '--reviewer',
          'inspector',
          '--title',
          'Second',
          '--json',
        ],
        io,
      ),
    ).toBe(0);
    out.length = 0;
    expect(await run(['task', 'start', 'worker', first, '--json'], io)).toBe(0);
    out.length = 0;

    now = 1_000; // first Task's Lease (expires 900) is stale
    expect(await run(['task', 'list', '--stale-lease', '--json'], io)).toBe(0);
    expect(records(out).map((r) => r.id)).toEqual([first]);
    expect(records(out)[0]?.stale_lease).toBe(true);
    out.length = 0;

    expect(await run(['task', 'list', '--assignee', 'worker-2', '--json'], io)).toBe(0);
    expect(records(out)).toHaveLength(1);
    out.length = 0;

    // Empty query: no JSON lines, exit 0.
    expect(await run(['task', 'list', '--status', 'completed', '--json'], io)).toBe(0);
    expect(out.join('')).toBe('');
  });

  it('renders human mutation and show output without JSON', async () => {
    const { io, out } = workspace(() => 0);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    out.length = 0;
    expect(
      await run(
        ['task', 'create', 'manager', 'worker', '--reviewer', 'inspector', '--title', 'Add X'],
        io,
      ),
    ).toBe(0);
    expect(out.join('')).toMatch(/^Task .+ -> queued \(revision 0\)\n$/);
    const id = out.join('').trim().split(' ')[1]!;
    out.length = 0;

    expect(await run(['task', 'show', id], io)).toBe(0);
    const shown = out.join('');
    expect(shown).toContain('Status  queued (revision 0)');
    expect(shown).toContain('Roles   creator=manager assignee=worker reviewer=inspector');
    expect(shown).toContain('Lease   none');
  });
});

describe('Task command errors', () => {
  it('maps domain and usage failures to the documented codes and exit statuses', async () => {
    const { io, out, err } = workspace(() => 0);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);

    // Wrong actor: only the assignee may start.
    err.length = 0;
    expect(await run(['task', 'start', 'inspector', id, '--json'], io)).toBe(1);
    expect(errorCode(err)).toBe('TASK_CONFLICT');

    // Malformed task id is a usage error (exit 2).
    err.length = 0;
    expect(await run(['task', 'show', 'not-a-uuid', '--json'], io)).toBe(2);
    expect(errorCode(err)).toBe('USAGE');

    // Well-formed but absent id is NOT_FOUND (exit 1).
    err.length = 0;
    expect(await run(['task', 'show', '11111111-1111-4111-8111-111111111111', '--json'], io)).toBe(
      1,
    );
    expect(errorCode(err)).toBe('NOT_FOUND');

    // Archived participant blocks a transition.
    err.length = 0;
    expect(await run(['leave', 'inspector', '--json'], io)).toBe(0);
    err.length = 0;
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(1);
    expect(errorCode(err)).toBe('AGENT_INACTIVE');
  });

  it('rejects missing required options as usage errors', async () => {
    const { io } = workspace(() => 0);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    // Missing --reviewer and --title.
    expect(await run(['task', 'create', 'manager', 'worker', '--json'], io)).toBe(2);
    // Missing --summary on submit.
    expect(
      await run(['task', 'submit', 'worker', '11111111-1111-4111-8111-111111111111', '--json'], io),
    ).toBe(2);
    // Invalid --status choice.
    expect(await run(['task', 'list', '--status', 'bogus', '--json'], io)).toBe(2);
  });
});

describe('Task requeue command and human surfaces', () => {
  it('requeues a Submission, reassigns with --to, and prints the new status/revision', async () => {
    const { io, out } = workspace(() => 0);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    expect(await run(['join', 'worker-2', '--role', 'worker', '--json'], io)).toBe(0);
    const id = await createTask(io, out);
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);
    expect(await run(['task', 'submit', 'worker', id, '--summary', 'v1', '--json'], io)).toBe(0);
    out.length = 0;

    // Human requeue with --to reassigns and reports the new state.
    expect(
      await run(['task', 'requeue', 'inspector', id, '--reason', 'redo', '--to', 'worker-2'], io),
    ).toBe(0);
    expect(out.join('')).toMatch(/^Task .+ -> queued \(revision 3\)\n$/);
    out.length = 0;

    expect(await run(['task', 'show', id, '--json'], io)).toBe(0);
    expect(records(out)[0]).toMatchObject({
      status: 'queued',
      revision: 3,
      assignee_id: 'worker-2',
    });
  });

  it('renders the human Lease, Body, Submission, and Review blocks across the lifecycle', async () => {
    const now = 0;
    const { io, out } = workspace(() => now);
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
          '--body',
          'context',
        ],
        io,
      ),
    ).toBe(0);
    const id = out.join('').trim().split(' ')[1]!;
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);
    out.length = 0;

    // in_progress: Lease line is rendered with owner and expiry.
    expect(await run(['task', 'show', id], io)).toBe(0);
    const inProgress = out.join('');
    expect(inProgress).toContain('Status  in_progress (revision 1)');
    expect(inProgress).toMatch(/Lease {3}worker until /);
    expect(inProgress).toContain('Body');
    expect(inProgress).toContain('  context');
    out.length = 0;

    expect(
      await run(['task', 'submit', 'worker', id, '--summary', 'did the work', '--json'], io),
    ).toBe(0);
    expect(
      await run(['task', 'approve', 'inspector', id, '--summary', 'approved!', '--json'], io),
    ).toBe(0);
    out.length = 0;

    expect(await run(['task', 'show', id, '--events'], io)).toBe(0);
    const completed = out.join('');
    expect(completed).toContain('Submission');
    expect(completed).toContain('  did the work');
    expect(completed).toContain('Review');
    expect(completed).toContain('  approved!');
    expect(completed).toContain('Events');
    expect(completed).toMatch(/#0 created by manager/);
    expect(completed).toMatch(/#3 approved by inspector/);
  });

  it('renders a human task list table and a stale-lease marker', async () => {
    let now = 0;
    const { io, out } = workspace(() => now);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);
    out.length = 0;

    // Empty filter result prints the human empty contract.
    expect(await run(['task', 'list', '--status', 'completed'], io)).toBe(0);
    expect(out.join('')).toBe('No tasks.\n');
    out.length = 0;

    now = 1_000; // the Lease (expires 900) is now stale
    expect(await run(['task', 'list'], io)).toBe(0);
    const table = out.join('');
    expect(table).toMatch(/^ID\s+STATUS\s+REV\s+ASSIGNEE\s+REVIEWER\s+TITLE/);
    expect(table).toContain('in_progress (stale)');
    expect(table).toContain('Add X');
  });
});

describe('Task abandon command', () => {
  it('abandons a queued Task and prints the new status/revision', async () => {
    const { io, out, err } = workspace(() => 0);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    out.length = 0;

    expect(await run(['task', 'abandon', 'manager', id, '--reason', 'dead work'], io)).toBe(0);
    expect(out.join('')).toMatch(/^Task .+ -> abandoned \(revision 1\)\n$/);
    out.length = 0;

    expect(await run(['task', 'show', id, '--json'], io)).toBe(0);
    expect(records(out)[0]).toMatchObject({ status: 'abandoned', revision: 1 });
    expect(records(out)[0]?.abandoned_at).not.toBeNull();

    // The abandoned Task Event's reason is visible via --events.
    out.length = 0;
    expect(await run(['task', 'show', id, '--events'], io)).toBe(0);
    expect(out.join('')).toMatch(/#1 abandoned by manager/);

    err.length = 0;
  });

  it('accepts an omitted --reason (unlike requeue, a reason is optional)', async () => {
    const { io, out } = workspace(() => 0);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    out.length = 0;

    expect(await run(['task', 'abandon', 'manager', id, '--json'], io)).toBe(0);
    expect(records(out)[0]).toMatchObject({ status: 'abandoned' });
  });

  it('rejects a non-creator/reviewer actor with TASK_CONFLICT', async () => {
    const { io, out, err } = workspace(() => 0);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    out.length = 0;

    err.length = 0;
    expect(await run(['task', 'abandon', 'worker', id, '--json'], io)).toBe(1);
    expect(errorCode(err)).toBe('TASK_CONFLICT');
  });

  it('rejects a completed Task with TASK_CONFLICT and filters it via --status abandoned', async () => {
    const { io, out, err } = workspace(() => 0);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);
    expect(await run(['task', 'submit', 'worker', id, '--summary', 'v1', '--json'], io)).toBe(0);
    expect(await run(['task', 'approve', 'inspector', id, '--summary', 'ok', '--json'], io)).toBe(
      0,
    );
    out.length = 0;

    err.length = 0;
    expect(await run(['task', 'abandon', 'manager', id, '--json'], io)).toBe(1);
    expect(errorCode(err)).toBe('TASK_CONFLICT');

    // A second, genuinely abandoned Task shows up under the --status filter
    // registered in the CLI choices() list; the completed one does not.
    const id2 = await createTask(io, out);
    out.length = 0;
    expect(await run(['task', 'abandon', 'manager', id2, '--json'], io)).toBe(0);
    out.length = 0;
    expect(await run(['task', 'list', '--status', 'abandoned', '--json'], io)).toBe(0);
    const listed = records(out);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: id2, status: 'abandoned' });
  });

  it('clears an active worktree and removes it on disk when abandoning', async () => {
    const { io, out, cwd, script } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await submittedTaskWithWorktree(io, out, cwd, script);

    script.push(ok(''), ok('')); // worktree remove, then branch -d
    out.length = 0;
    expect(await run(['task', 'abandon', 'manager', id, '--json'], io)).toBe(0);
    expect(records(out)[0]).toMatchObject({
      status: 'abandoned',
      worktree_path: null,
      worktree_branch: null,
      worktree_base_ref: null,
    });
  });

  it('still abandons the Task and warns (not fails) when worktree removal fails on disk', async () => {
    const { io, out, err, cwd, script } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await submittedTaskWithWorktree(io, out, cwd, script);

    script.push(fail('worktree is locked')); // worktree remove fails; branch -d never attempted
    out.length = 0;
    err.length = 0;
    expect(await run(['task', 'abandon', 'manager', id, '--json'], io)).toBe(0);
    expect(records(out)[0]).toMatchObject({ status: 'abandoned' });
    expect(err.join('')).toMatch(/Warning: could not remove worktree/);
  });

  it('still abandons the Task and warns (not fails) when the worktree is removed but its unmerged branch cannot be deleted', async () => {
    const { io, out, err, cwd, script } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await submittedTaskWithWorktree(io, out, cwd, script);

    script.push(ok(''), fail('branch not fully merged')); // worktree remove succeeds, branch -d refuses
    out.length = 0;
    err.length = 0;
    expect(await run(['task', 'abandon', 'manager', id, '--json'], io)).toBe(0);
    expect(records(out)[0]).toMatchObject({
      status: 'abandoned',
      worktree_path: null,
      worktree_branch: null,
      worktree_base_ref: null,
    });
    expect(err.join('')).toContain('Warning');
    expect(err.join('')).toContain('branch not fully merged');
    expect(err.join('')).toContain('git branch -D');
  });
});

describe('Task review-fix coverage', () => {
  it('renders Event detail (Submission and requeue reason) on the human show --events surface', async () => {
    const { io, out } = workspace(() => 0);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);
    expect(
      await run(['task', 'submit', 'worker', id, '--summary', 'submission evidence', '--json'], io),
    ).toBe(0);
    // A multiline requeue reason renders each continuation line indented.
    expect(
      await run(
        ['task', 'requeue', 'inspector', id, '--reason', 'line one\nline two', '--json'],
        io,
      ),
    ).toBe(0);
    out.length = 0;

    expect(await run(['task', 'show', id, '--events'], io)).toBe(0);
    const shown = out.join('');
    expect(shown).toContain('submission evidence'); // prior Submission detail still auditable
    expect(shown).toContain('line one');
    expect(shown).toContain('line two'); // continuation line of the multiline reason
  });

  it('rejects --stale-lease combined with a conflicting --status as USAGE', async () => {
    const { io, err } = workspace(() => 0);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    err.length = 0;
    expect(
      await run(['task', 'list', '--stale-lease', '--status', 'submitted', '--json'], io),
    ).toBe(2);
    expect(errorCode(err)).toBe('USAGE');
    // --stale-lease with the matching --status in_progress is allowed.
    expect(
      await run(['task', 'list', '--stale-lease', '--status', 'in_progress', '--json'], io),
    ).toBe(0);
  });

  it('rejects task list filters naming a non-existent Agent with NOT_FOUND', async () => {
    const { io, err } = workspace(() => 0);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    err.length = 0;
    expect(await run(['task', 'list', '--reviewer', 'ghost', '--json'], io)).toBe(1);
    expect(errorCode(err)).toBe('NOT_FOUND');
    err.length = 0;
    expect(await run(['task', 'list', '--assignee', 'ghost', '--json'], io)).toBe(1);
    expect(errorCode(err)).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Per-Worker Task worktrees, review worktrees, and `task land`.
// ---------------------------------------------------------------------------

function ok(stdout = ''): ProcessResult {
  return { status: 0, stdout, stderr: '' };
}
function fail(stderr = 'fatal'): ProcessResult {
  return { status: 128, stdout: '', stderr };
}

/** A Workspace with `worker_worktrees` enabled (or not) via `.crew/config.yaml`, and a scriptable git double. */
function worktreeWorkspace(options: { enabled?: boolean; clock?: () => number } = {}) {
  const { enabled = true, clock = () => 0 } = options;
  const cwd = mkdtempSync(join(tmpdir(), 'crew-task-wt-'));
  const dataHome = mkdtempSync(join(tmpdir(), 'crew-task-wt-data-'));
  made.push(cwd, dataHome);
  const script: ProcessScriptEntry[] = [];
  const rec = recordingRunProcess(script);
  const capture = captureIo({
    cwd,
    clock,
    env: { XDG_DATA_HOME: dataHome },
    runProcess: rec.runProcess,
  });
  initWorkspace(capture.io, { withGuides: false, json: false });
  if (enabled) {
    writeFileSync(
      join(cwd, '.crew', 'config.yaml'),
      'version: 1\nworker_worktrees:\n  enabled: true\n  base_ref: main\n',
    );
  }
  capture.out.length = 0;
  return { cwd, dataHome, script, calls: rec.calls, ...capture };
}

/** Append `resolveWorktree`'s "create a new branch" 4-call sequence to `script`. */
function scriptCreateWorktree(script: ProcessScriptEntry[], repoRoot: string): void {
  script.push(
    ok(`${repoRoot}\n`), // rev-parse --show-toplevel
    fail(), // rev-parse --verify --quiet refs/heads/<branch> (branch absent)
    ok(`worktree ${repoRoot}\nHEAD abc123\nbranch refs/heads/main\n\n`), // worktree list (target absent)
    ok(''), // worktree add -b <branch> <target> <baseRef>
  );
}

/** Create, start (with a scripted worktree), and submit a Task; returns its id. */
async function submittedTaskWithWorktree(
  io: Io,
  out: string[],
  cwd: string,
  script: ProcessScriptEntry[],
): Promise<string> {
  const id = await createTask(io, out);
  // `task start` writes the workspace-pointer file into the new worktree, which
  // requires the worktree directory to already exist — real `git worktree add`
  // would have created it; the mocked git double here does not, so simulate it.
  mkdirSync(deriveTaskWorktreePath(io.env, id, 'Add X', cwd).path, { recursive: true });
  scriptCreateWorktree(script, cwd);
  expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);
  out.length = 0;
  expect(await run(['task', 'submit', 'worker', id, '--summary', 'done', '--json'], io)).toBe(0);
  out.length = 0;
  return id;
}

/** A completed Task with a worktree, approved by a reviewer who never called `task review`. */
async function completedTaskWithWorktree(
  io: Io,
  out: string[],
  cwd: string,
  script: ProcessScriptEntry[],
): Promise<string> {
  const id = await submittedTaskWithWorktree(io, out, cwd, script);
  expect(await run(['task', 'approve', 'inspector', id, '--json'], io)).toBe(0);
  out.length = 0;
  return id;
}

describe('Task start with per-Worker worktrees', () => {
  it('is byte-identical to today when worker_worktrees is not enabled (no config.yaml, no git I/O)', async () => {
    const { io, out, calls } = worktreeWorkspace({ enabled: false });
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    out.length = 0;
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);
    expect(records(out)[0]).toMatchObject({
      status: 'in_progress',
      worktree_path: null,
      worktree_branch: null,
      worktree_base_ref: null,
    });
    expect(calls).toHaveLength(0);
  });

  it('creates the assignee worktree, records it on the Task, writes the pointer file, and prints the path', async () => {
    const { io, out, cwd, script, calls } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    out.length = 0;

    const derived = deriveTaskWorktreePath(io.env, id, 'Add X', cwd);
    // Simulate `git worktree add` having created the directory (mocked here).
    mkdirSync(derived.path, { recursive: true });
    scriptCreateWorktree(script, cwd);
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);

    expect(records(out)[0]).toMatchObject({
      status: 'in_progress',
      worktree_path: derived.path,
      worktree_branch: derived.branch,
      worktree_base_ref: 'main',
    });
    expect(calls).toHaveLength(4);

    // The pointer file redirects the new worktree's local .crew/state back to
    // the shared Workspace root, so a command run from inside it finds the
    // same State Store instead of a disconnected local one.
    const pointer = readFileSync(join(derived.path, '.crew', 'state', 'workspace-pointer'), 'utf8');
    expect(pointer.trim()).toBe(cwd);
  });

  it('prints an extra Worktree line in human mode', async () => {
    const { io, out, cwd, script } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    out.length = 0;
    mkdirSync(deriveTaskWorktreePath(io.env, id, 'Add X', cwd).path, { recursive: true });
    scriptCreateWorktree(script, cwd);
    expect(await run(['task', 'start', 'worker', id], io)).toBe(0);
    const lines = out.join('').trim().split('\n');
    expect(lines[0]).toMatch(/^Task .+ -> in_progress \(revision 1\)$/);
    expect(lines[1]).toMatch(/^Worktree /);
  });

  it('surfaces NOT_FOUND for a non-existent task id with worktrees enabled, before any git call', async () => {
    const { io, err, calls } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    err.length = 0;
    expect(
      await run(['task', 'start', 'worker', '11111111-1111-4111-8111-111111111111', '--json'], io),
    ).toBe(1);
    expect(errorCode(err)).toBe('NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('reuses the existing worktree and its ORIGINAL base_ref on restart after requeue, without re-resolving', async () => {
    const { io, out, cwd, script, calls } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await submittedTaskWithWorktree(io, out, cwd, script);

    expect(
      await run(['task', 'requeue', 'inspector', id, '--reason', 'needs more work', '--json'], io),
    ).toBe(0);
    out.length = 0;
    calls.length = 0;

    // Restart: resolveWorktree must hit its REUSE path (rev-parse --show-toplevel,
    // rev-parse --verify [branch exists], worktree list [target already present])
    // — no `worktree add`, and worktree_base_ref is reused as-is, never
    // re-resolved via a second `rev-parse --abbrev-ref HEAD`.
    const derived = deriveTaskWorktreePath(io.env, id, 'Add X', cwd);
    script.push(
      ok(`${cwd}\n`),
      ok(`refs/heads/${derived.branch}\n`),
      ok(
        `worktree ${cwd}\nHEAD abc123\nbranch refs/heads/main\n\n` +
          `worktree ${derived.path}\nHEAD def456\nbranch refs/heads/${derived.branch}\n\n`,
      ),
    );
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);
    expect(records(out)[0]).toMatchObject({
      status: 'in_progress',
      worktree_path: derived.path,
      worktree_branch: derived.branch,
      worktree_base_ref: 'main', // unchanged from the original start
    });
    expect(calls).toHaveLength(3); // no `worktree add`
    expect(calls.some((c) => c.args.includes('--abbrev-ref'))).toBe(false);
  });

  it('preserves an existing worktree triple when the feature is disabled before a queued restart (FR-W01)', async () => {
    const { io, out, cwd, script, calls } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await submittedTaskWithWorktree(io, out, cwd, script);
    expect(
      await run(['task', 'requeue', 'inspector', id, '--reason', 'needs more work', '--json'], io),
    ).toBe(0);
    writeFileSync(
      join(cwd, '.crew', 'config.yaml'),
      'version: 1\nworker_worktrees:\n  enabled: false\n',
    );
    calls.length = 0;
    out.length = 0;

    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);
    const task = records(out)[0]!;
    expect(task).toMatchObject({
      worktree_path: deriveTaskWorktreePath(io.env, id, 'Add X', cwd).path,
      worktree_branch: deriveTaskWorktreePath(io.env, id, 'Add X', cwd).branch,
      worktree_base_ref: 'main',
    });
    expect(calls).toHaveLength(0);
  });

  it('removes an orphaned worktree it just created when the Task transition itself fails', async () => {
    const { io, out, err, cwd, script, calls } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    out.length = 0;

    // The Task is abandoned before the Worker's `start` lands — a stand-in for
    // losing a race against a concurrent transition: the worktree gets created
    // on disk first, then store.startTask's own CAS fails regardless.
    expect(await run(['task', 'abandon', 'manager', id, '--json'], io)).toBe(0);
    out.length = 0;

    const derived = deriveTaskWorktreePath(io.env, id, 'Add X', cwd);
    mkdirSync(derived.path, { recursive: true });
    scriptCreateWorktree(script, cwd);
    script.push(ok(''), ok('')); // compensating removeTaskWorktree: worktree remove, branch -d

    err.length = 0;
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(1);
    // The ORIGINAL failure still surfaces to the caller, not a cleanup-related one.
    expect(errorCode(err)).toBe('TASK_CONFLICT');
    expect(calls).toHaveLength(6); // 4 create + 2 compensating cleanup
    expect(calls[4]!.args).toEqual(['-C', cwd, 'worktree', 'remove', '--force', derived.path]);
    expect(calls[5]!.args).toEqual(['-C', cwd, 'branch', '-d', derived.branch]);
  });

  it('warns on stderr (but still surfaces the ORIGINAL error) when the compensating cleanup itself fails', async () => {
    const { io, out, err, cwd, script } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    out.length = 0;

    expect(await run(['task', 'abandon', 'manager', id], io)).toBe(0);
    out.length = 0;

    const derived = deriveTaskWorktreePath(io.env, id, 'Add X', cwd);
    mkdirSync(derived.path, { recursive: true });
    scriptCreateWorktree(script, cwd);
    script.push(fail('worktree is locked')); // compensating removeTaskWorktree ALSO fails

    err.length = 0;
    expect(await run(['task', 'start', 'worker', id], io)).toBe(1);
    // The ORIGINAL failure (task already abandoned) still surfaces, not a
    // cleanup-related one — but a breadcrumb about the orphan is left too.
    expect(err.join('')).toContain('[TASK_CONFLICT]');
    expect(err.join('')).toContain('Warning: could not remove orphaned worktree');
    expect(err.join('')).toContain('worktree is locked');
  });

  it('does NOT remove a REUSED (pre-existing) worktree when the Task transition fails', async () => {
    const { io, out, err, cwd, script, calls } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await submittedTaskWithWorktree(io, out, cwd, script);
    expect(
      await run(['task', 'requeue', 'inspector', id, '--reason', 'rework', '--json'], io),
    ).toBe(0);
    out.length = 0;

    // A second, non-assignee agent tries to start the same (reused-worktree)
    // Task — store.startTask rejects it (wrong assignee) AFTER the worktree
    // was reused, but a reused worktree must never be deleted: it may hold
    // real, in-progress work that predates this call.
    calls.length = 0;
    const derived = deriveTaskWorktreePath(io.env, id, 'Add X', cwd);
    script.push(
      ok(`${cwd}\n`),
      ok(`refs/heads/${derived.branch}\n`),
      ok(
        `worktree ${cwd}\nHEAD abc123\nbranch refs/heads/main\n\n` +
          `worktree ${derived.path}\nHEAD def456\nbranch refs/heads/${derived.branch}\n\n`,
      ),
    );
    err.length = 0;
    expect(await run(['task', 'start', 'inspector', id, '--json'], io)).toBe(1);
    expect(errorCode(err)).toBe('TASK_CONFLICT');
    expect(calls).toHaveLength(3); // reuse sequence only — no removeTaskWorktree call
  });
});

describe('Task show renders worktree info when present', () => {
  it('adds a Worktree line and non-null JSON fields when the Task has a worktree', async () => {
    const { io, out, cwd, script } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    out.length = 0;
    mkdirSync(deriveTaskWorktreePath(io.env, id, 'Add X', cwd).path, { recursive: true });
    scriptCreateWorktree(script, cwd);
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);
    out.length = 0;

    expect(await run(['task', 'show', id], io)).toBe(0);
    expect(out.join('')).toMatch(/^Worktree /m);
    out.length = 0;

    expect(await run(['task', 'show', id, '--json'], io)).toBe(0);
    const record = records(out)[0]!;
    expect(record.worktree_path).not.toBeNull();
    expect(record.worktree_branch).not.toBeNull();
    expect(record.worktree_base_ref).toBe('main');
  });

  it('omits the Worktree line and keeps null JSON fields when the Task has no worktree', async () => {
    const { io, out } = workspace(() => 0);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);
    out.length = 0;

    expect(await run(['task', 'show', id], io)).toBe(0);
    expect(out.join('')).not.toMatch(/Worktree/);
    out.length = 0;

    expect(await run(['task', 'show', id, '--json'], io)).toBe(0);
    expect(records(out)[0]).toMatchObject({
      worktree_path: null,
      worktree_branch: null,
      worktree_base_ref: null,
    });
  });
});

describe('Task review', () => {
  it('creates a Git-safe review worktree for a valid reviewer id containing .lock (FR-W07)', async () => {
    const { io, out, cwd, script } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker');
    expect(await run(['join', 'x.lock', '--role', 'inspector', '--json'], io)).toBe(0);
    out.length = 0;
    expect(
      await run(
        [
          'task',
          'create',
          'manager',
          'worker',
          '--reviewer',
          'x.lock',
          '--title',
          'Add X',
          '--json',
        ],
        io,
      ),
    ).toBe(0);
    const id = records(out)[0]?.id as string;
    out.length = 0;
    const taskWorktree = deriveTaskWorktreePath(io.env, id, 'Add X', cwd);
    mkdirSync(taskWorktree.path, { recursive: true });
    scriptCreateWorktree(script, cwd);
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);
    expect(await run(['task', 'submit', 'worker', id, '--summary', 'done', '--json'], io)).toBe(0);

    const reviewWorktree = deriveReviewWorktreePath(io.env, 'x.lock', cwd);
    mkdirSync(reviewWorktree.path, { recursive: true });
    scriptCreateWorktree(script, cwd);
    script.push(ok(''));
    out.length = 0;
    expect(await run(['task', 'review', 'x.lock', id, '--json'], io)).toBe(0);
    expect(records(out)[0]).toMatchObject({
      path: reviewWorktree.path,
      branch: taskWorktree.branch,
    });
  });

  it('rejects a non-reviewer agent with TASK_CONFLICT', async () => {
    const { io, out, err, cwd, script } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await submittedTaskWithWorktree(io, out, cwd, script);
    err.length = 0;
    expect(await run(['task', 'review', 'worker', id, '--json'], io)).toBe(1);
    expect(errorCode(err)).toBe('TASK_CONFLICT');
  });

  it('rejects a non-submitted Task with TASK_CONFLICT', async () => {
    const { io, out, err } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out); // still queued
    err.length = 0;
    expect(await run(['task', 'review', 'inspector', id, '--json'], io)).toBe(1);
    expect(errorCode(err)).toBe('TASK_CONFLICT');
  });

  it('rejects a submitted Task with no worktree', async () => {
    const { io, out, err } = workspace(() => 0);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);
    expect(await run(['task', 'submit', 'worker', id, '--summary', 'v1', '--json'], io)).toBe(0);
    err.length = 0;
    expect(await run(['task', 'review', 'inspector', id, '--json'], io)).toBe(1);
    expect(errorCode(err)).toBe('TASK_CONFLICT');
  });

  it('lazily creates the reviewer worktree on first use, then reuses (re-checking-out) it on later reviews', async () => {
    const { io, out, cwd, script, calls } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id1 = await submittedTaskWithWorktree(io, out, cwd, script);
    const id2 = await submittedTaskWithWorktree(io, out, cwd, script);

    // `git worktree add` would have created this; the mocked git double here does not.
    mkdirSync(deriveReviewWorktreePath(io.env, 'inspector', cwd).path, { recursive: true });
    scriptCreateWorktree(script, cwd); // reviewer's own worktree: lazy create
    script.push(ok('')); // checkoutRef to task1's branch
    const beforeFirst = calls.length;
    expect(await run(['task', 'review', 'inspector', id1, '--json'], io)).toBe(0);
    expect(calls.length - beforeFirst).toBe(5);
    const first = records(out)[0]!;
    out.length = 0;

    script.push(ok('')); // checkoutRef to task2's branch (reuse: no create calls)
    const beforeSecond = calls.length;
    expect(await run(['task', 'review', 'inspector', id2, '--json'], io)).toBe(0);
    expect(calls.length - beforeSecond).toBe(1);
    const second = records(out)[0]!;

    expect(second.path).toBe(first.path); // one dedicated worktree, reused
    expect(second.branch).not.toBe(first.branch); // moved onto task2's branch
    expect(calls.at(-1)?.args).toContain('checkout');
  });

  it('rejects with TASK_CONFLICT when the review worktree row changed concurrently underneath it', async () => {
    const { io, out, err, cwd, script, calls } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await submittedTaskWithWorktree(io, out, cwd, script);
    mkdirSync(deriveReviewWorktreePath(io.env, 'inspector', cwd).path, { recursive: true });
    scriptCreateWorktree(script, cwd);

    // The checkoutRef call's response ALSO simulates a genuinely concurrent
    // actor (another process, another `task review`/restore for the same
    // reviewer) committing a DIFFERENT current_ref between this call's read
    // and its own write — the exact race the CAS predicate exists to catch.
    const dbPath = join(cwd, '.crew', 'state', 'crew.db');
    script.push(() => {
      const racer = new Store(dbPath, { clock: () => 0 });
      racer.setReviewWorktreeCurrentRef({
        agentId: 'inspector',
        currentRef: 'crew/some-other-branch',
        expectedCurrentRef: null,
      });
      racer.close();
      return { status: 0, stdout: '', stderr: '' };
    });
    script.push(ok('')); // best-effort restore to the row the racer just wrote

    err.length = 0;
    expect(await run(['task', 'review', 'inspector', id, '--json'], io)).toBe(1);
    expect(errorCode(err)).toBe('TASK_CONFLICT');
    expect(calls.at(-1)?.args).toEqual([
      '-C',
      deriveReviewWorktreePath(io.env, 'inspector', cwd).path,
      'checkout',
      '--detach',
      'crew/some-other-branch',
    ]);
  });

  it('prints the review worktree path in human mode', async () => {
    const { io, out, cwd, script } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await submittedTaskWithWorktree(io, out, cwd, script);
    mkdirSync(deriveReviewWorktreePath(io.env, 'inspector', cwd).path, { recursive: true });
    scriptCreateWorktree(script, cwd);
    script.push(ok(''));
    expect(await run(['task', 'review', 'inspector', id], io)).toBe(0);
    const printed = out.join('').trim();
    expect(printed.length).toBeGreaterThan(0);
    expect(printed).not.toContain('{');
  });
});

describe('Task approve/requeue best-effort review-worktree restore', () => {
  it('approve restores the reviewer worktree to its base ref when it sits on the approved branch', async () => {
    const { io, out, cwd, script, calls } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await submittedTaskWithWorktree(io, out, cwd, script);

    mkdirSync(deriveReviewWorktreePath(io.env, 'inspector', cwd).path, { recursive: true });
    scriptCreateWorktree(script, cwd);
    script.push(ok(''));
    expect(await run(['task', 'review', 'inspector', id, '--json'], io)).toBe(0);
    out.length = 0;

    script.push(ok('')); // best-effort restore checkout back to base_ref
    const before = calls.length;
    expect(await run(['task', 'approve', 'inspector', id, '--json'], io)).toBe(0);
    expect(calls.length - before).toBe(1);
    expect(calls.at(-1)?.args).toEqual(expect.arrayContaining(['checkout', 'main']));
    expect(records(out)[0]).toMatchObject({ status: 'completed' });
  });

  it('is a no-op restore (no extra git calls) when the reviewer has no matching review worktree', async () => {
    const { io, out, cwd, script, calls } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await submittedTaskWithWorktree(io, out, cwd, script);
    const before = calls.length;
    expect(await run(['task', 'approve', 'inspector', id, '--json'], io)).toBe(0);
    expect(calls.length).toBe(before);
  });

  it('prints a Warning on stderr (never stdout) and still succeeds when the restore checkout fails', async () => {
    const { io, out, err, cwd, script } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await submittedTaskWithWorktree(io, out, cwd, script);

    mkdirSync(deriveReviewWorktreePath(io.env, 'inspector', cwd).path, { recursive: true });
    scriptCreateWorktree(script, cwd);
    script.push(ok(''));
    expect(await run(['task', 'review', 'inspector', id, '--json'], io)).toBe(0);
    out.length = 0;
    err.length = 0;

    script.push(fail('local changes would be overwritten'));
    expect(await run(['task', 'approve', 'inspector', id, '--json'], io)).toBe(0);
    expect(err.join('')).toContain('Warning');
    expect(err.join('')).toContain('local changes would be overwritten');
    // stdout stays pure NDJSON: exactly one parseable Task record, no warning text.
    expect(records(out)).toHaveLength(1);
    expect(records(out)[0]).toMatchObject({ status: 'completed' });
  });

  it('requeue also restores the reviewer worktree when it sits on the requeued branch', async () => {
    const { io, out, cwd, script, calls } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await submittedTaskWithWorktree(io, out, cwd, script);

    mkdirSync(deriveReviewWorktreePath(io.env, 'inspector', cwd).path, { recursive: true });
    scriptCreateWorktree(script, cwd);
    script.push(ok(''));
    expect(await run(['task', 'review', 'inspector', id, '--json'], io)).toBe(0);
    out.length = 0;

    script.push(ok('')); // best-effort restore
    const before = calls.length;
    expect(
      await run(['task', 'requeue', 'inspector', id, '--reason', 'rework', '--json'], io),
    ).toBe(0);
    expect(calls.length - before).toBe(1);
    expect(records(out)[0]).toMatchObject({ status: 'queued' });
  });

  it("requeue by the CREATOR (not the reviewer) still restores the REVIEWER worktree, not the creator's", async () => {
    const { io, out, cwd, script, calls } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await submittedTaskWithWorktree(io, out, cwd, script);

    // The reviewer ('inspector') puts its own dedicated worktree on the Task's
    // branch via `task review` — this is the row that must be restored below.
    mkdirSync(deriveReviewWorktreePath(io.env, 'inspector', cwd).path, { recursive: true });
    scriptCreateWorktree(script, cwd);
    script.push(ok(''));
    expect(await run(['task', 'review', 'inspector', id, '--json'], io)).toBe(0);
    out.length = 0;

    // The CREATOR ('manager'), not the reviewer, performs the requeue — requeue
    // permits either. Before the fix, the restore looked up a review worktree
    // for 'manager' (which doesn't exist) instead of 'inspector', and silently
    // skipped restoring the reviewer's still-checked-out worktree.
    script.push(ok('')); // expected restore checkout back to base_ref
    const before = calls.length;
    expect(await run(['task', 'requeue', 'manager', id, '--reason', 'rework', '--json'], io)).toBe(
      0,
    );
    expect(calls.length - before).toBe(1);
    expect(calls.at(-1)?.args).toEqual(expect.arrayContaining(['checkout', 'main']));
    expect(records(out)[0]).toMatchObject({ status: 'queued' });
  });
});

describe('Task land', () => {
  it('rejects an archived creator or reviewer before any Git side effect (FR-W11)', async () => {
    const { io, out, err, cwd, script, calls } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await completedTaskWithWorktree(io, out, cwd, script);
    expect(await run(['leave', 'inspector', '--json'], io)).toBe(0);
    calls.length = 0;
    err.length = 0;

    expect(await run(['task', 'land', 'inspector', id, '--json'], io)).toBe(1);
    expect(errorCode(err)).toBe('AGENT_INACTIVE');
    expect(calls).toHaveLength(0);

    out.length = 0;
    expect(await run(['task', 'show', id, '--json'], io)).toBe(0);
    expect(records(out)[0]).toMatchObject({
      status: 'completed',
      worktree_path: deriveTaskWorktreePath(io.env, id, 'Add X', cwd).path,
    });
  });

  it('rejects an actor who is neither creator nor reviewer', async () => {
    const { io, out, err, cwd, script } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await completedTaskWithWorktree(io, out, cwd, script);
    err.length = 0;
    expect(await run(['task', 'land', 'worker', id, '--json'], io)).toBe(1);
    expect(errorCode(err)).toBe('TASK_CONFLICT');
  });

  it('rejects a non-completed Task', async () => {
    const { io, out, err, cwd, script } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await submittedTaskWithWorktree(io, out, cwd, script); // submitted, not completed
    err.length = 0;
    expect(await run(['task', 'land', 'inspector', id, '--json'], io)).toBe(1);
    expect(errorCode(err)).toBe('TASK_CONFLICT');
  });

  it('rejects a completed Task with no worktree', async () => {
    const { io, out, err } = workspace(() => 0);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);
    expect(await run(['task', 'submit', 'worker', id, '--summary', 'v1', '--json'], io)).toBe(0);
    expect(await run(['task', 'approve', 'inspector', id, '--json'], io)).toBe(0);
    err.length = 0;
    expect(await run(['task', 'land', 'inspector', id, '--json'], io)).toBe(1);
    expect(errorCode(err)).toBe('TASK_CONFLICT');
  });

  it('refuses to remove without --force when the worktree looks unlanded, and makes no changes', async () => {
    const { io, out, err, cwd, script } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await completedTaskWithWorktree(io, out, cwd, script);

    script.push(ok(' M src/foo.ts\n')); // status --porcelain: dirty (short-circuits before merge-base)
    err.length = 0;
    expect(await run(['task', 'land', 'inspector', id, '--json'], io)).toBe(1);
    expect(errorCode(err)).toBe('TASK_CONFLICT');

    out.length = 0;
    expect(await run(['task', 'show', id, '--json'], io)).toBe(0);
    expect(records(out)[0]).toMatchObject({ status: 'completed' });
    expect(records(out)[0]?.worktree_path).not.toBeNull(); // untouched
  });

  it('removes the worktree with --force even when it looks unlanded', async () => {
    const { io, out, cwd, script } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await completedTaskWithWorktree(io, out, cwd, script);

    script.push(
      ok(' M src/foo.ts\n'), // status --porcelain: dirty (merge-base never consulted)
      ok(''), // worktree remove
      ok(''), // branch -d
    );
    out.length = 0;
    expect(await run(['task', 'land', 'inspector', id, '--force', '--json'], io)).toBe(0);
    expect(records(out)[0]).toMatchObject({
      status: 'completed',
      worktree_path: null,
      worktree_branch: null,
      worktree_base_ref: null,
    });
  });

  it('surfaces a clear NOT_FOUND with a manual-recovery hint and makes no DB change when git worktree remove fails', async () => {
    const { io, out, err, cwd, script } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await completedTaskWithWorktree(io, out, cwd, script);

    script.push(
      ok(''), // status --porcelain: clean
      ok(''), // merge-base --is-ancestor: merged (safe)
      fail('worktree is locked'), // worktree remove fails
    );
    err.length = 0;
    expect(await run(['task', 'land', 'inspector', id, '--json'], io)).toBe(1);
    expect(errorCode(err)).toBe('NOT_FOUND');
    expect(err.join('')).toContain('manually run');

    out.length = 0;
    expect(await run(['task', 'show', id, '--json'], io)).toBe(0);
    expect(records(out)[0]?.worktree_path).not.toBeNull(); // untouched on failure
  });

  it('still clears the Task and warns (never fails) when the worktree is removed but its unmerged branch cannot be deleted', async () => {
    const { io, out, err, cwd, script } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await completedTaskWithWorktree(io, out, cwd, script);

    script.push(
      ok(' M src/foo.ts\n'), // status --porcelain: dirty (merge-base never consulted)
      ok(''), // worktree remove: succeeds
      fail('branch not fully merged'), // branch -d: real git's own independent refusal
    );
    out.length = 0;
    err.length = 0;
    expect(await run(['task', 'land', 'inspector', id, '--force', '--json'], io)).toBe(0);
    // The Task's bookkeeping is cleared regardless — the worktree really is
    // gone, which is the primary goal; a leftover local branch object must
    // never leave the Task permanently stuck.
    expect(records(out)[0]).toMatchObject({
      status: 'completed',
      worktree_path: null,
      worktree_branch: null,
      worktree_base_ref: null,
    });
    expect(err.join('')).toContain('Warning');
    expect(err.join('')).toContain('branch not fully merged');
  });

  it('removes the worktree/branch, clears the Task, and delivers the ADR-0014 Sign-off to the assignee', async () => {
    const { io, out, cwd, script } = worktreeWorkspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await completedTaskWithWorktree(io, out, cwd, script);

    script.push(
      ok(''), // status --porcelain: clean
      ok(''), // merge-base --is-ancestor: merged (safe)
      ok(''), // worktree remove
      ok(''), // branch -d
    );
    out.length = 0;
    expect(await run(['task', 'land', 'inspector', id, '--json'], io)).toBe(0);
    expect(records(out)[0]).toMatchObject({
      status: 'completed',
      worktree_path: null,
      worktree_branch: null,
      worktree_base_ref: null,
    });

    out.length = 0;
    expect(await run(['pending', '--agent', 'worker', '--json'], io)).toBe(0);
    const inbox = records(out);
    const signOff = inbox.find((m) => (m.content as string).includes('landed, safe to clear'));
    expect(signOff).toBeDefined();
    expect(signOff?.content).toBe(`Task ${id}: landed, safe to clear your context.`);
    // The Sign-off is the structured clear_safe kind (ADR-0016), emitted as-is
    // in the NDJSON message record.
    expect(signOff?.kind).toBe('clear_safe');
    expect(signOff?.task_id).toBe(id);
  });
});
