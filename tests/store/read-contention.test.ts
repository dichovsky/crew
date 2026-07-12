/* eslint-disable */
/**
 * FR-I10: a transient SQLITE_BUSY/LOCKED raised inside ANY plain Store
 * read accessor must be retried once with bounded jitter and then surface as
 * CONTENTION — never as INTEGRITY, which the CLI contract frames as a Store
 * corruption signal. The mocked node:sqlite driver injects a synthetic
 * `Error { errcode: 5 }` (SQLITE_BUSY) at prepare time, the same classification
 * seam `isBusy()` reads in production.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

interface BusyInjection {
  /** How many further prepares should raise the synthetic SQLITE_BUSY. */
  remaining: number;
}

vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:sqlite')>();
  class MockDatabaseSync extends actual.DatabaseSync {
    constructor(...args: any[]) {
      super(...(args as [any, any]));
      const originalPrepare = this.prepare;
      this.prepare = (sql: string) => {
        const injection = (globalThis as any).busyInjection as BusyInjection | null;
        if (injection && injection.remaining > 0) {
          injection.remaining--;
          const err = new Error('database is locked') as Error & { errcode?: number };
          err.errcode = 5; // SQLITE_BUSY — recognised by the Store's isBusy()
          throw err;
        }
        return originalPrepare.call(this, sql);
      };
    }
  }
  return { ...actual, DatabaseSync: MockDatabaseSync };
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewError } from '../../src/errors.js';
import { Store } from '../../src/store/index.js';

const made: string[] = [];

afterEach(() => {
  (globalThis as any).busyInjection = null;
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

/** A Store seeded with the three Roles and one queued Task; injection disarmed. */
function seededStore(): { store: Store; taskId: string } {
  (globalThis as any).busyInjection = null;
  const dir = mkdtempSync(join(tmpdir(), 'crew-read-busy-'));
  made.push(dir);
  const store = new Store(join(dir, 'crew.db'), { clock: () => 0, random: () => 0 });
  for (const id of ['manager', 'worker', 'inspector']) store.joinAgent({ id, role: id });
  const task = store.createTask({
    creatorId: 'manager',
    assigneeId: 'worker',
    reviewerId: 'inspector',
    title: 'Add X',
  });
  return { store, taskId: task.id };
}

function expectContention(fn: () => unknown): void {
  try {
    fn();
    throw new Error('expected failure');
  } catch (err) {
    expect(err).toBeInstanceOf(CrewError);
    expect((err as CrewError).code).toBe('CONTENTION');
  }
}

const READS: ReadonlyArray<[string, (store: Store, taskId: string) => unknown]> = [
  ['getAgent', (store) => store.getAgent('worker')],
  ['listAgents', (store) => store.listAgents()],
  ['listPendingMessages', (store) => store.listPendingMessages()],
  ['getPendingSummary', (store) => store.getPendingSummary('worker')],
  ['listMessageHistory', (store) => store.listMessageHistory()],
  ['getTask', (store, taskId) => store.getTask(taskId)],
  ['listTasks', (store) => store.listTasks()],
  ['listStaleLeaseTasks', (store) => store.listStaleLeaseTasks()],
  ['getTaskEvents', (store, taskId) => store.getTaskEvents(taskId)],
];

describe('Store read accessors under SQLITE_BUSY (FR-I10)', () => {
  for (const [name, read] of READS) {
    it(`${name} surfaces CONTENTION (not INTEGRITY) when the lock persists past the retry`, () => {
      const { store, taskId } = seededStore();
      (globalThis as any).busyInjection = { remaining: Number.POSITIVE_INFINITY };
      expectContention(() => read(store, taskId));
      // Once the lock clears, the same read succeeds untouched.
      (globalThis as any).busyInjection = null;
      expect(() => read(store, taskId)).not.toThrow();
      store.close();
    });
  }

  it('retries once and succeeds when the lock clears before the second attempt', () => {
    const { store, taskId } = seededStore();
    (globalThis as any).busyInjection = { remaining: 1 };
    expect(store.getTask(taskId)?.id).toBe(taskId);
    store.close();
  });
});
