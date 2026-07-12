/**
 * Spawn-level proof for the {@link Io.runInteractive} seam.
 * It must spawn a real child with an argument array (no shell), inherit stdio,
 * resolve with the child's exit code, and never throw — even for a missing
 * executable. We use `node -e` children so the test needs no fixture binary.
 */
import { describe, expect, it } from 'vitest';
import { nodeRunInteractive } from '../../src/process.js';

describe('nodeRunInteractive', () => {
  it('resolves with a child zero exit code', async () => {
    const code = await nodeRunInteractive(process.execPath, ['-e', 'process.exit(0)']);
    expect(code).toBe(0);
  });

  it("resolves with the child's non-zero exit code", async () => {
    const code = await nodeRunInteractive(process.execPath, ['-e', 'process.exit(7)']);
    expect(code).toBe(7);
  });

  it('resolves non-zero for a spawn failure instead of throwing', async () => {
    const code = await nodeRunInteractive('crew-no-such-binary-xyz', ['attach']);
    expect(code).not.toBe(0);
  });

  it('passes arguments as an array with no shell interpolation', async () => {
    // A shell would expand `$(...)`; with shell:false the literal string is just
    // an argv element, so printing it yields the unexpanded text.
    const code = await nodeRunInteractive(process.execPath, [
      '-e',
      'process.exit(process.argv[1] === "$(echo 9)" ? 0 : 2)',
      '$(echo 9)',
    ]);
    expect(code).toBe(0);
  });
});
