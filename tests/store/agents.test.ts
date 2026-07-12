import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewError } from '../../src/errors.js';
import { Store } from '../../src/store/index.js';

const made: string[] = [];

function create(clock: () => number): { store: Store; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'crew-agents-'));
  made.push(dir);
  const path = join(dir, 'crew.db');
  return { store: new Store(path, { clock }), path };
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
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('Store Agent joins', () => {
  it('allocates the requested id, then sequential suffixes', () => {
    const { store } = create(() => 10);
    expect(store.joinAgent({ id: 'worker', role: 'worker' }).id).toBe('worker');
    expect(store.joinAgent({ id: 'worker', role: 'worker' }).id).toBe('worker-2');
    expect(store.joinAgent({ id: 'worker', role: 'worker' }).id).toBe('worker-3');
    expect(store.listAgents().map((agent) => agent.id)).toEqual(['worker', 'worker-2', 'worker-3']);
    store.close();
  });

  it('reports exhaustion after the requested id and -2 through -99 are reserved', () => {
    const { store } = create(() => 0);
    for (let i = 0; i < 99; i++) store.joinAgent({ id: 'worker', role: 'worker' });
    expectCode(() => store.joinAgent({ id: 'worker', role: 'worker' }), 'ALREADY_EXISTS');
    expect(store.listAgents()).toHaveLength(99);
    store.close();
  });

  it('treats archived and overlong suffix candidates as unavailable', () => {
    const { store } = create(() => 0);
    store.joinAgent({ id: 'worker', role: 'worker' });
    store.leaveAgent('worker');
    expect(store.joinAgent({ id: 'worker', role: 'worker' }).id).toBe('worker-2');

    const long = 'x'.repeat(64);
    expect(store.joinAgent({ id: long, role: 'worker' }).id).toBe(long);
    expectCode(() => store.joinAgent({ id: long, role: 'worker' }), 'ALREADY_EXISTS');
    store.close();
  });

  it('validates ids and Participant platform ids before a write', () => {
    const { store } = create(() => 0);
    expectCode(() => store.joinAgent({ id: '@all', role: 'worker' }), 'USAGE');
    expectCode(
      () =>
        store.joinAgent({
          id: 'worker',
          role: 'worker',
          platformId: 'unknown' as 'codex-cli',
        }),
      'UNSUPPORTED_PLATFORM',
    );
    expect(store.listAgents()).toEqual([]);
    store.close();
  });

  it('supports the Store-level default Role and rejects invalid role length/clock values', () => {
    const { store } = create(() => 0);
    expect(store.joinAgent({ id: 'worker' }).role).toBe('worker');
    expectCode(() => store.joinAgent({ id: 'manager', role: '' }), 'USAGE');
    expectCode(() => store.joinAgent({ id: 'manager', role: '\0' }), 'INTEGRITY');
    expect(store.getAgent('manager')).toBeNull();
    expect(store.getAgent('missing')).toBeNull();
    store.close();

    const invalid = create(() => Number.NaN).store;
    expectCode(() => invalid.listAgents(), 'INTEGRITY');
    invalid.close();
  });
});

describe('Store resume and leave', () => {
  it('preserves Role/join time/platform unless platform is explicitly replaced', () => {
    let now = 10;
    const { store } = create(() => now);
    store.joinAgent({ id: 'worker', role: 'worker', platformId: 'codex-cli' });
    now = 20;
    const archived = store.leaveAgent('worker');
    expect(archived).toMatchObject({
      joinedAt: 10,
      lastSeen: 10,
      archivedAt: 20,
      activity: 'archived',
    });
    now = 30;
    expect(store.joinAgent({ id: 'worker', resume: true })).toMatchObject({
      role: 'worker',
      platformId: 'codex-cli',
      joinedAt: 10,
      lastSeen: 30,
      archivedAt: null,
    });
    now = 40;
    store.leaveAgent('worker');
    now = 50;
    expect(
      store.joinAgent({ id: 'worker', resume: true, platformId: 'gemini-cli' }).platformId,
    ).toBe('gemini-cli');
    store.close();
  });

  it('rejects missing/active resume, Role conflict, missing leave, and repeated leave', () => {
    const { store } = create(() => 0);
    expectCode(() => store.joinAgent({ id: 'missing', resume: true }), 'NOT_FOUND');
    store.joinAgent({ id: 'worker', role: 'worker' });
    expectCode(() => store.joinAgent({ id: 'worker', resume: true }), 'ALREADY_EXISTS');
    expectCode(() => store.leaveAgent('missing'), 'NOT_FOUND');
    store.leaveAgent('worker');
    expectCode(
      () => store.joinAgent({ id: 'worker', role: 'manager', resume: true }),
      'ALREADY_EXISTS',
    );
    expect(store.getAgent('worker')?.status).toBe('archived');
    expectCode(() => store.leaveAgent('worker'), 'AGENT_INACTIVE');
    store.close();
    store.close();
  });
});

describe('Store listing and activity', () => {
  it('orders by id, filters archived rows, and applies exact activity boundaries', () => {
    let now = 0;
    const { store } = create(() => now);
    store.joinAgent({ id: 'stale', role: 'worker' });
    now = 1;
    store.joinAgent({ id: 'idle-under', role: 'worker' });
    now = 1500;
    store.joinAgent({ id: 'idle-boundary', role: 'worker' });
    now = 1501;
    store.joinAgent({ id: 'recent', role: 'worker' });
    now = 1800;

    expect(
      Object.fromEntries(store.listAgents().map((agent) => [agent.id, agent.activity])),
    ).toEqual({
      'idle-boundary': 'idle',
      'idle-under': 'idle',
      recent: 'recent',
      stale: 'stale',
    });
    store.leaveAgent('idle-boundary');
    expect(store.listAgents().map((agent) => agent.id)).not.toContain('idle-boundary');
    const all = store.listAgents({ includeArchived: true });
    expect(all.map((agent) => agent.id)).toEqual([
      'idle-boundary',
      'idle-under',
      'recent',
      'stale',
    ]);
    expect(all[0]?.activity).toBe('archived');
    store.close();
  });

  it('counts expired in-progress Leases owned by each Agent', () => {
    const { store, path } = create(() => 100);
    store.joinAgent({ id: 'worker', role: 'worker' });
    store.joinAgent({ id: 'manager', role: 'manager' });
    store.close();

    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare(
      `INSERT INTO tasks
        (id, title, creator_id, assignee_id, reviewer_id, status,
         lease_owner_id, lease_expires_at, created_at, updated_at)
       VALUES ('task', 'Test', 'manager', 'worker', 'manager', 'in_progress',
               'worker', 100, 100, 100)`,
    ).run();
    db.close();

    const reopened = new Store(path, { clock: () => 100 });
    expect(reopened.getAgent('worker')?.staleLeaseCount).toBe(1);
    expect(reopened.getAgent('manager')?.staleLeaseCount).toBe(0);
    reopened.close();
  });

  it('maps getAgent and listAgents SQLite errors on closed connection to INTEGRITY', () => {
    const { store } = create(() => 0);
    store.close();
    expectCode(() => store.getAgent('worker'), 'INTEGRITY');
    expectCode(() => store.listAgents(), 'INTEGRITY');
  });
});
