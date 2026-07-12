/**
 * Deterministic, seedable pseudo-random helpers for reproducible
 * contention runs. Production never uses these — the real {@link Io}
 * wires `Math.random`; only tests and the test-only fault build inject a seeded
 * stream so a flaky stress failure can be replayed exactly from a recorded seed.
 *
 * `mulberry32` is a tiny, well-known 32-bit generator: fast, dependency-free,
 * and fully determined by its seed.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Derive `count` independent generators from one master seed, so each process
 * in a multi-process contention run gets its own reproducible stream while the
 * whole run is pinned by a single recorded number.
 */
export function deriveStreams(masterSeed: number, count: number): Array<() => number> {
  const seeder = mulberry32(masterSeed);
  return Array.from({ length: count }, () => mulberry32(Math.floor(seeder() * 0x100000000)));
}
