/**
 * Branch-coverage edge cases for the real process seams in `src/process.ts`.
 *
 * The sibling `tests/unit/process.test.ts` and `tests/spawn/run-interactive.test.ts`
 * already cover the common paths (zero / non-zero exit, ENOENT spawn failure,
 * timeout). This file targets the remaining branch lines with real, fixture-free
 * `node -e` children:
 *
 *  - `nodeRunProcess` assigning captured, NON-empty `stdout`/`stderr`
 *    (`src/process.ts` lines 33-34). No existing test asserts a captured,
 *    non-empty stderr alongside stdout; every prior probe leaves stderr `''`.
 *    (Under `encoding: 'utf8'` execFile always yields string streams, so the
 *    `?? ''` fallbacks are defensive; this exercises the real capture path.)
 *  - `nodeRunInteractive` resolving through the signal arm of
 *    `code ?? (signal !== null ? 1 : 0)` (`src/process.ts` line 66). A child
 *    terminated by a signal reports `code === null`, so the fallback runs and
 *    the seam resolves `1` instead of throwing.
 *
 * These functions take no `Io`, so there is no clock or `random` to inject; the
 * children are deterministic and no temp files are allocated (nothing to clean).
 */
import { describe, expect, it } from 'vitest';
import { nodeRunInteractive, nodeRunProcess } from '../../src/process.js';

describe('nodeRunProcess captured streams', () => {
  it('captures non-empty stdout and stderr together from a successful probe', async () => {
    const result = await nodeRunProcess(
      process.execPath,
      ['-e', 'process.stdout.write("out-data"); process.stderr.write("err-data")'],
      { timeoutMs: 5000 },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('out-data');
    expect(result.stderr).toBe('err-data');
  });
});

describe('nodeRunInteractive signal termination', () => {
  it('resolves 1 when the child is terminated by a signal', async () => {
    const code = await nodeRunInteractive(process.execPath, [
      '-e',
      'process.kill(process.pid, "SIGTERM")',
    ]);
    expect(code).toBe(1);
  });
});
