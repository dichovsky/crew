import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store/index.js';

const made: string[] = [];

function create(clock: () => number): { store: Store; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'crew-review-worktrees-'));
  made.push(dir);
  const path = join(dir, 'crew.db');
  return { store: new Store(path, { clock }), path };
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('Store review worktrees', () => {
  it('returns null for an Agent with no review worktree yet', () => {
    const { store } = create(() => 0);
    store.joinAgent({ id: 'inspector', role: 'inspector' });
    expect(store.getReviewWorktree('inspector')).toBeNull();
    store.close();
  });

  it('creates a row on first use with a NULL current_ref (idle)', () => {
    const now = 10;
    const { store } = create(() => now);
    store.joinAgent({ id: 'inspector', role: 'inspector' });
    const created = store.createReviewWorktree({
      agentId: 'inspector',
      path: '/data/crew/worktrees/abc/review-inspector',
      baseRef: 'main',
    });
    expect(created).toEqual({
      agentId: 'inspector',
      path: '/data/crew/worktrees/abc/review-inspector',
      baseRef: 'main',
      currentRef: null,
      createdAt: 10,
      updatedAt: 10,
    });
    expect(store.getReviewWorktree('inspector')).toEqual(created);
    store.close();
  });

  it('is idempotent: a second create for the same Agent id keeps the first row (ON CONFLICT DO NOTHING)', () => {
    const { store } = create(() => 0);
    store.joinAgent({ id: 'inspector', role: 'inspector' });
    const first = store.createReviewWorktree({
      agentId: 'inspector',
      path: '/data/crew/worktrees/abc/review-inspector',
      baseRef: 'main',
    });
    const second = store.createReviewWorktree({
      agentId: 'inspector',
      path: '/data/crew/worktrees/DIFFERENT/path',
      baseRef: 'develop',
    });
    // The row that won stays exactly as first created — the second insert's
    // (different) values never overwrite it.
    expect(second).toEqual(first);
    expect(store.getReviewWorktree('inspector')).toEqual(first);
    store.close();
  });

  it('points current_ref at a Task branch, then clears it back to NULL (idle)', () => {
    let now = 0;
    const { store } = create(() => now);
    store.joinAgent({ id: 'inspector', role: 'inspector' });
    store.createReviewWorktree({
      agentId: 'inspector',
      path: '/data/crew/worktrees/abc/review-inspector',
      baseRef: 'main',
    });
    now = 50;
    expect(
      store.setReviewWorktreeCurrentRef({
        agentId: 'inspector',
        currentRef: 'crew/task-x',
        expectedCurrentRef: null,
      }),
    ).toBe(true);
    expect(store.getReviewWorktree('inspector')).toMatchObject({
      currentRef: 'crew/task-x',
      updatedAt: 50,
    });

    now = 100;
    expect(
      store.setReviewWorktreeCurrentRef({
        agentId: 'inspector',
        currentRef: null,
        expectedCurrentRef: 'crew/task-x',
      }),
    ).toBe(true);
    expect(store.getReviewWorktree('inspector')).toMatchObject({
      currentRef: null,
      updatedAt: 100,
    });
    store.close();
  });

  it('CAS: a write whose expectedCurrentRef no longer matches returns false and changes nothing', () => {
    let now = 0;
    const { store } = create(() => now);
    store.joinAgent({ id: 'inspector', role: 'inspector' });
    store.createReviewWorktree({
      agentId: 'inspector',
      path: '/data/crew/worktrees/abc/review-inspector',
      baseRef: 'main',
    });
    now = 50;
    store.setReviewWorktreeCurrentRef({
      agentId: 'inspector',
      currentRef: 'crew/task-x',
      expectedCurrentRef: null,
    });

    // A second, stale caller still expects the row to be idle (null) — it lost
    // the race to the write above, which already moved it to 'crew/task-x'.
    now = 75;
    const lostRace = store.setReviewWorktreeCurrentRef({
      agentId: 'inspector',
      currentRef: 'crew/task-y',
      expectedCurrentRef: null,
    });
    expect(lostRace).toBe(false);
    // Untouched by the losing call: still task-x, updatedAt still 50.
    expect(store.getReviewWorktree('inspector')).toMatchObject({
      currentRef: 'crew/task-x',
      updatedAt: 50,
    });
    store.close();
  });

  it('keys review worktrees independently per Agent id', () => {
    const { store } = create(() => 0);
    store.joinAgent({ id: 'inspector', role: 'inspector' });
    store.joinAgent({ id: 'inspector-2', role: 'inspector' });
    store.createReviewWorktree({
      agentId: 'inspector',
      path: '/data/crew/worktrees/abc/review-inspector',
      baseRef: 'main',
    });
    expect(store.getReviewWorktree('inspector-2')).toBeNull();
    expect(store.getReviewWorktree('inspector')).not.toBeNull();
    store.close();
  });
});
