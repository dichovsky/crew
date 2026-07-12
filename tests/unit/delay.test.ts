import { describe, expect, it } from 'vitest';
import { realDelay } from '../../src/delay.js';

describe('realDelay', () => {
  it('resolves after the requested delay', async () => {
    const start = process.hrtime.bigint();
    await realDelay(5);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    // Resolves (does not hang) and waits at least a few ms — the exact figure is
    // scheduler-dependent, so only a loose lower bound is asserted.
    expect(elapsedMs).toBeGreaterThanOrEqual(1);
  });

  it('resolves immediately for a zero delay', async () => {
    await expect(realDelay(0)).resolves.toBeUndefined();
  });
});
