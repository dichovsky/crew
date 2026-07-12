import { execa } from 'execa';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Vitest global setup: build `dist/` exactly once, sequentially, before ANY project
 * (`main` or `spawn`) starts. The spawn suite imports the compiled output directly
 * (`dist/src/run.js`, …), and the package smoke test packs it, so a clean, complete
 * build must exist before those run.
 *
 * This replaces the previous in-band rebuild inside `pack-smoke.test.ts`'s
 * `beforeAll`: because Vitest runs the `main` and `spawn` projects in parallel, that
 * destructive `rmSync(dist)` + `npm run build` raced the spawn children reading from
 * `dist/`, producing flaky import failures (a child exiting 1 instead of the expected
 * crash code) and readiness-barrier timeouts. Building here removes the race.
 *
 * The clean rebuild (remove-then-build) is preserved so a stale `.js` from a deleted
 * source cannot survive — `tsc` does not prune outputs for removed inputs.
 */
const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export default async function setup(): Promise<void> {
  rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
  await execa('npm', ['run', 'build'], { cwd: projectRoot });
}
