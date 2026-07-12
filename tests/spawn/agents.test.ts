import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initWorkspace } from '../../src/init.js';
import { Store } from '../../src/store/index.js';
import { captureIo } from '../helpers/io.js';
import {
  dumpStressFailure,
  SEEDED_RANDOM_SNIPPET,
  stressIterations,
  stressTimeoutMs,
} from '../helpers/stress.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runModule = pathToFileURL(join(root, 'dist', 'src', 'run.js')).href;
const ITERATIONS = stressIterations();
const STRESS_TIMEOUT = stressTimeoutMs();
const childScript = `
  import { existsSync, writeFileSync } from 'node:fs';
  import { setTimeout as delay } from 'node:timers/promises';
  const [cwd, barrier, ready, id] = process.argv.slice(1);${SEEDED_RANDOM_SNIPPET}
  const { run } = await import(${JSON.stringify(runModule)});
  writeFileSync(ready, 'ready');
  while (!existsSync(barrier)) await delay(5);
  let stdout = '';
  let stderr = '';
  const status = await run(['join', id, '--role', 'worker', '--json'], {
    cwd, env: {}, stdin: process.stdin,
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    clock: () => 100,
    random,
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = status;
`;
const made: string[] = [];
/** Realized per-iteration contention timings, retained for the stress failure dump. */
let lastTimings: Record<string, unknown> | undefined;

function workspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-spawn-agent-'));
  made.push(cwd);
  initWorkspace(captureIo({ cwd }).io, { withGuides: false, json: false });
  return cwd;
}

function child(cwd: string, barrier: string, ready: string) {
  return execa(
    'node',
    ['--no-warnings', '--input-type=module', '--eval', childScript, cwd, barrier, ready, 'worker'],
    {
      reject: false,
      cwd: root,
    },
  );
}

async function waitUntilReady(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() >= deadline) throw new Error('child readiness barrier timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
});

afterEach((ctx) => {
  // On a failed contention run, retain the seed, realized timings, and a
  // copy of the failing workspace DB in the dir stress.yml uploads — BEFORE cleanup.
  dumpStressFailure(ctx, { made, ...(lastTimings !== undefined ? { timings: lastTimings } : {}) });
  lastTimings = undefined;
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true, maxRetries: 5 });
});

describe('forced Agent contention', () => {
  it(
    'barrier-synchronized joins allocate unique, gap-free ids',
    async () => {
      for (let iter = 0; iter < ITERATIONS; iter++) {
        const cwd = workspace();
        const barrier = join(cwd, 'start');
        const ready = Array.from({ length: 8 }, (_, index) => join(cwd, `ready-${index}`));
        const contenders = ready.map((path) => child(cwd, barrier, path));
        await waitUntilReady(ready);
        writeFileSync(barrier, 'go');

        const startedAt = Date.now();
        const results = await Promise.all(contenders);
        // Realized wall-clock of this contended batch, retained on failure.
        lastTimings = {
          iteration: iter,
          contenders: contenders.length,
          batchMs: Date.now() - startedAt,
        };
        expect(
          results
            .filter((result) => result.exitCode !== 0)
            .map((result) => ({ exitCode: result.exitCode, stderr: result.stderr })),
        ).toEqual([]);
        expect(results.map((result) => result.stderr)).toEqual(Array(8).fill(''));
        const ids = results
          .map((result) => (JSON.parse(result.stdout) as { id: string }).id)
          .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
        expect(ids).toEqual([
          'worker',
          'worker-2',
          'worker-3',
          'worker-4',
          'worker-5',
          'worker-6',
          'worker-7',
          'worker-8',
        ]);

        const db = new DatabaseSync(join(cwd, '.crew', 'state', 'crew.db'));
        expect((db.prepare('SELECT count(*) AS n FROM agents').get() as { n: number }).n).toBe(8);
        expect(db.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
        db.close();
      }
    },
    STRESS_TIMEOUT,
  );

  it(
    'returns CONTENTION after one bounded retry and leaves no partial Agent',
    async () => {
      const cwd = workspace();
      const path = join(cwd, '.crew', 'state', 'crew.db');
      new Store(path).close();
      const lock = new DatabaseSync(path);
      lock.exec('BEGIN IMMEDIATE');

      const barrier = join(cwd, 'start');
      const ready = join(cwd, 'ready');
      const contender = child(cwd, barrier, ready);
      await waitUntilReady([ready]);
      writeFileSync(barrier, 'go');
      const result = await contender;
      lock.exec('ROLLBACK');
      lock.close();

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        error: { code: 'CONTENTION' },
      });
      expect(result.stdout).toBe('');
      const db = new DatabaseSync(path);
      expect((db.prepare('SELECT count(*) AS n FROM agents').get() as { n: number }).n).toBe(0);
      expect(db.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
      db.close();
    },
    STRESS_TIMEOUT,
  );

  it(
    'retries open-time reads and maps a persistent exclusive lock to CONTENTION',
    async () => {
      const cwd = workspace();
      const path = join(cwd, '.crew', 'state', 'crew.db');
      new Store(path).close();
      const lock = new DatabaseSync(path);
      lock.exec('PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE');

      const barrier = join(cwd, 'start');
      const ready = join(cwd, 'ready');
      const contender = child(cwd, barrier, ready);
      await waitUntilReady([ready]);
      writeFileSync(barrier, 'go');
      const result = await contender;
      lock.exec('ROLLBACK');
      lock.close();

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({
        ok: false,
        error: { code: 'CONTENTION' },
      });
      expect(result.stdout).toBe('');
      const db = new DatabaseSync(path);
      expect((db.prepare('SELECT count(*) AS n FROM agents').get() as { n: number }).n).toBe(0);
      expect(db.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
      db.close();
    },
    STRESS_TIMEOUT,
  );
});
