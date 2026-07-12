import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The forced-contention iteration count, shared by every spawn contention suite
 * so one knob (`CREW_STRESS_ITERS`) scales them together. A modest default keeps
 * the normal `npm test` fast; the two-tier CI sets a small fast-tier count on
 * every PR and the full hundreds-of-iterations count on the nightly/release job.
 */
export function stressIterations(): number {
  const raw = process.env.CREW_STRESS_ITERS;
  if (raw === undefined) return 8;
  const value = Number(raw);
  // Fail fast: an invalid value must not silently turn the races into no-ops
  // (NaN -> zero loops, false green) or hang the suite (Infinity).
  if (!Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new Error(`CREW_STRESS_ITERS must be a positive integer in 1..100000; got "${raw}"`);
  }
  return value;
}

/**
 * Per-test timeout that scales with the iteration count: each forced-contention
 * iteration spawns real processes (~0.5s on CI), so the full 500/case tier needs
 * far more than the 120s default. Floor of 120s keeps the fast tier unchanged.
 */
export function stressTimeoutMs(): number {
  return Math.max(120_000, stressIterations() * 2000);
}

/**
 * Inline JS (spliced into the `--eval` contention child scripts) that builds a
 * seeded `random` for the child's Io from `CREW_STRESS_SEED` (default 1) and the
 * child's unique, deterministic `ready`-path basename. Distinct streams per child,
 * and the same seed replays the same jitter — so a failing stress run is
 * reproducible by re-running with the recorded `CREW_STRESS_SEED`. Requires the
 * child to have a `ready` path variable in scope.
 */
export const SEEDED_RANDOM_SNIPPET = `
  const __seedBase = Number(process.env.CREW_STRESS_SEED ?? '1') >>> 0;
  const __fnv = (str) => {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };
  let __seed = (__seedBase ^ __fnv(String(ready).split('/').pop())) >>> 0;
  const random = () => { __seed = (__seed * 1664525 + 1013904223) >>> 0; return __seed / 4294967296; };
`;

/** The configured jitter seed (default 1); recorded so a failure replays the same jitter. */
function stressSeed(): number {
  const raw = process.env.CREW_STRESS_SEED;
  if (raw === undefined) return 1;
  const value = Number(raw);
  // Fail fast: an invalid value must not silently coerce to 0 (NaN >>> 0) and
  // report an unseeded run as the configured one.
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`CREW_STRESS_SEED must be a non-negative integer; got "${raw}"`);
  }
  return value >>> 0;
}

/** The directory stress.yml uploads on failure (`tests/spawn/__artifacts__/`). */
function stressArtifactDir(): string {
  // this file is tests/helpers/stress.ts → tests/spawn/__artifacts__
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'spawn', '__artifacts__');
}

/** The minimal shape of a vitest test context this helper reads (name + pass/fail). */
export interface StressTaskContext {
  readonly task: {
    readonly name: string;
    readonly result?: {
      readonly state?: string;
      readonly errors?: readonly { readonly message?: string }[];
    };
  };
}

/** Extra post-mortem detail a suite may attach (e.g. realized per-iteration timings). */
export interface StressFailureInfo {
  /** Temp workspace dirs created this test; the last is the failing iteration's. */
  readonly made: readonly string[];
  /** Optional realized timing samples, e.g. per-iteration wall-clock ms. */
  readonly timings?: Readonly<Record<string, unknown>>;
}

/**
 * On a FAILED forced-contention test, populate the artifact directory that
 * stress.yml already uploads. Emits a JSON post-mortem (the seed — which replays
 * the seeded retry jitter deterministically — plus iterations, platform, node,
 * error, and any realized timings) and a copy of the failing workspace's SQLite
 * database with its WAL/SHM sidecars. A no-op on a passing test.
 */
export function dumpStressFailure(ctx: StressTaskContext, info: StressFailureInfo): void {
  if (ctx.task.result?.state !== 'fail') return;
  const dir = stressArtifactDir();
  mkdirSync(dir, { recursive: true });
  const safe = ctx.task.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  const stamp = `${safe}-${process.pid}-${Date.now()}`;
  const dbCopied: string[] = [];
  const workspace = info.made.at(-1);
  if (workspace !== undefined) {
    const dbPath = join(workspace, '.crew', 'state', 'crew.db');
    for (const suffix of ['', '-wal', '-shm']) {
      const src = `${dbPath}${suffix}`;
      if (!existsSync(src)) continue;
      const dest = join(dir, `${stamp}.db${suffix}`);
      try {
        copyFileSync(src, dest);
        dbCopied.push(basename(dest));
      } catch {
        // best-effort: a DB copy failure must not mask the original test failure
      }
    }
  }
  const meta = {
    case: ctx.task.name,
    error: ctx.task.result?.errors?.[0]?.message ?? null,
    seed: stressSeed(),
    iterations: stressIterations(),
    platform: `${process.platform}/${process.arch}`,
    node: process.version,
    timestamp: new Date().toISOString(),
    db_copied: dbCopied,
    ...(info.timings !== undefined ? { timings: info.timings } : {}),
  };
  writeFileSync(join(dir, `${stamp}.json`), `${JSON.stringify(meta, null, 2)}\n`);
}
