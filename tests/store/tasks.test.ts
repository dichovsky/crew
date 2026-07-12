import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewError } from '../../src/errors.js';
import { Store } from '../../src/store/index.js';
import { TASK_ID_PATTERN } from '../../src/task-id.js';

const made: string[] = [];
const ABSENT_ID = '11111111-1111-4111-8111-111111111111';

function create(
  clock: () => number,
  onTransactionStep?: (label: string) => void,
): {
  store: Store;
  path: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'crew-tasks-'));
  made.push(dir);
  const path = join(dir, 'crew.db');
  return {
    store: new Store(path, {
      clock,
      ...(onTransactionStep !== undefined ? { onTransactionStep } : {}),
    }),
    path,
  };
}

function addAgents(store: Store, ...ids: string[]): void {
  for (const id of ids) store.joinAgent({ id, role: id });
}

/** A fresh Crew with the built-in three Roles and a queued Task. */
function queuedTask(clock: () => number): { store: Store; id: string } {
  const { store } = create(clock);
  addAgents(store, 'manager', 'worker', 'inspector');
  const task = store.createTask({
    creatorId: 'manager',
    assigneeId: 'worker',
    reviewerId: 'inspector',
    title: 'Add X',
  });
  return { store, id: task.id };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('expected failure');
  } catch (err) {
    expect(err).toBeInstanceOf(CrewError);
    expect((err as CrewError).code).toBe(code);
  }
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('Store Task create (FR-E01)', () => {
  it('inserts a queued revision-0 Task, a created Event, and an assignee notification', () => {
    let now = 5;
    const { store } = create(() => now);
    addAgents(store, 'manager', 'worker', 'inspector');
    now = 10;
    const task = store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'Add X',
      body: 'details',
    });
    expect(TASK_ID_PATTERN.test(task.id)).toBe(true);
    expect(task).toMatchObject({
      title: 'Add X',
      body: 'details',
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      status: 'queued',
      revision: 0,
      leaseOwnerId: null,
      leaseExpiresAt: null,
      submissionSummary: null,
      submittedAt: null,
      reviewSummary: null,
      completedAt: null,
      createdAt: 10,
      updatedAt: 10,
      staleLease: false,
    });

    const events = store.getTaskEvents(task.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      revision: 0,
      eventType: 'created',
      actorId: 'manager',
      fromStatus: null,
      toStatus: 'queued',
      detail: '',
      createdAt: 10,
    });

    const inbox = store.listPendingMessages({ agentId: 'worker' });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      senderId: 'manager',
      recipientId: 'worker',
      kind: 'task_assigned',
      taskId: task.id,
    });
    expect(inbox[0]?.content).toContain('assigned by manager');
    // The creator (actor) is touched; the assignee is not.
    expect(store.getAgent('manager')?.lastSeen).toBe(10);
    expect(store.getAgent('worker')?.lastSeen).toBe(5);
    store.close();
  });

  it('omits the assignment notification when the creator assigns themselves', () => {
    const { store } = create(() => 0);
    addAgents(store, 'manager', 'inspector');
    const task = store.createTask({
      creatorId: 'manager',
      assigneeId: 'manager',
      reviewerId: 'inspector',
      title: 'Self',
    });
    expect(store.listPendingMessages({ agentId: 'manager' })).toEqual([]);
    expect(store.getTaskEvents(task.id)).toHaveLength(1);
    store.close();
  });

  it('rejects missing or archived participants and bad title/body bounds without writing', () => {
    const { store } = create(() => 0);
    addAgents(store, 'manager', 'worker', 'inspector');
    const base = { creatorId: 'manager', assigneeId: 'worker', reviewerId: 'inspector' } as const;
    expectCode(() => store.createTask({ ...base, title: 'X', creatorId: 'ghost' }), 'NOT_FOUND');
    expectCode(() => store.createTask({ ...base, title: '' }), 'USAGE');
    expectCode(() => store.createTask({ ...base, title: 'a'.repeat(501) }), 'USAGE');
    expectCode(() => store.createTask({ ...base, title: 'X', body: 'b'.repeat(100_001) }), 'USAGE');
    store.leaveAgent('inspector');
    expectCode(() => store.createTask({ ...base, title: 'X' }), 'AGENT_INACTIVE');
    expect(store.listTasks()).toEqual([]);
    store.close();
  });
});

describe('Store Task start (FR-E03)', () => {
  it('moves queued to in_progress for the assignee, grants a 15-minute Lease, and emits no notification', () => {
    let now = 100;
    const { store, id } = queuedTask(() => now);
    now = 200;
    const started = store.startTask('worker', id);
    expect(started).toMatchObject({
      status: 'in_progress',
      revision: 1,
      leaseOwnerId: 'worker',
      leaseExpiresAt: 200 + 900,
      updatedAt: 200,
      staleLease: false,
    });
    const events = store.getTaskEvents(id);
    expect(events.map((event) => event.eventType)).toEqual(['created', 'started']);
    expect(events[1]).toMatchObject({ revision: 1, fromStatus: 'queued', toStatus: 'in_progress' });
    // start sends no Message; only the create assignment exists.
    expect(store.listMessageHistory()).toHaveLength(1);
    expect(store.getAgent('worker')?.lastSeen).toBe(200);
    store.close();
  });

  it('rejects a non-assignee, a non-queued status, and an archived participant', () => {
    const { store, id } = queuedTask(() => 0);
    expectCode(() => store.startTask('inspector', id), 'TASK_CONFLICT');
    store.startTask('worker', id);
    expectCode(() => store.startTask('worker', id), 'TASK_CONFLICT');
    const fresh = queuedTask(() => 0);
    fresh.store.leaveAgent('inspector');
    expectCode(() => fresh.store.startTask('worker', fresh.id), 'AGENT_INACTIVE');
    fresh.store.close();
    store.close();
  });

  it('rejects a malformed id with USAGE and an absent id with NOT_FOUND', () => {
    const { store } = create(() => 0);
    addAgents(store, 'worker');
    expectCode(() => store.startTask('worker', 'not-a-uuid'), 'USAGE');
    expectCode(() => store.startTask('worker', ABSENT_ID), 'NOT_FOUND');
    store.close();
  });

  it('records worktree_path/branch/base_ref in the SAME transition when supplied', () => {
    const { store, id } = queuedTask(() => 0);
    const started = store.startTask('worker', id, {
      path: '/data/crew/worktrees/abc/task-x',
      branch: 'crew/task-x-add-x',
      baseRef: 'main',
    });
    expect(started).toMatchObject({
      status: 'in_progress',
      worktreePath: '/data/crew/worktrees/abc/task-x',
      worktreeBranch: 'crew/task-x-add-x',
      worktreeBaseRef: 'main',
    });
    // The persisted fields round-trip through a fresh read too, not just the
    // return value of the transition itself.
    expect(store.getTask(id)).toMatchObject({
      worktreePath: '/data/crew/worktrees/abc/task-x',
      worktreeBranch: 'crew/task-x-add-x',
      worktreeBaseRef: 'main',
    });
    store.close();
  });

  it('leaves worktree fields null when no worktree is supplied (default/disabled)', () => {
    const { store, id } = queuedTask(() => 0);
    const started = store.startTask('worker', id);
    expect(started).toMatchObject({
      worktreePath: null,
      worktreeBranch: null,
      worktreeBaseRef: null,
    });
    store.close();
  });

  it('preserves an existing worktree triple when a restarted Task supplies none (FR-W01)', () => {
    const { store, id } = queuedTask(() => 0);
    const worktree = {
      path: '/data/crew/worktrees/abc/task-x',
      branch: 'crew/task-x-add-x',
      baseRef: 'main',
    };
    store.startTask('worker', id, worktree);
    store.submitTask('worker', id, 'Implemented X');
    store.requeueTask({ actorId: 'inspector', taskId: id, reason: 'redo' });

    const restarted = store.startTask('worker', id);
    expect(restarted).toMatchObject({
      worktreePath: worktree.path,
      worktreeBranch: worktree.branch,
      worktreeBaseRef: worktree.baseRef,
    });
    store.close();
  });
});

describe('Store Task submit (FR-E05)', () => {
  function inProgress(clock: () => number): { store: Store; id: string } {
    const { store, id } = queuedTask(clock);
    store.startTask('worker', id);
    return { store, id };
  }

  it('moves in_progress to submitted by the unexpired Lease owner, clears the Lease, and notifies reviewer and creator', () => {
    let now = 0;
    const { store, id } = inProgress(() => now);
    now = 300;
    const submitted = store.submitTask('worker', id, 'Implemented X');
    expect(submitted).toMatchObject({
      status: 'submitted',
      revision: 2,
      leaseOwnerId: null,
      leaseExpiresAt: null,
      submissionSummary: 'Implemented X',
      submittedAt: 300,
      reviewSummary: null,
      completedAt: null,
    });
    const events = store.getTaskEvents(id);
    expect(events.map((event) => event.eventType)).toEqual(['created', 'started', 'submitted']);
    expect(events[2]).toMatchObject({ revision: 2, detail: 'Implemented X' });
    // reviewer and creator are notified; the actor (worker) is not.
    expect(store.listPendingMessages({ agentId: 'inspector' })[0]?.kind).toBe('task_submitted');
    expect(
      store.listPendingMessages({ agentId: 'manager' }).some((m) => m.kind === 'task_submitted'),
    ).toBe(true);
    expect(
      store.listPendingMessages({ agentId: 'worker' }).some((m) => m.kind === 'task_submitted'),
    ).toBe(false);
    store.close();
  });

  it('rejects a non-owner, a non-in_progress status, an expired Lease, and bad summary bounds', () => {
    let now = 0;
    const { store, id } = inProgress(() => now);
    expectCode(() => store.submitTask('inspector', id, 'x'), 'TASK_CONFLICT');
    expectCode(() => store.submitTask('worker', id, ''), 'USAGE');
    // At exactly the expiry second the Lease is expired and submit is rejected.
    now = 900;
    expectCode(() => store.submitTask('worker', id, 'late'), 'TASK_CONFLICT');
    // queued task cannot be submitted.
    const queued = queuedTask(() => 0);
    expectCode(() => queued.store.submitTask('worker', queued.id, 'x'), 'TASK_CONFLICT');
    queued.store.close();
    store.close();
  });

  it('deduplicates notifications when reviewer equals creator', () => {
    let now = 0;
    const { store } = create(() => now);
    addAgents(store, 'manager', 'worker');
    const task = store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'manager',
      title: 'Add X',
    });
    store.startTask('worker', task.id);
    now = 10;
    store.submitTask('worker', task.id, 'done');
    expect(
      store.listMessageHistory({ agentId: 'manager' }).filter((m) => m.kind === 'task_submitted'),
    ).toHaveLength(1);
    store.close();
  });
});

describe('Store Task approve (FR-E07, FR-E21)', () => {
  function submitted(clock: () => number): { store: Store; id: string } {
    const { store, id } = queuedTask(clock);
    store.startTask('worker', id);
    store.submitTask('worker', id, 'Implemented X');
    return { store, id };
  }

  it('moves submitted to completed for the reviewer, retains the Submission, and notifies creator and assignee', () => {
    let now = 0;
    const { store, id } = submitted(() => now);
    now = 500;
    const completed = store.approveTask('inspector', id, 'Looks good');
    expect(completed).toMatchObject({
      status: 'completed',
      revision: 3,
      submissionSummary: 'Implemented X',
      reviewSummary: 'Looks good',
      completedAt: 500,
      leaseOwnerId: null,
    });
    const events = store.getTaskEvents(id);
    expect(events.map((event) => event.eventType)).toEqual([
      'created',
      'started',
      'submitted',
      'approved',
    ]);
    expect(events.map((event) => event.revision)).toEqual([0, 1, 2, 3]);
    expect(
      store.listPendingMessages({ agentId: 'worker' }).some((m) => m.kind === 'task_approved'),
    ).toBe(true);
    expect(
      store.listPendingMessages({ agentId: 'manager' }).some((m) => m.kind === 'task_approved'),
    ).toBe(true);
    store.close();
  });

  it('approves without a Review summary, storing null', () => {
    const { store, id } = submitted(() => 0);
    const completed = store.approveTask('inspector', id);
    expect(completed.reviewSummary).toBeNull();
    expect(store.getTaskEvents(id)[3]?.detail).toBe('');
    store.close();
  });

  it('rejects a non-reviewer, a non-submitted status, and keeps completed Tasks immutable', () => {
    const { store, id } = submitted(() => 0);
    expectCode(() => store.approveTask('worker', id, 'x'), 'TASK_CONFLICT');
    store.approveTask('inspector', id);
    // completed is immutable across every transition.
    expectCode(() => store.approveTask('inspector', id), 'TASK_CONFLICT');
    expectCode(() => store.startTask('worker', id), 'TASK_CONFLICT');
    expectCode(() => store.submitTask('worker', id, 'x'), 'TASK_CONFLICT');
    expectCode(
      () => store.requeueTask({ actorId: 'inspector', taskId: id, reason: 'no' }),
      'TASK_CONFLICT',
    );
    store.close();
  });
});

describe('Store Task requeue (FR-E09-E14)', () => {
  function submitted(clock: () => number): { store: Store; id: string } {
    const { store, id } = queuedTask(clock);
    store.startTask('worker', id);
    store.submitTask('worker', id, 'Implemented X');
    return { store, id };
  }

  it('returns a submitted Task to queued, clears all work/review fields, and notifies assignee, creator, reviewer', () => {
    let now = 0;
    const { store, id } = submitted(() => now);
    now = 50;
    const requeued = store.requeueTask({ actorId: 'inspector', taskId: id, reason: 'redo it' });
    expect(requeued).toMatchObject({
      status: 'queued',
      revision: 3,
      assigneeId: 'worker',
      leaseOwnerId: null,
      leaseExpiresAt: null,
      submissionSummary: null,
      submittedAt: null,
      reviewSummary: null,
      completedAt: null,
    });
    const last = store.getTaskEvents(id).at(-1);
    expect(last).toMatchObject({
      revision: 3,
      eventType: 'requeued',
      fromStatus: 'submitted',
      toStatus: 'queued',
      detail: 'redo it',
    });
    // assignee + creator are notified (reviewer is the actor and omitted).
    expect(
      store.listPendingMessages({ agentId: 'worker' }).some((m) => m.kind === 'task_requeued'),
    ).toBe(true);
    expect(
      store.listPendingMessages({ agentId: 'manager' }).some((m) => m.kind === 'task_requeued'),
    ).toBe(true);
    expect(
      store.listPendingMessages({ agentId: 'inspector' }).some((m) => m.kind === 'task_requeued'),
    ).toBe(false);
    store.close();
  });

  it('retargets the assignee with --to, requiring the new assignee active and exempting the old one', () => {
    const { store, id } = submitted(() => 0);
    addAgents(store, 'worker-2');
    const requeued = store.requeueTask({
      actorId: 'manager',
      taskId: id,
      reason: 'reassign',
      to: 'worker-2',
    });
    expect(requeued.assigneeId).toBe('worker-2');
    // The new assignee is notified; the bumped original worker is not.
    expect(store.listPendingMessages({ agentId: 'worker-2' })[0]?.kind).toBe('task_requeued');
    expect(
      store.listPendingMessages({ agentId: 'worker' }).some((m) => m.kind === 'task_requeued'),
    ).toBe(false);
    expectCode(
      () => store.requeueTask({ actorId: 'manager', taskId: id, reason: 'x', to: 'ghost' }),
      'NOT_FOUND',
    );
    store.close();
  });

  it('recovers an in_progress Task only after Lease expiry and never steals an active Lease', () => {
    let now = 0;
    const { store, id } = queuedTask(() => now);
    store.startTask('worker', id); // lease_expires_at = 900
    now = 800;
    expectCode(
      () => store.requeueTask({ actorId: 'manager', taskId: id, reason: 'early' }),
      'TASK_CONFLICT',
    );
    now = 900; // expiry is inclusive: now == expiry is recoverable
    const requeued = store.requeueTask({ actorId: 'manager', taskId: id, reason: 'recover' });
    expect(requeued.status).toBe('queued');
    expect(store.getTaskEvents(id).at(-1)).toMatchObject({
      fromStatus: 'in_progress',
      detail: 'recover',
    });
    store.close();
  });

  it('recovers an expired Lease whose original assignee has since left, then retargets', () => {
    let now = 0;
    const { store, id } = queuedTask(() => now);
    store.startTask('worker', id);
    store.leaveAgent('worker'); // the Worker vanished
    addAgents(store, 'worker-2');
    now = 900;
    const requeued = store.requeueTask({
      actorId: 'manager',
      taskId: id,
      reason: 'recover',
      to: 'worker-2',
    });
    expect(requeued).toMatchObject({ status: 'queued', assigneeId: 'worker-2' });
    store.close();
  });

  it('rejects an abandoned Task naming the terminal state, symmetric with the completed guard', () => {
    const { store, id } = submitted(() => 0);
    store.abandonTask({ actorId: 'manager', taskId: id, reason: 'dead' });
    try {
      store.requeueTask({ actorId: 'manager', taskId: id, reason: 'retry' });
      throw new Error('expected failure');
    } catch (err) {
      expect(err).toBeInstanceOf(CrewError);
      // The rejection must name the terminal state, never masquerade as the
      // generic compare-and-swap "task changed concurrently" race message.
      expect((err as CrewError).code).toBe('TASK_CONFLICT');
      expect((err as CrewError).message).toBe('task is abandoned and cannot be requeued');
    }
    store.close();
  });

  it('rejects a non-creator/reviewer actor, an archived actor, a queued Task, and an empty reason', () => {
    const { store, id } = submitted(() => 0);
    expectCode(
      () => store.requeueTask({ actorId: 'worker', taskId: id, reason: 'no' }),
      'TASK_CONFLICT',
    );
    expectCode(() => store.requeueTask({ actorId: 'inspector', taskId: id, reason: '' }), 'USAGE');
    const queued = queuedTask(() => 0);
    expectCode(
      () => queued.store.requeueTask({ actorId: 'manager', taskId: queued.id, reason: 'x' }),
      'TASK_CONFLICT',
    );
    queued.store.close();
    store.leaveAgent('inspector');
    expectCode(
      () => store.requeueTask({ actorId: 'inspector', taskId: id, reason: 'x' }),
      'AGENT_INACTIVE',
    );
    store.close();
  });

  it('skips notifications for an archived non-actor participant (empty recipient set is valid)', () => {
    const { store, id } = submitted(() => 0);
    store.leaveAgent('worker'); // assignee gone; non-actor on this requeue
    const requeued = store.requeueTask({ actorId: 'manager', taskId: id, reason: 'recover' });
    expect(requeued.status).toBe('queued');
    // reviewer is notified; the archived assignee and the actor are not.
    expect(
      store
        .listMessageHistory({ recipientId: 'inspector' })
        .some((m) => m.kind === 'task_requeued'),
    ).toBe(true);
    store.close();
  });
});

describe('Store Task abandon', () => {
  function submitted(clock: () => number): { store: Store; id: string } {
    const { store, id } = queuedTask(clock);
    store.startTask('worker', id);
    store.submitTask('worker', id, 'Implemented X');
    return { store, id };
  }

  it('abandons a queued Task, clears the lease/review fields, stamps abandonedAt, and notifies', () => {
    let now = 0;
    const { store, id } = queuedTask(() => now);
    now = 50;
    const abandoned = store.abandonTask({ actorId: 'manager', taskId: id, reason: 'dead work' });
    expect(abandoned).toMatchObject({
      status: 'abandoned',
      revision: 1,
      leaseOwnerId: null,
      leaseExpiresAt: null,
      reviewSummary: null,
      completedAt: null,
      abandonedAt: 50,
    });
    const last = store.getTaskEvents(id).at(-1);
    expect(last).toMatchObject({
      revision: 1,
      eventType: 'abandoned',
      actorId: 'manager',
      fromStatus: 'queued',
      toStatus: 'abandoned',
      detail: 'dead work',
    });
    // The assignee's copy is the structured clear_safe Sign-off (ADR-0016); the
    // reviewer's stays a plain note; the creator is the actor and omitted.
    const workerInbox = store.listPendingMessages({ agentId: 'worker' });
    const workerCopy = workerInbox.find((m) => m.content.includes('abandoned by'));
    expect(workerCopy?.kind).toBe('clear_safe');
    expect(workerCopy?.taskId).toBe(id);
    expect(store.listPendingMessages({ agentId: 'inspector' }).some((m) => m.kind === 'note')).toBe(
      true,
    );
    expect(
      store.listPendingMessages({ agentId: 'inspector' }).some((m) => m.kind === 'clear_safe'),
    ).toBe(false);
    expect(store.listPendingMessages({ agentId: 'manager' }).length).toBe(0);
    store.close();
  });

  it('abandons an in_progress Task even with an active (unexpired) Lease', () => {
    const { store, id } = queuedTask(() => 0);
    store.startTask('worker', id); // lease_expires_at = 900, well in the future at now=0
    const abandoned = store.abandonTask({ actorId: 'inspector', taskId: id, reason: '' });
    expect(abandoned).toMatchObject({
      status: 'abandoned',
      leaseOwnerId: null,
      leaseExpiresAt: null,
    });
    store.close();
  });

  it('abandons a Task with an active worktree, clearing worktree_path/branch/base_ref', () => {
    const { store, id } = queuedTask(() => 0);
    store.startTask('worker', id, {
      path: '/tmp/crew-worktrees/task-1',
      branch: 'crew/task-1-fix-login',
      baseRef: 'main',
    });
    const abandoned = store.abandonTask({ actorId: 'manager', taskId: id, reason: 'dead work' });
    expect(abandoned).toMatchObject({
      status: 'abandoned',
      worktreePath: null,
      worktreeBranch: null,
      worktreeBaseRef: null,
    });
    store.close();
  });

  it('abandons a submitted Task, preserving its Submission summary (not cleared like requeue)', () => {
    const { store, id } = submitted(() => 0);
    const abandoned = store.abandonTask({ actorId: 'manager', taskId: id, reason: 'stale' });
    expect(abandoned).toMatchObject({
      status: 'abandoned',
      submissionSummary: 'Implemented X', // unlike requeue, abandon does not clear it
      submittedAt: 0,
    });
    store.close();
  });

  it('accepts an empty reason (unlike requeue, a reason is optional)', () => {
    const { store, id } = queuedTask(() => 0);
    const abandoned = store.abandonTask({ actorId: 'manager', taskId: id, reason: '' });
    expect(abandoned.status).toBe('abandoned');
    expect(store.getTaskEvents(id).at(-1)?.detail).toBe('');
    store.close();
  });

  it('rejects a completed Task and an already-abandoned Task', () => {
    const { store, id } = submitted(() => 0);
    store.approveTask('inspector', id, 'ok');
    expectCode(
      () => store.abandonTask({ actorId: 'manager', taskId: id, reason: 'x' }),
      'TASK_CONFLICT',
    );

    const { store: store2, id: id2 } = queuedTask(() => 0);
    store2.abandonTask({ actorId: 'manager', taskId: id2, reason: 'first' });
    expectCode(
      () => store2.abandonTask({ actorId: 'manager', taskId: id2, reason: 'second' }),
      'TASK_CONFLICT',
    );
    store.close();
    store2.close();
  });

  it('rejects a non-creator/reviewer actor and an archived actor', () => {
    const { store, id } = queuedTask(() => 0);
    expectCode(
      () => store.abandonTask({ actorId: 'worker', taskId: id, reason: 'no' }),
      'TASK_CONFLICT',
    );
    store.leaveAgent('manager');
    expectCode(
      () => store.abandonTask({ actorId: 'manager', taskId: id, reason: 'x' }),
      'AGENT_INACTIVE',
    );
    store.close();
  });

  it('falls back to the active `operator` Agent identity only once BOTH creator and reviewer are archived', () => {
    const { store, id } = queuedTask(() => 0);
    store.joinAgent({ id: 'operator', role: 'operator' });
    store.leaveAgent('manager'); // creator archived, reviewer still active
    expectCode(
      () => store.abandonTask({ actorId: 'operator', taskId: id, reason: 'x' }),
      'TASK_CONFLICT',
    );
    store.leaveAgent('inspector'); // both now archived
    const abandoned = store.abandonTask({ actorId: 'operator', taskId: id, reason: 'cleanup' });
    expect(abandoned.status).toBe('abandoned');
    store.close();
  });

  it('rejects a fallback actor that is not the `operator` identity, even both archived', () => {
    const { store, id } = queuedTask(() => 0);
    addAgents(store, 'bystander');
    store.leaveAgent('manager');
    store.leaveAgent('inspector');
    expectCode(
      () => store.abandonTask({ actorId: 'bystander', taskId: id, reason: 'x' }),
      'TASK_CONFLICT',
    );
    store.close();
  });

  it('rejects a Role of "operator" on the WRONG Agent id — Roles grant no privilege (FR-C16)', () => {
    const { store, id } = queuedTask(() => 0);
    // Same Role string as the fallback identity, but a different Agent id —
    // authority must key on id, never on Role (the regression this closes:
    // any Agent could once self-declare `--role operator` for abandon
    // fallback authority).
    store.joinAgent({ id: 'impersonator', role: 'operator' });
    store.leaveAgent('manager');
    store.leaveAgent('inspector');
    expectCode(
      () => store.abandonTask({ actorId: 'impersonator', taskId: id, reason: 'x' }),
      'TASK_CONFLICT',
    );
    store.close();
  });

  it('rejects the `operator` id itself when its Role is not "operator" — not the plain identity', () => {
    const { store, id } = queuedTask(() => 0);
    // Same id as the fallback identity, but the WRONG shape (matches the
    // exact case the Console's own ensureOperatorAgent startup guard also
    // refuses to adopt) — id alone is not enough; the row must genuinely be
    // the plain operator ADR-0012 describes.
    store.joinAgent({ id: 'operator', role: 'worker' });
    store.leaveAgent('manager');
    store.leaveAgent('inspector');
    expectCode(
      () => store.abandonTask({ actorId: 'operator', taskId: id, reason: 'x' }),
      'TASK_CONFLICT',
    );
    store.close();
  });

  it('rejects the `operator` id itself when it is platform-bound — not the plain identity', () => {
    const { store, id } = queuedTask(() => 0);
    store.joinAgent({ id: 'operator', role: 'operator', platformId: 'claude-code' });
    store.leaveAgent('manager');
    store.leaveAgent('inspector');
    expectCode(
      () => store.abandonTask({ actorId: 'operator', taskId: id, reason: 'x' }),
      'TASK_CONFLICT',
    );
    store.close();
  });

  it('skips notifications for an archived non-actor participant (empty recipient set is valid)', () => {
    const { store, id } = queuedTask(() => 0);
    store.leaveAgent('worker'); // assignee gone; non-actor on this abandon
    const abandoned = store.abandonTask({ actorId: 'manager', taskId: id, reason: 'cleanup' });
    expect(abandoned.status).toBe('abandoned');
    expect(
      store.listMessageHistory({ recipientId: 'inspector' }).some((m) => m.kind === 'note'),
    ).toBe(true);
    store.close();
  });
});

describe('Store Task land', () => {
  const WORKTREE = {
    path: '/data/crew/worktrees/abc/task-x',
    branch: 'crew/task-x-add-x',
    baseRef: 'main',
  };

  /** A completed Task started with a worktree, ready for `landTask`. */
  function completedWithWorktree(clock: () => number): { store: Store; id: string } {
    const { store, id } = queuedTask(clock);
    store.startTask('worker', id, WORKTREE);
    store.submitTask('worker', id, 'Implemented X');
    store.approveTask('inspector', id, 'LGTM');
    return { store, id };
  }

  it('clears worktree fields, leaves status/revision untouched, and sends the ADR-0014 Sign-off', () => {
    let now = 0;
    const { store, id } = completedWithWorktree(() => now);
    now = 900;
    const landed = store.landTask({ actorId: 'inspector', taskId: id });
    expect(landed).toMatchObject({
      status: 'completed',
      revision: 3, // unchanged: landing is not a status transition
      worktreePath: null,
      worktreeBranch: null,
      worktreeBaseRef: null,
    });
    // No new Task Event: task_events is a status-transition log only.
    expect(store.getTaskEvents(id).map((event) => event.eventType)).toEqual([
      'created',
      'started',
      'submitted',
      'approved',
    ]);
    const inbox = store.listPendingMessages({ agentId: 'worker' });
    const signOff = inbox.find((m) => m.content.includes('landed, safe to clear your context'));
    expect(signOff).toBeDefined();
    expect(signOff?.content).toBe(`Task ${id}: landed, safe to clear your context.`);
    expect(signOff?.senderId).toBe('inspector');
    expect(signOff?.kind).toBe('clear_safe');
    expect(signOff?.taskId).toBe(id);
    expect(store.getAgent('inspector')?.lastSeen).toBe(900);
    store.close();
  });

  it('allows the creator (not just the reviewer) to land', () => {
    const { store, id } = completedWithWorktree(() => 0);
    const landed = store.landTask({ actorId: 'manager', taskId: id });
    expect(landed.worktreePath).toBeNull();
    store.close();
  });

  it('rejects an actor who is neither creator nor reviewer', () => {
    const { store, id } = completedWithWorktree(() => 0);
    expectCode(() => store.landTask({ actorId: 'worker', taskId: id }), 'TASK_CONFLICT');
    store.close();
  });

  it('rejects a non-completed Task', () => {
    const { store, id } = queuedTask(() => 0);
    store.startTask('worker', id, WORKTREE);
    store.submitTask('worker', id, 'v1'); // submitted, not completed
    expectCode(() => store.landTask({ actorId: 'inspector', taskId: id }), 'TASK_CONFLICT');
    store.close();
  });

  it('rejects a completed Task with no worktree', () => {
    const { store, id } = queuedTask(() => 0);
    store.startTask('worker', id); // no worktree supplied
    store.submitTask('worker', id, 'v1');
    store.approveTask('inspector', id);
    expectCode(() => store.landTask({ actorId: 'inspector', taskId: id }), 'TASK_CONFLICT');
    store.close();
  });

  it('rejects landing the same Task twice (cannot double-fire)', () => {
    const { store, id } = completedWithWorktree(() => 0);
    store.landTask({ actorId: 'inspector', taskId: id });
    expectCode(() => store.landTask({ actorId: 'inspector', taskId: id }), 'TASK_CONFLICT');
    store.close();
  });

  it('skips the Sign-off when the assignee is archived, but still clears the worktree', () => {
    const { store, id } = completedWithWorktree(() => 0);
    store.leaveAgent('worker');
    const landed = store.landTask({ actorId: 'inspector', taskId: id });
    expect(landed.worktreePath).toBeNull();
    expect(store.listMessageHistory().some((m) => m.content.includes('landed'))).toBe(false);
    store.close();
  });

  it('delivers the Sign-off even when the actor is also the assignee (the Relay reset keys on it)', () => {
    const now = 0;
    const { store } = create(() => now);
    addAgents(store, 'worker', 'inspector');
    const task = store.createTask({
      creatorId: 'worker',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'Self-assigned',
    });
    store.startTask('worker', task.id, WORKTREE);
    store.submitTask('worker', task.id, 'v1');
    store.approveTask('inspector', task.id, 'ok');
    const landed = store.landTask({ actorId: 'worker', taskId: task.id });
    expect(landed.worktreePath).toBeNull();
    // Unlike a courtesy notification, the structured clear_safe Sign-off is
    // NOT self-actor-suppressed: a self-landing Worker still needs the durable
    // unread signal (ADR-0016).
    const signOff = store
      .listPendingMessages({ agentId: 'worker' })
      .find((m) => m.kind === 'clear_safe');
    expect(signOff?.content).toBe(`Task ${task.id}: landed, safe to clear your context.`);
    expect(signOff?.senderId).toBe('worker');
    store.close();
  });

  it('abandon delivers the assignee Sign-off even when the assignee is the actor', () => {
    const now = 0;
    const { store } = create(() => now);
    addAgents(store, 'worker', 'inspector');
    const task = store.createTask({
      creatorId: 'worker',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'Self-assigned, later abandoned',
    });
    const abandoned = store.abandonTask({ actorId: 'worker', taskId: task.id, reason: 'dead' });
    expect(abandoned.status).toBe('abandoned');
    const signOff = store
      .listPendingMessages({ agentId: 'worker' })
      .find((m) => m.kind === 'clear_safe');
    expect(signOff?.content).toBe(
      `Task ${task.id} "Self-assigned, later abandoned" abandoned by worker`,
    );
    // The reviewer's courtesy copy keeps ordinary self/actor suppression rules.
    expect(store.listPendingMessages({ agentId: 'inspector' }).some((m) => m.kind === 'note')).toBe(
      true,
    );
    store.close();
  });
});

describe('Store Task read surfaces (FR-E19)', () => {
  it('derives stale_lease and filters list by assignee, reviewer, status, and stale-lease', () => {
    let now = 0;
    const { store, id } = queuedTask(() => now);
    addAgents(store, 'worker-2');
    const other = store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker-2',
      reviewerId: 'inspector',
      title: 'Second',
    });
    store.startTask('worker', id);
    now = 1000; // first task's lease (expires 900) is now stale
    expect(store.getTask(id)?.staleLease).toBe(true);
    expect(store.getTask(other.id)?.staleLease).toBe(false);

    expect(store.listTasks({ assigneeId: 'worker-2' }).map((t) => t.id)).toEqual([other.id]);
    expect(store.listTasks({ reviewerId: 'inspector' })).toHaveLength(2);
    expect(store.listTasks({ status: 'queued' }).map((t) => t.id)).toEqual([other.id]);
    expect(store.listTasks({ staleLease: true }).map((t) => t.id)).toEqual([id]);
    store.close();
  });

  it('orders list by created_at ascending', () => {
    let now = 0;
    const { store } = create(() => now);
    addAgents(store, 'manager', 'worker', 'inspector');
    now = 5;
    const earlier = store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'A',
    });
    now = 10;
    const later = store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'B',
    });
    expect(store.listTasks().map((t) => t.id)).toEqual([earlier.id, later.id]);
    store.close();
  });

  it('reports NOT_FOUND for events of an absent Task and USAGE for a malformed id', () => {
    const { store } = create(() => 0);
    expectCode(() => store.getTaskEvents('bad'), 'USAGE');
    expectCode(() => store.getTaskEvents(ABSENT_ID), 'NOT_FOUND');
    expect(store.getTask(ABSENT_ID)).toBeNull();
    store.close();
  });
});

describe('Store Task atomicity and constraints (FR-E15, FR-E18, FR-I12)', () => {
  it('increments revision exactly once with one matching Event per transition', () => {
    const { store, id } = queuedTask(() => 0);
    store.startTask('worker', id);
    store.submitTask('worker', id, 'done');
    store.approveTask('inspector', id, 'ok');
    const events = store.getTaskEvents(id);
    expect(events.map((e) => e.revision)).toEqual([0, 1, 2, 3]);
    // one event per revision (the schema UNIQUE(task_id, revision) is also proven below)
    expect(new Set(events.map((e) => e.revision)).size).toBe(events.length);
    store.close();
  });

  it('fires labeled transaction steps and rolls back fully when a step throws', () => {
    const labels: string[] = [];
    const { store, id } = (() => {
      const built = create(
        () => 0,
        (label) => labels.push(label),
      );
      addAgents(built.store, 'manager', 'worker', 'inspector');
      const task = built.store.createTask({
        creatorId: 'manager',
        assigneeId: 'worker',
        reviewerId: 'inspector',
        title: 'Add X',
      });
      return { store: built.store, id: task.id };
    })();
    store.startTask('worker', id);
    expect(labels).toEqual(['create:after-insert', 'start:after-update']);
    store.close();

    // A throwing step aborts the transaction; no row or event survives.
    const failing = create(
      () => 0,
      () => {
        throw new Error('boom');
      },
    );
    addAgents(failing.store, 'manager', 'worker', 'inspector');
    expectCode(
      () =>
        failing.store.createTask({
          creatorId: 'manager',
          assigneeId: 'worker',
          reviewerId: 'inspector',
          title: 'Add X',
        }),
      'INTEGRITY',
    );
    expect(failing.store.listTasks()).toEqual([]);
    expect(failing.store.listMessageHistory()).toEqual([]);
    failing.store.close();
  });

  it('cannot persist impossible status/field combinations (DB CHECK fixtures)', () => {
    const { store } = queuedTask(() => 0);
    const path = store.databasePath;
    store.close();
    const db = new DatabaseSync(path);
    // queued Task carrying a Lease violates the status/field CHECK.
    expect(() =>
      db
        .prepare(
          `INSERT INTO tasks (id, title, body, creator_id, assignee_id, reviewer_id, status,
             revision, lease_owner_id, lease_expires_at, submission_summary, submitted_at,
             review_summary, completed_at, created_at, updated_at)
           VALUES ('22222222-2222-4222-8222-222222222222', 'bad', '', 'manager', 'worker',
             'inspector', 'queued', 0, 'worker', 100, NULL, NULL, NULL, NULL, 0, 0)`,
        )
        .run(),
    ).toThrow();
    // A second Event at an existing revision violates UNIQUE(task_id, revision).
    expect(() =>
      db
        .prepare(
          `INSERT INTO task_events (task_id, revision, event_type, actor_id, from_status,
             to_status, detail, created_at)
           SELECT id, 0, 'created', 'manager', NULL, 'queued', '', 0 FROM tasks LIMIT 1`,
        )
        .run(),
    ).toThrow();
    db.close();
  });

  it('reads the Task and its Events from one snapshot under a concurrent transition', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-tasks-snap-'));
    made.push(dir);
    const path = join(dir, 'crew.db');
    const setup = new Store(path, { clock: () => 0 });
    addAgents(setup, 'manager', 'worker', 'inspector');
    const id = setup.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'snap',
    }).id;
    setup.close();

    // A second connection transitions the Task mid-read, after the snapshot is fixed.
    const writer = new Store(path, { clock: () => 0 });
    let fired = false;
    const reader = new Store(path, {
      clock: () => 0,
      onTransactionStep: (label) => {
        if (label === 'show:after-task' && !fired) {
          fired = true;
          writer.startTask('worker', id); // commits a started Event during the read
        }
      },
    });

    const { task, events } = reader.getTaskWithEvents(id);
    // The pair is internally consistent: the concurrent start is invisible to the snapshot.
    expect(task?.revision).toBe(0);
    expect(task?.status).toBe('queued');
    expect(events.map((event) => event.eventType)).toEqual(['created']);
    expect(task?.revision).toBe(events.at(-1)?.revision);
    // The concurrent write really committed, so the test is not vacuous.
    expect(reader.getTask(id)?.revision).toBe(1);

    reader.close();
    writer.close();
  });
});
