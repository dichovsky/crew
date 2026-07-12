import { describe, expect, it } from 'vitest';
import { nodeRunProcess } from '../../src/process.js';

describe('nodeRunProcess', () => {
  it('captures stdout and a zero status from a successful probe', async () => {
    const result = await nodeRunProcess('node', ['--version'], { timeoutMs: 5000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^v\d+\.\d+\.\d+/);
  });

  it('reports a null status when the executable cannot be spawned', async () => {
    const result = await nodeRunProcess('crew-no-such-binary-xyzzy', ['--version'], {
      timeoutMs: 5000,
    });
    expect(result.status).toBeNull();
    expect(result.stdout).toBe('');
  });

  it('reports the child non-zero exit code as the status', async () => {
    const result = await nodeRunProcess('node', ['-e', 'process.exit(3)'], { timeoutMs: 5000 });
    expect(result.status).toBe(3);
  });

  it('reports a null status when the child exceeds the timeout', async () => {
    const result = await nodeRunProcess('node', ['-e', 'setTimeout(() => {}, 10000)'], {
      timeoutMs: 200,
    });
    expect(result.status).toBeNull();
    expect(result.killed).toBe(true);
    expect(result.signal).toBe('SIGTERM');
  });

  it('passes arguments as an array without shell interpretation', async () => {
    // The `;` and `$(...)` would be shell metacharacters under shell:true; here
    // they are an inert literal argument echoed back verbatim.
    const payload = '; echo $(whoami)';
    const result = await nodeRunProcess(
      'node',
      ['-e', 'process.stdout.write(process.argv[1])', payload],
      {
        timeoutMs: 5000,
      },
    );
    expect(result.stdout).toBe(payload);
  });
});
