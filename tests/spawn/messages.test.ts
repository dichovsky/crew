import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
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
  const [cwd, barrier, ready, argvJson] = process.argv.slice(1);${SEEDED_RANDOM_SNIPPET}
  const { run } = await import(${JSON.stringify(runModule)});
  writeFileSync(ready, 'ready');
  while (!existsSync(barrier)) await delay(5);
  let stdout = '';
  let stderr = '';
  const status = await run(JSON.parse(argvJson), {
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

/**
 * Case 7 (receive crash window): crash in stdout AFTER receiveMessages() commits
 * the read but BEFORE the output is delivered. Proves the documented at-most-once
 * loss window — the Message is marked read yet remains in history.
 */
const receiveCrashScript = `
  const [cwd, argvJson] = process.argv.slice(1);
  const { run } = await import(${JSON.stringify(runModule)});
  let fired = false;
  await run(JSON.parse(argvJson), {
    cwd, env: {}, stdin: process.stdin,
    stdout: () => { if (!fired) { fired = true; process.exit(137); } },
    stderr: () => {},
    clock: () => 100,
    random: () => 0.5,
  });
`;
const made: string[] = [];

function workspace(): { cwd: string; store: Store } {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-spawn-message-'));
  made.push(cwd);
  initWorkspace(captureIo({ cwd }).io, { withGuides: false, json: false });
  const store = new Store(join(cwd, '.crew', 'state', 'crew.db'), { clock: () => 0 });
  store.joinAgent({ id: 'manager', role: 'manager' });
  store.joinAgent({ id: 'worker', role: 'worker' });
  return { cwd, store };
}

function child(cwd: string, barrier: string, ready: string, argv: readonly string[]) {
  return execa(
    'node',
    [
      '--no-warnings',
      '--input-type=module',
      '--eval',
      childScript,
      cwd,
      barrier,
      ready,
      JSON.stringify(argv),
    ],
    { reject: false, cwd: root },
  );
}

async function waitUntilReady(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() >= deadline) throw new Error('child readiness barrier timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function jsonLines(output: string): Array<Record<string, unknown>> {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
});

afterEach((ctx) => {
  dumpStressFailure(ctx, { made }); // retain seed + failing DB copy on failure
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true, maxRetries: 5 });
});

describe('forced Message contention (FR-D13/D14)', () => {
  it(
    'commits barrier-synchronized sends with unique ids and complete history',
    async () => {
      for (let iter = 0; iter < ITERATIONS; iter++) {
        const { cwd, store } = workspace();
        store.close();
        const barrier = join(cwd, 'start');
        const ready = Array.from({ length: 8 }, (_, index) => join(cwd, `ready-${index}`));
        const contenders = ready.map((path, index) =>
          child(cwd, barrier, path, ['send', 'manager', 'worker', `message-${index}`, '--json']),
        );
        await waitUntilReady(ready);
        writeFileSync(barrier, 'go');
        const results = await Promise.all(contenders);
        expect(results.map((result) => result.exitCode)).toEqual(Array(8).fill(0));
        expect(results.map((result) => result.stderr)).toEqual(Array(8).fill(''));
        const ids = results.map((result) => Number(jsonLines(result.stdout)[0]?.id));
        expect(new Set(ids).size).toBe(8);

        const reopened = new Store(join(cwd, '.crew', 'state', 'crew.db'));
        expect(reopened.listMessageHistory({ limit: 100 })).toHaveLength(8);
        reopened.close();
        const db = new DatabaseSync(join(cwd, '.crew', 'state', 'crew.db'));
        expect(db.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
        db.close();
      }
    },
    STRESS_TIMEOUT,
  );

  it(
    'partitions a fixed Inbox across simultaneous receivers without duplicate ids',
    async () => {
      for (let iter = 0; iter < ITERATIONS; iter++) {
        const { cwd, store } = workspace();
        for (let index = 0; index < 24; index++) {
          store.sendMessages({
            senderId: 'manager',
            recipientId: 'worker',
            content: String(index),
          });
        }
        store.close();
        const barrier = join(cwd, 'start');
        const ready = Array.from({ length: 4 }, (_, index) => join(cwd, `ready-${index}`));
        const contenders = ready.map((path) =>
          child(cwd, barrier, path, ['receive', 'worker', '--limit', '500', '--json']),
        );
        await waitUntilReady(ready);
        writeFileSync(barrier, 'go');
        const results = await Promise.all(contenders);
        expect(results.map((result) => result.exitCode)).toEqual(Array(4).fill(0));
        expect(results.map((result) => result.stderr)).toEqual(Array(4).fill(''));
        const ids = results.flatMap((result) =>
          jsonLines(result.stdout).map((row) => Number(row.id)),
        );
        expect(ids).toHaveLength(24);
        expect(new Set(ids).size).toBe(24);

        const reopened = new Store(join(cwd, '.crew', 'state', 'crew.db'));
        expect(reopened.getPendingSummary('worker').unreadCount).toBe(0);
        expect(reopened.listMessageHistory({ limit: 100 })).toHaveLength(24);
        reopened.close();
        const db = new DatabaseSync(join(cwd, '.crew', 'state', 'crew.db'));
        expect(db.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
        db.close();
      }
    },
    STRESS_TIMEOUT,
  );

  it(
    'returns explicit CONTENTION under a persistent writer lock without a partial send',
    async () => {
      const { cwd, store } = workspace();
      store.close();
      const path = join(cwd, '.crew', 'state', 'crew.db');
      const lock = new DatabaseSync(path);
      lock.exec('BEGIN IMMEDIATE');
      const barrier = join(cwd, 'start');
      const ready = join(cwd, 'ready');
      const contender = child(cwd, barrier, ready, [
        'send',
        'manager',
        'worker',
        'blocked',
        '--json',
      ]);
      await waitUntilReady([ready]);
      writeFileSync(barrier, 'go');
      const result = await contender;
      lock.exec('ROLLBACK');
      lock.close();

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'CONTENTION' } });
      expect(result.stdout).toBe('');
      const reopened = new Store(path);
      expect(reopened.listMessageHistory()).toEqual([]);
      reopened.close();
    },
    STRESS_TIMEOUT,
  );

  it(
    'keeps a Message in history after a crash in the receive output window (case 7)',
    async () => {
      const { cwd, store } = workspace();
      store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'only' });
      store.close();

      // Crash in stdout, after the receive commit, before the output is delivered.
      const crashed = await execa(
        'node',
        [
          '--no-warnings',
          '--input-type=module',
          '--eval',
          receiveCrashScript,
          cwd,
          JSON.stringify(['receive', 'worker', '--json']),
        ],
        { reject: false, cwd: root },
      );
      expect(crashed.exitCode).toBe(137);

      const reopened = new Store(join(cwd, '.crew', 'state', 'crew.db'));
      // The read committed before the crash: nothing shows as unread...
      expect(reopened.getPendingSummary('worker').unreadCount).toBe(0);
      // ...yet the Message is retained in history (never deleted) — the documented
      // at-most-once loss window: read, but the output was lost.
      expect(reopened.listMessageHistory({ limit: 100 })).toHaveLength(1);
      reopened.close();
      const db = new DatabaseSync(join(cwd, '.crew', 'state', 'crew.db'));
      expect(db.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
      db.close();
    },
    STRESS_TIMEOUT,
  );
});
