/**
 * Focused edge-branch coverage for `src/store/index.ts`. Each it() targets a
 * specific previously-uncovered branch and is deterministic: a fixed clock and
 * seeded randomness are injected, and no assertion depends on wall-clock time or
 * Math.random.
 *
 * Two listed lines are intentionally NOT exercised here because they require
 * genuine multi-process concurrency and cannot be reached deterministically
 * inside a single synchronous process (the constructor never yields the event
 * loop, so nothing can mutate the file between its two version reads):
 *   - index.ts:245 / index.ts:246 — the concurrent-initializer race inside the
 *     EXCLUSIVE schema-init transaction, where another process commits the schema
 *     between this connection's initial version read and its exclusive lock.
 *     That path is covered by the spawn/ subprocess tier.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewError } from '../../src/errors.js';
import { openWorkspaceStore, Store } from '../../src/store/index.js';

/** A syntactically valid UUIDv4 Task id that never matches a stored Task. */
const ABSENT_TASK_ID = '00000000-0000-4000-8000-000000000000';

const made: string[] = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function dbPath(): string {
  return join(freshDir('crew-index-edge-'), 'crew.db');
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

/** An onStep seam that raises a synthetic, retryable SQLITE_BUSY at one label. */
function busyAt(label: string): (seen: string) => void {
  return (seen: string) => {
    if (seen === label) {
      const err = new Error('database is locked') as Error & { errcode?: number };
      err.errcode = 5; // SQLITE_BUSY — recognised by the Store's isBusy()
      throw err;
    }
  };
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('Store constructor defaults', () => {
  it('falls back to the built-in clock and randomness when neither is injected', () => {
    // No options object at all → exercises the `?? built-in` clock/random defaults.
    const store = new Store(dbPath());
    expect(store.joinAgent({ id: 'solo', role: 'solo' }).id).toBe('solo');
    expect(store.listAgents().map((agent) => agent.id)).toEqual(['solo']);
    store.close();
  });
});

describe('openWorkspaceStore transaction-step threading', () => {
  it('passes an injected transaction step through to the constructed Store', () => {
    const root = freshDir('crew-index-ws-');
    const store = openWorkspaceStore(
      root,
      () => 0,
      () => 0,
      () => {},
    );
    // The Store opened below root/.crew/state and is usable.
    expect(store.listAgents()).toEqual([]);
    store.close();
  });
});

describe('Store input-guard branches', () => {
  it('rejects a non-positive or non-integer reply-to before opening a transaction', () => {
    const store = new Store(dbPath(), { clock: () => 0 });
    // Valid ids/content reach the reply-to guard; the reply-to ids are the fault.
    expectCode(
      () =>
        store.sendMessages({
          senderId: 'manager',
          recipientId: 'worker',
          content: 'x',
          replyTo: 0,
        }),
      'USAGE',
    );
    expectCode(
      () =>
        store.sendMessages({
          senderId: 'manager',
          recipientId: 'worker',
          content: 'x',
          replyTo: 1.5,
        }),
      'USAGE',
    );
    store.close();
  });

  it('rejects a non-integer history "since" bound', () => {
    const store = new Store(dbPath(), { clock: () => 0 });
    expectCode(() => store.listMessageHistory({ since: 1.5 }), 'USAGE');
    store.close();
  });

  it('rejects a retention window that leaves the safe-integer range', () => {
    const store = new Store(dbPath(), { clock: () => 0 });
    // now(0) - 0.5 = -0.5 → not a safe integer → INTEGRITY, before any transaction.
    expectCode(
      () => store.pruneState({ messagesBeforeSeconds: 0.5, tasksBeforeSeconds: 1 }),
      'INTEGRITY',
    );
    store.close();
  });
});

describe('Store getTaskWithEvents branches', () => {
  it('returns empty Events for a well-formed id that has no Task', () => {
    const store = new Store(dbPath(), { clock: () => 0, random: () => 0 });
    expect(store.getTaskWithEvents(ABSENT_TASK_ID)).toEqual({ task: null, events: [] });
    store.close();
  });

  it('surfaces CONTENTION and rolls back after two synthetic SQLITE_BUSY attempts', () => {
    const store = new Store(dbPath(), {
      clock: () => 0,
      random: () => 0, // backoffMs → the fixed 25ms minimum wait
      onTransactionStep: busyAt('show:after-task'),
    });
    // Both retry attempts hit the injected BUSY (each rolls the read tx back),
    // exhausting the single retry and surfacing CONTENTION.
    expectCode(() => store.getTaskWithEvents(ABSENT_TASK_ID), 'CONTENTION');
    store.close();
  });
});

describe('Store liveness and idle-clean guards', () => {
  it('fails a write with STALE_STORE when the database file is replaced under it', () => {
    const path = dbPath();
    const store = new Store(path, { clock: () => 0, random: () => 0 });
    // Replace the backing file with a fresh inode. The open connection keeps its
    // original fds, so BEGIN IMMEDIATE still runs, but the post-lock identity
    // check sees a different inode than the one recorded at open.
    rmSync(path);
    writeFileSync(path, '');
    expectCode(() => store.joinAgent({ id: 'worker', role: 'worker' }), 'STALE_STORE');
    try {
      store.close();
    } catch {
      /* the backing file was replaced out from under the connection */
    }
  });

  it('fails Console-facing reads with STALE_STORE after the file is deleted (FR-U32)', () => {
    const path = dbPath();
    const store = new Store(path, { clock: () => 0, random: () => 0 });
    store.joinAgent({ id: 'worker', role: 'worker' });
    // Reads work while live; after external deletion every Console-facing
    // read fails deliberately through the shared inode check — not with a
    // timing-dependent driver error.
    expect(store.getChangeSignature().maxAgentLastSeen).toBeGreaterThanOrEqual(0);
    rmSync(path);
    expectCode(() => store.getChangeSignature(), 'STALE_STORE');
    expectCode(() => store.listAgents(), 'STALE_STORE');
    expectCode(() => store.getPendingSummary('worker'), 'STALE_STORE');
    expectCode(() => store.listTasks(), 'STALE_STORE');
    expectCode(() => store.getTaskWithEvents(ABSENT_TASK_ID), 'STALE_STORE');
    expectCode(() => store.listMessageHistory(), 'STALE_STORE');
    expectCode(() => store.assertLive(), 'STALE_STORE');
    try {
      store.close();
    } catch {
      /* the backing file was removed out from under the connection */
    }
  });

  it('fails a read with STALE_STORE when the file is REPLACED (new inode), like the write path', () => {
    const path = dbPath();
    const store = new Store(path, { clock: () => 0, random: () => 0 });
    rmSync(path);
    writeFileSync(path, '');
    expectCode(() => store.getChangeSignature(), 'STALE_STORE');
    try {
      store.close();
    } catch {
      /* replaced under the connection */
    }
  });

  it('re-raises ACTIVE_AGENTS from cleanWhileIdle without remapping it to INTEGRITY', () => {
    const store = new Store(dbPath(), { clock: () => 0, random: () => 0 });
    store.joinAgent({ id: 'worker', role: 'worker' });
    let unlinkCalled = false;
    expectCode(
      () =>
        store.cleanWhileIdle(() => {
          unlinkCalled = true;
          return ['crew.db'];
        }),
      'ACTIVE_AGENTS',
    );
    expect(unlinkCalled).toBe(false); // the active-Agent guard fires before any unlink
    store.close();
  });
});
