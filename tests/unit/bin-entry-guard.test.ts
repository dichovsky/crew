import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execa } from 'execa';
import { mkdirSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let shouldMockThrow = false;
vi.mock('../../src/run.js', () => {
  return {
    get run() {
      if (shouldMockThrow) {
        throw new Error('Simulated import failure');
      }
      return () => Promise.resolve(0);
    },
  };
});

describe('bin/crew.ts entry guard', () => {
  // Reset the module registry before each in-process import so the guard at the
  // bottom of bin/crew.ts re-evaluates against the argv set by the current test.
  beforeEach(() => {
    vi.resetModules();
  });

  it('runs successfully when argv[1] contains vite/vitest', async () => {
    const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
    const distBin = join(projectRoot, 'dist', 'bin', 'crew.js');
    const { version } = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
      version: string;
    };

    const tempViteDir = join(tmpdir(), 'crew-vite-test-' + Math.random().toString(36).slice(2));
    mkdirSync(tempViteDir, { recursive: true });

    const symlinkPath = join(tempViteDir, 'crew.js');
    symlinkSync(distBin, symlinkPath);

    try {
      // Execute the symlink. process.argv[1] will contain "vite" in its path.
      const result = await execa('node', [symlinkPath, '--version'], { reject: false });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(version);
    } finally {
      rmSync(tempViteDir, { recursive: true, force: true });
    }
  });

  it('handles empty process.argv[1]', async () => {
    const originalArgv = process.argv;
    process.argv = ['node']; // process.argv[1] is undefined
    try {
      const mod = await import('../../bin/crew.js');
      expect(mod.main).toBeDefined();
    } finally {
      process.argv = originalArgv;
    }
  });

  it('handles nonexistent path in process.argv[1] (realpath fails)', async () => {
    const originalArgv = process.argv;
    process.argv = ['node', '/nonexistent-path-for-crew-test-xyz'];
    try {
      const mod = await import('../../bin/crew.js');
      expect(mod.main).toBeDefined();
    } finally {
      process.argv = originalArgv;
    }
  });

  it('handles main promise rejection in entry point', async () => {
    const originalArgv = process.argv;
    const targetBin = fileURLToPath(new URL('../../bin/crew.ts', import.meta.url));

    // Set argv[1] so isMainEntry() returns true and the module auto-runs on import.
    process.argv = ['node', targetBin];
    shouldMockThrow = true;

    const stderrOutput: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stderrOutput.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });

    try {
      process.exitCode = undefined;
      // Re-import (registry reset by beforeEach) to trigger the auto-run guard.
      await import('../../bin/crew.js');

      // The auto-run is fire-and-forget; give its rejection a tick to settle.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(process.exitCode).toBe(1);
      expect(stderrOutput.join('')).toContain('Simulated import failure');
    } finally {
      process.argv = originalArgv;
      shouldMockThrow = false;
      stderrSpy.mockRestore();
      process.exitCode = undefined;
    }
  });
});
