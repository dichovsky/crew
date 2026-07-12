import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';

import { initWorkspace } from '../../src/init.js';
import { Store } from '../../src/store/index.js';
import { run } from '../../src/run.js';
import { captureIo } from '../helpers/io.js';
import { dumpStressFailure } from '../helpers/stress.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const storeModule = pathToFileURL(join(root, 'dist', 'src', 'store', 'index.js')).href;

// A contender that opens the Store BEFORE clean runs, waits on a barrier, then
// attempts a join and reports whether it durably joined or failed detectably.
const preOpenScript = `
  import { existsSync, writeFileSync } from 'node:fs';
  import { setTimeout as delay } from 'node:timers/promises';
  const [dbPath, barrier, ready] = process.argv.slice(1);
  const { Store } = await import(${JSON.stringify(storeModule)});
  const store = new Store(dbPath, { clock: () => 100 });
  writeFileSync(ready, 'ready');
  while (!existsSync(barrier)) await delay(5);
  try {
    store.joinAgent({ id: 'late', role: 'worker' });
    process.stdout.write(JSON.stringify({ joined: true }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ code: err?.code ?? String(err) }));
  }
`;

const made: string[] = [];

function workspace(): { cwd: string; dbPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-spawn-clean-'));
  made.push(cwd);
  initWorkspace(captureIo({ cwd }).io, { withGuides: false, json: false });
  return { cwd, dbPath: join(cwd, '.crew', 'state', 'crew.db') };
}

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
}, 120_000);

afterEach((ctx) => {
  dumpStressFailure(ctx, { made }); // retain seed + failing DB copy on failure
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('clean active-Agent guard under concurrent access (maintenance-gap)', () => {
  it('lets clean succeed yet makes a pre-opened join fail detectably, never silently', async () => {
    const { cwd, dbPath } = workspace();
    const barrier = join(cwd, 'go');
    const ready = join(cwd, 'ready');

    const contender = execa(
      'node',
      ['--no-warnings', '--input-type=module', '--eval', preOpenScript, dbPath, barrier, ready],
      { reject: false, cwd: root },
    );
    // Wait until the contender has the Store open (so it pre-dates clean).
    const deadline = Date.now() + 120_000;
    while (!existsSync(ready)) {
      if (Date.now() >= deadline) throw new Error('contender never opened the store');
      await delay(10);
    }

    // clean runs while the contender holds the store open but idle (no active Agents).
    const { io, out } = captureIo({ cwd });
    expect(await run(['clean', '--json'], io)).toBe(0);
    expect((JSON.parse(out.join('')) as { removed: string[] }).removed).toContain('crew.db');
    expect(existsSync(dbPath)).toBe(false);

    // Release the contender: its join must FAIL (STALE_STORE), not silently "succeed"
    // into an orphaned file. This is the silent-loss case this test guards against.
    writeFileSync(barrier, 'go');
    const result = await contender;
    const parsed = JSON.parse(result.stdout) as { joined?: boolean; code?: string };
    expect(parsed.joined).toBeUndefined();
    expect(parsed.code).toBe('STALE_STORE');
  }, 120_000);

  it('aborts clean with ACTIVE_AGENTS when an active Agent is present, leaving the store intact', async () => {
    const { cwd, dbPath } = workspace();
    const setup = new Store(dbPath, { clock: () => 0 });
    setup.joinAgent({ id: 'active', role: 'worker' });
    setup.close();

    const { io, err } = captureIo({ cwd });
    expect(await run(['clean', '--json'], io)).toBe(1);
    expect(JSON.parse(err.join(''))).toMatchObject({ error: { code: 'ACTIVE_AGENTS' } });
    expect(existsSync(dbPath)).toBe(true);
  }, 120_000);
});
