import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/index.js';
import { diagnoseStore, readActiveAgentCount } from '../../src/store/maintenance.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/store/schema.js';

const made: string[] = [];

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-maint-'));
  made.push(dir);
  return join(dir, 'crew.db');
}

function newStore(clock: () => number): { store: Store; path: string } {
  const path = dbPath();
  return { store: new Store(path, { clock }), path };
}

function addAgents(store: Store, ...ids: string[]): void {
  for (const id of ids) store.joinAgent({ id, role: id });
}

/** Receive every unread Message for each id so task notifications become read. */
function drainAll(store: Store, ...ids: string[]): void {
  for (const id of ids) store.receiveMessages(id, 500);
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('diagnoseStore', () => {
  it('reports a healthy current-version store with no findings', () => {
    const { store, path } = newStore(() => 0);
    addAgents(store, 'manager', 'worker', 'inspector');
    store.close();

    const facts = diagnoseStore(path, 0);
    expect(facts).toEqual({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      newer: false,
      nonEmptyV0: false,
      quickCheckOk: true,
      foreignKeyOk: true,
      schemaDriftReason: null,
      staleLeases: [],
      archivedOwners: [],
    });
  });

  it('detects an expired Lease on an in_progress Task', () => {
    let now = 0;
    const { store, path } = newStore(() => now);
    addAgents(store, 'manager', 'worker', 'inspector');
    const task = store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'Add X',
    });
    now = 10;
    store.startTask('worker', task.id); // lease until 910
    store.close();

    expect(diagnoseStore(path, 500).staleLeases).toEqual([]);
    expect(diagnoseStore(path, 1000).staleLeases).toEqual([task.id]);
  });

  it('detects an archived Agent referenced by a non-completed Task', () => {
    const { store, path } = newStore(() => 0);
    addAgents(store, 'manager', 'worker', 'inspector');
    store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'Add X',
    });
    store.leaveAgent('worker');
    store.close();

    const owners = diagnoseStore(path, 0).archivedOwners;
    expect(owners).toHaveLength(1);
    expect(owners[0]?.agentId).toBe('worker');
    expect(typeof owners[0]?.taskId).toBe('string');
  });

  it('does not flag an abandoned Task whose creator/reviewer are archived (fallback path)', () => {
    const { store, path } = newStore(() => 0);
    addAgents(store, 'manager', 'worker', 'inspector', 'operator');
    const task = store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'Add X',
    });
    store.leaveAgent('manager');
    store.leaveAgent('inspector');
    // The operator-fallback path REQUIRES both archived; a successful
    // abandonment must not itself trip ARCHIVED_OWNER.
    store.abandonTask({ actorId: 'operator', taskId: task.id, reason: 'dead' });
    store.close();

    expect(diagnoseStore(path, 0).archivedOwners).toEqual([]);
  });

  it('reports schema drift when a released object diverges', () => {
    const { store, path } = newStore(() => 0);
    store.close();
    const raw = new DatabaseSync(path);
    raw.exec('DROP INDEX idx_messages_unread');
    raw.close();

    const facts = diagnoseStore(path, 0);
    expect(facts.schemaDriftReason).toContain('idx_messages_unread');
    expect(facts.staleLeases).toEqual([]);
  });

  it('flags a newer schema version', () => {
    const path = dbPath();
    const raw = new DatabaseSync(path);
    raw.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
    raw.close();
    const facts = diagnoseStore(path, 0);
    expect(facts.newer).toBe(true);
    expect(facts.schemaVersion).toBe(CURRENT_SCHEMA_VERSION + 1);
  });

  it('flags a non-empty version-0 database', () => {
    const path = dbPath();
    const raw = new DatabaseSync(path);
    raw.exec('CREATE TABLE legacy (value TEXT)');
    raw.close();
    const facts = diagnoseStore(path, 0);
    expect(facts.nonEmptyV0).toBe(true);
  });
});

describe('readActiveAgentCount', () => {
  it('counts only active Agents', () => {
    const { store, path } = newStore(() => 0);
    addAgents(store, 'manager', 'worker');
    store.leaveAgent('worker');
    store.close();
    expect(readActiveAgentCount(path)).toBe(1);
  });
});

describe('Store.pruneState', () => {
  it('deletes read Messages strictly older than the cutoff', () => {
    let now = 0;
    const { store } = newStore(() => now);
    addAgents(store, 'manager', 'worker');
    now = 100;
    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'hi' });
    now = 150;
    store.receiveMessages('worker'); // read_at = 150

    now = 1000;
    // cutoff = 1000 - 900 = 100; created_at 100 is NOT < 100 -> retained
    expect(
      store.pruneState({ messagesBeforeSeconds: 900, tasksBeforeSeconds: 90 * 86400 }),
    ).toEqual({ messagesDeleted: 0, tasksDeleted: 0 });
    // cutoff = 1000 - 899 = 101; created_at 100 < 101 -> deleted
    expect(
      store.pruneState({ messagesBeforeSeconds: 899, tasksBeforeSeconds: 90 * 86400 }),
    ).toEqual({ messagesDeleted: 1, tasksDeleted: 0 });
    store.close();
  });

  it('retains unread Messages regardless of age', () => {
    let now = 0;
    const { store } = newStore(() => now);
    addAgents(store, 'manager', 'worker');
    now = 100;
    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'unread' });
    now = 100_000;
    expect(store.pruneState({ messagesBeforeSeconds: 1, tasksBeforeSeconds: 1 })).toEqual({
      messagesDeleted: 0,
      tasksDeleted: 0,
    });
    store.close();
  });

  it('deletes a completed Task and folds its cascaded Messages into one count', () => {
    let now = 0;
    const { store } = newStore(() => now);
    addAgents(store, 'manager', 'worker', 'inspector');
    const task = store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'Add X',
    });
    now = 10;
    store.startTask('worker', task.id);
    now = 20;
    store.submitTask('worker', task.id, 'done');
    now = 30;
    store.approveTask('inspector', task.id, 'ok');
    // make every task-linked notification read
    drainAll(store, 'manager', 'worker', 'inspector');

    now = 1000;
    // huge message window so step 4 deletes nothing; only the task cascade counts
    const result = store.pruneState({
      messagesBeforeSeconds: 100_000,
      tasksBeforeSeconds: 100,
    });
    expect(result.tasksDeleted).toBe(1);
    expect(result.messagesDeleted).toBe(5); // assigned + submitted(x2) + approved(x2)
    store.close();
  });

  it('retains a completed Task while any linked Message is unread', () => {
    let now = 0;
    const { store } = newStore(() => now);
    addAgents(store, 'manager', 'worker', 'inspector');
    const task = store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'Add X',
    });
    now = 10;
    store.startTask('worker', task.id);
    now = 20;
    store.submitTask('worker', task.id, 'done');
    now = 30;
    store.approveTask('inspector', task.id, 'ok');
    // leave the assignment notification unread (do not drain worker fully)

    now = 1000;
    const result = store.pruneState({ messagesBeforeSeconds: 100_000, tasksBeforeSeconds: 100 });
    expect(result.tasksDeleted).toBe(0);
    store.close();
  });

  it('deletes an abandoned Task by its abandonedAt cutoff, same as completed', () => {
    let now = 0;
    const { store } = newStore(() => now);
    addAgents(store, 'manager', 'worker', 'inspector');
    const task = store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'Add X',
    });
    now = 10;
    store.abandonTask({ actorId: 'manager', taskId: task.id, reason: 'dead' });
    drainAll(store, 'manager', 'worker', 'inspector');

    now = 1000;
    // huge message window so step 4 deletes nothing; only the task cascade counts
    const result = store.pruneState({
      messagesBeforeSeconds: 100_000,
      tasksBeforeSeconds: 100,
    });
    expect(result.tasksDeleted).toBe(1);
    expect(store.getTask(task.id)).toBeNull();
    store.close();
  });

  it('retains an abandoned Task younger than the cutoff, proving the two-branch query binds correctly', () => {
    let now = 0;
    const { store } = newStore(() => now);
    addAgents(store, 'manager', 'worker', 'inspector');
    const task = store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'Add X',
    });
    now = 950;
    store.abandonTask({ actorId: 'manager', taskId: task.id, reason: 'dead' });
    drainAll(store, 'manager', 'worker', 'inspector');

    now = 1000;
    // abandonedAt=950 is NOT strictly before the cutoff (1000-100=900 < 950)
    const result = store.pruneState({ messagesBeforeSeconds: 100_000, tasksBeforeSeconds: 100 });
    expect(result.tasksDeleted).toBe(0);
    expect(store.getTask(task.id)).not.toBeNull();
    store.close();
  });
});

describe('Store.countActiveAgents and vacuum', () => {
  it('counts active Agents and vacuums without error', () => {
    const { store } = newStore(() => 0);
    addAgents(store, 'manager', 'worker');
    store.leaveAgent('worker');
    expect(store.countActiveAgents()).toBe(1);
    expect(() => store.vacuum()).not.toThrow();
    store.close();
  });
});
