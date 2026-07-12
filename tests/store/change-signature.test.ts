import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewError } from '../../src/errors.js';
import { Store } from '../../src/store/index.js';

const made: string[] = [];

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-change-sig-'));
  made.push(dir);
  return join(dir, 'crew.db');
}

function addAgents(store: Store, ...ids: string[]): void {
  for (const id of ids) store.joinAgent({ id, role: id });
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('Store.getChangeSignature', () => {
  it('returns all-zero cursors for an empty store', () => {
    const store = new Store(dbPath(), { clock: () => 0 });
    expect(store.getChangeSignature()).toEqual({
      maxMessageId: 0,
      maxTaskEventId: 0,
      maxTaskUpdatedAt: 0,
      maxAgentLastSeen: 0,
      maxAgentArchivedAt: 0,
      staleLeaseCount: 0,
      agentMutationCursor: 0,
      observableMutationCursor: 0,
    });
    store.close();
  });

  it('advances maxMessageId when a new Message is sent', () => {
    const store = new Store(dbPath(), { clock: () => 0 });
    addAgents(store, 'manager', 'worker');
    const before = store.getChangeSignature();
    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'hi' });
    const after = store.getChangeSignature();
    expect(after.maxMessageId).toBeGreaterThan(before.maxMessageId);
    store.close();
  });

  it('advances observableMutationCursor when prune deletes a Message below a retained maximum', () => {
    let now = 0;
    const store = new Store(dbPath(), { clock: () => now });
    addAgents(store, 'manager', 'worker');
    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'old' });
    store.receiveMessages('worker');
    now = 10;
    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'new unread' });
    const before = store.getChangeSignature();
    store.pruneState({ messagesBeforeSeconds: 1, tasksBeforeSeconds: 1 });
    const after = store.getChangeSignature();
    expect(after.maxMessageId).toBe(before.maxMessageId);
    expect(after.observableMutationCursor).toBeGreaterThan(before.observableMutationCursor);
    store.close();
  });

  it('advances maxTaskEventId when a new Task Event is recorded', () => {
    const store = new Store(dbPath(), { clock: () => 0 });
    addAgents(store, 'manager', 'worker', 'inspector');
    const task = store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'Add X',
    });
    const before = store.getChangeSignature();
    store.startTask('worker', task.id); // records the `started` Event
    const after = store.getChangeSignature();
    expect(after.maxTaskEventId).toBeGreaterThan(before.maxTaskEventId);
    store.close();
  });

  it('advances maxTaskUpdatedAt when a Task is updated at a later time', () => {
    let now = 0;
    const store = new Store(dbPath(), { clock: () => now });
    addAgents(store, 'manager', 'worker', 'inspector');
    const task = store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'Add X',
    });
    const before = store.getChangeSignature();
    now = 10;
    store.startTask('worker', task.id); // updated_at moves to 10
    const after = store.getChangeSignature();
    expect(after.maxTaskUpdatedAt).toBeGreaterThan(before.maxTaskUpdatedAt);
    store.close();
  });

  it('advances maxAgentLastSeen on Agent activity', () => {
    let now = 0;
    const store = new Store(dbPath(), { clock: () => now });
    addAgents(store, 'worker');
    const before = store.getChangeSignature();
    now = 7;
    store.receiveMessages('worker'); // activity stamps last_seen = 7
    const after = store.getChangeSignature();
    expect(after.maxAgentLastSeen).toBeGreaterThan(before.maxAgentLastSeen);
    store.close();
  });

  it('advances the signature when an Agent is archived (leaveAgent stamps archived_at, not last_seen)', () => {
    let now = 0;
    const store = new Store(dbPath(), { clock: () => now });
    addAgents(store, 'worker');
    const before = store.getChangeSignature();
    now = 5;
    store.leaveAgent('worker'); // archives: archived_at = 5, last_seen preserved
    const after = store.getChangeSignature();
    // The archive transition must move the signature so the SSE poller fires;
    // without maxAgentArchivedAt this whole signature would be unchanged (the bug).
    expect(after.maxAgentArchivedAt).toBeGreaterThan(before.maxAgentArchivedAt);
    expect(after).not.toEqual(before);
    expect(after.maxAgentLastSeen).toBe(before.maxAgentLastSeen); // leave does not restamp activity
    store.close();
  });

  it('is read-only: repeated calls return an identical signature and consume nothing', () => {
    let now = 0;
    const store = new Store(dbPath(), { clock: () => now });
    addAgents(store, 'manager', 'worker');
    now = 5;
    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'unread note' });

    now = 100;
    const first = store.getChangeSignature();
    const second = store.getChangeSignature();
    expect(second).toEqual(first);

    // The unread Message was not consumed and no Agent activity was stamped.
    expect(store.getAgent('worker')?.lastSeen).toBe(0);
    const delivered = store.receiveMessages('worker');
    expect(delivered.map((message) => message.content)).toEqual(['unread note']);
    store.close();
  });

  describe('agentMutationCursor', () => {
    const TOKEN = 'a'.repeat(64);

    it('moves the signature when a launch-teardown reap deletes an active row (fixed clock)', () => {
      const store = new Store(dbPath(), { clock: () => 100 });
      store.joinAgent({ id: 'keeper', role: 'worker' });
      store.joinAgent({ id: 'ghost', role: 'worker', launchToken: TOKEN });
      const before = store.getChangeSignature();
      // The reaped row's last_seen is not maximal and archived_at stays NULL,
      // so no MAX/COUNT cursor observes the DELETE — only the mutation cursor.
      expect(store.reapByLaunchToken(TOKEN)).toBe(1);
      const after = store.getChangeSignature();
      expect(after.agentMutationCursor).toBeGreaterThan(before.agentMutationCursor);
      expect(after).not.toEqual(before);
      store.close();
    });

    it('moves the signature when a second Agent joins within the same clock second', () => {
      const store = new Store(dbPath(), { clock: () => 100 });
      store.joinAgent({ id: 'first', role: 'worker' });
      const before = store.getChangeSignature();
      store.joinAgent({ id: 'second', role: 'worker' }); // now == MAX(last_seen)
      const after = store.getChangeSignature();
      expect(after.maxAgentLastSeen).toBe(before.maxAgentLastSeen); // the blind spot
      expect(after.agentMutationCursor).toBeGreaterThan(before.agentMutationCursor);
      expect(after).not.toEqual(before);
      store.close();
    });

    it('moves the signature when a receive re-stamps last_seen within the same clock second', () => {
      const store = new Store(dbPath(), { clock: () => 100 });
      store.joinAgent({ id: 'worker', role: 'worker' });
      const before = store.getChangeSignature();
      store.receiveMessages('worker'); // last_seen 100 -> 100: no MAX moves
      const after = store.getChangeSignature();
      expect(after.maxAgentLastSeen).toBe(before.maxAgentLastSeen); // the blind spot
      expect(after.agentMutationCursor).toBeGreaterThan(before.agentMutationCursor);
      expect(after).not.toEqual(before);
      store.close();
    });
  });

  it('maps an unexpected failure to INTEGRITY', () => {
    const store = new Store(dbPath(), { clock: () => 0 });
    store.close();
    try {
      store.getChangeSignature();
      throw new Error('expected failure');
    } catch (err) {
      expect(err).toBeInstanceOf(CrewError);
      expect((err as CrewError).code).toBe('INTEGRITY');
    }
  });

  describe('staleLeaseCount', () => {
    function inProgressTask(now: () => number): { store: Store; id: string } {
      const store = new Store(dbPath(), { clock: now });
      addAgents(store, 'manager', 'worker', 'inspector');
      const task = store.createTask({
        creatorId: 'manager',
        assigneeId: 'worker',
        reviewerId: 'inspector',
        title: 'Add X',
      });
      store.startTask('worker', task.id); // lease_expires_at = 900
      return { store, id: task.id };
    }

    it('is zero while the Lease is unexpired', () => {
      let now = 0;
      const { store } = inProgressTask(() => now);
      now = 899;
      expect(store.getChangeSignature().staleLeaseCount).toBe(0);
      store.close();
    });

    it('becomes one exactly when the Lease crosses its expiry (inclusive)', () => {
      let now = 0;
      const { store } = inProgressTask(() => now);
      now = 900; // expiry is inclusive elsewhere in this codebase (requeue); mirror it
      expect(store.getChangeSignature().staleLeaseCount).toBe(1);
      store.close();
    });

    it('moves the overall signature, so the SSE poller would notice it', () => {
      let now = 0;
      const { store } = inProgressTask(() => now);
      const before = store.getChangeSignature();
      now = 900;
      const after = store.getChangeSignature();
      expect(after.staleLeaseCount).toBeGreaterThan(before.staleLeaseCount);
      expect(after).not.toEqual(before);
    });

    it('drops back to zero once the stale Task is requeued', () => {
      let now = 0;
      const { store, id } = inProgressTask(() => now);
      now = 900;
      expect(store.getChangeSignature().staleLeaseCount).toBe(1);
      store.requeueTask({ actorId: 'manager', taskId: id, reason: 'recover' });
      expect(store.getChangeSignature().staleLeaseCount).toBe(0);
      store.close();
    });

    it('drops back to zero once the stale Task is abandoned', () => {
      let now = 0;
      const { store, id } = inProgressTask(() => now);
      now = 900;
      expect(store.getChangeSignature().staleLeaseCount).toBe(1);
      store.abandonTask({ actorId: 'manager', taskId: id, reason: 'dead' });
      expect(store.getChangeSignature().staleLeaseCount).toBe(0);
      store.close();
    });

    it('counts multiple independently-stale Tasks', () => {
      let now = 0;
      const store = new Store(dbPath(), { clock: () => now });
      addAgents(store, 'manager', 'worker', 'worker-2', 'inspector');
      const a = store.createTask({
        creatorId: 'manager',
        assigneeId: 'worker',
        reviewerId: 'inspector',
        title: 'A',
      });
      const b = store.createTask({
        creatorId: 'manager',
        assigneeId: 'worker-2',
        reviewerId: 'inspector',
        title: 'B',
      });
      store.startTask('worker', a.id);
      store.startTask('worker-2', b.id);
      now = 900;
      expect(store.getChangeSignature().staleLeaseCount).toBe(2);
      store.close();
    });
  });
});
