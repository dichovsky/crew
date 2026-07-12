import { describe, expect, it } from 'vitest';

import { backoffMs } from '../../src/store/index.js';
import { deriveStreams, mulberry32 } from '../helpers/prng.js';

// The contention retry jitter must be a pure function of an injected
// randomness source, so a seeded run replays the exact same waits.
describe('backoffMs (seeded contention jitter)', () => {
  it('maps the low end of the random source to the minimum wait', () => {
    expect(backoffMs(() => 0)).toBe(25);
  });

  it('maps the high end to the maximum wait (bounded, never exceeds 100ms)', () => {
    expect(backoffMs(() => 0.9999999)).toBe(100);
  });

  it('is a deterministic function of the source value', () => {
    // 25 + floor(0.5 * 76) = 25 + 38 = 63
    expect(backoffMs(() => 0.5)).toBe(63);
  });

  it('stays within the documented 25-100ms band across the unit interval', () => {
    const rng = mulberry32(12345);
    for (let i = 0; i < 1000; i++) {
      const ms = backoffMs(rng);
      expect(ms).toBeGreaterThanOrEqual(25);
      expect(ms).toBeLessThanOrEqual(100);
    }
  });
});

describe('seeded PRNG (replayable streams)', () => {
  it('produces the same sequence for the same seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = Array.from({ length: 5 }, mulberry32(1));
    const b = Array.from({ length: 5 }, mulberry32(2));
    expect(a).not.toEqual(b);
  });

  it('derives independent, reproducible per-process streams from one master seed', () => {
    const first = deriveStreams(999, 3).map((s) => s());
    const second = deriveStreams(999, 3).map((s) => s());
    expect(first).toEqual(second);
    // The three derived streams are distinct from one another.
    expect(new Set(first).size).toBe(3);
  });
});
