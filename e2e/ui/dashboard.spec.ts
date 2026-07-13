/**
 * Console dashboard smoke: build the REAL bundle, seed a
 * temp Workspace through the built CLI, start `crew ui --json --no-open`,
 * open the authenticated URL from the `ui_started` record in a real browser,
 * and assert the board renders the seeded data. Runs via `npm run e2e:ui`
 * (nightly / label-gated workflow) — never as part of `npm test`.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// npm run e2e:ui runs from the repo root; the built artifact is the subject.
const REPO_ROOT = process.cwd();
const CREW_BIN = join(REPO_ROOT, 'dist', 'bin', 'crew.js');

const AGENT_ID = 'e2e-manager';
const TASK_TITLE = 'Ship the e2e widget';
const MESSAGE_TEXT = 'hello from the e2e seed';

let workspace = '';
let server: ChildProcess | null = null;
let consoleUrl = '';

function crew(args: readonly string[]): string {
  return execFileSync(process.execPath, [CREW_BIN, ...args], {
    cwd: workspace,
    encoding: 'utf8',
  });
}

/** Start `crew ui --json --no-open` and resolve the ui_started URL. */
async function startConsole(): Promise<string> {
  server = spawn(process.execPath, [CREW_BIN, 'ui', '--json', '--no-open'], {
    cwd: workspace,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = server.stdout!;
  stdout.setEncoding('utf8');
  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: string): void => {
      buffer += chunk;
      const line = buffer.split('\n')[0];
      if (buffer.includes('\n') && line !== undefined && line.length > 0) {
        stdout.off('data', onData);
        const record = JSON.parse(line) as { type: string; url: string };
        if (record.type !== 'ui_started') {
          reject(new Error(`expected ui_started, got: ${line}`));
          return;
        }
        resolve(record.url);
      }
    };
    stdout.on('data', onData);
    server!.once('error', reject);
    server!.once('exit', (code) => {
      reject(new Error(`crew ui exited early with code ${String(code)}`));
    });
  });
}

test.beforeAll(() => {
  // The bundle IS the artifact under test: always build it fresh.
  execFileSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });

  workspace = mkdtempSync(join(tmpdir(), 'crew-ui-e2e-'));
  crew(['init']);
  crew(['join', AGENT_ID, '--role', 'manager']);
  crew(['join', 'e2e-worker', '--role', 'worker']);
  crew(['send', AGENT_ID, 'e2e-worker', MESSAGE_TEXT]);
  crew([
    'task',
    'create',
    AGENT_ID,
    'e2e-worker',
    '--reviewer',
    AGENT_ID,
    '--title',
    TASK_TITLE,
    '--body',
    'seeded by the dashboard smoke',
  ]);
});

test.afterAll(async () => {
  if (server !== null && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGINT');
    await exited;
  }
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true });
});

test('the dashboard renders seeded agents, tasks, and messages live', async ({ page }) => {
  consoleUrl = await startConsole();
  expect(consoleUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}$/);

  await page.goto(consoleUrl);
  // The sidebar shell renders once the snapshot loads; Now is the default view (FR-U37).
  await expect(page.locator('.brand-name')).toHaveText('crew');
  await expect(page.getByRole('heading', { name: 'Now' })).toBeVisible();

  // Overview roster shows the seeded agent id.
  await page.locator('.nav-item', { hasText: 'Overview' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.locator('.roster-row', { hasText: AGENT_ID }).first()).toBeVisible();

  // The seeded Task lives on the Tasks board.
  await page.locator('.nav-item', { hasText: 'Tasks' }).click();
  await expect(page.getByText(TASK_TITLE).first()).toBeVisible();

  // The seeded Message lives in the Messages view.
  await page.locator('.nav-item', { hasText: 'Messages' }).click();
  await expect(page.getByText(MESSAGE_TEXT).first()).toBeVisible();

  // The Agents view renders a card per seeded agent.
  await page.locator('.nav-item', { hasText: 'Agents' }).click();
  await expect(page.locator('.agent-card', { hasText: AGENT_ID }).first()).toBeVisible();
  await expect(page.locator('.agent-card', { hasText: 'e2e-worker' }).first()).toBeVisible();
});
