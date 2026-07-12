import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Store } from '../../src/store/index.js';

// Proves end-to-end at the Store layer: the contention retry path
// actually draws from the injected `random` (io.random), not Math.random.
// A synthetic SQLITE_BUSY is injected via the existing onTransactionStep seam so
// the test is fast and deterministic — no real lock wait. This test FAILS if the
// jitter is reverted to Math.random (the spy is never consumed).

const made: string[] = [];
afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-retry-'));
  made.push(dir);
  return join(dir, 'crew.db');
}

describe('Store contention retry consumes the injected randomness', () => {
  it('draws from the injected random exactly once after a SQLITE_BUSY, never on an uncontended read', () => {
    const path = freshDbPath();
    const setup = new Store(path, { clock: () => 0 });
    setup.joinAgent({ id: 'manager', role: 'manager' });
    setup.joinAgent({ id: 'worker', role: 'worker' });
    setup.joinAgent({ id: 'inspector', role: 'inspector' });
    const id = setup.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'retry-probe',
    }).id;
    setup.close();

    let busyThrown = false;
    const randomDraws: number[] = [];
    const store = new Store(path, {
      clock: () => 0,
      // Returns 0 → backoffMs() = the 25ms minimum (one short retry wait).
      random: () => {
        randomDraws.push(0);
        return 0;
      },
      onTransactionStep: (label) => {
        if (label === 'show:after-task' && !busyThrown) {
          busyThrown = true;
          const err = new Error('database is locked') as Error & { errcode?: number };
          err.errcode = 5; // SQLITE_BUSY — recognised by the Store's isBusy()
          throw err;
        }
      },
    });

    // Contended read: first attempt throws BUSY → retry draws the jitter once →
    // second attempt (onStep now inert) succeeds.
    const contended = store.getTaskWithEvents(id);
    expect(busyThrown).toBe(true);
    expect(contended.task?.id).toBe(id);
    expect(randomDraws).toHaveLength(1);

    // Uncontended read: no BUSY, so the jitter source is not consumed again.
    const calm = store.getTaskWithEvents(id);
    expect(calm.task?.id).toBe(id);
    expect(randomDraws).toHaveLength(1);

    store.close();
  });
});
