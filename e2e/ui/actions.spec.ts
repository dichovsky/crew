/**
 * Console action smoke (11d-1): build the REAL bundle, seed a temp Workspace
 * (including the plain `operator` Agent row the POST actions require), start
 * `crew ui --json --no-open`, and drive the real message form in a browser:
 * a browser-sent message (a string DISTINCT from the CLI seed) appears in the
 * history after the post-action refetch, and a hostile body renders as inert
 * text — no script element, no dialog. Runs via `npm run e2e:ui`
 * (nightly / label-gated workflow) — never as part of `npm test`.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const REPO_ROOT = process.cwd();
const CREW_BIN = join(REPO_ROOT, 'dist', 'bin', 'crew.js');

const MANAGER_ID = 'e2e-manager';
const WORKER_ID = 'e2e-worker';
const SEEDED_TEXT = 'hello from the e2e seed';
const SENT_TEXT = 'sent from the browser form';
const HOSTILE_TEXT = '<script>alert("xss")</script>';

let workspace = '';
let server: ChildProcess | null = null;

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

  workspace = mkdtempSync(join(tmpdir(), 'crew-ui-e2e-actions-'));
  crew(['init']);
  // No operator seed: `crew ui` ensures the plain operator Agent row itself
  // at startup (FR-U13, 11d-2) — this scenario proves that end-to-end.
  crew(['join', MANAGER_ID, '--role', 'manager']);
  crew(['join', WORKER_ID, '--role', 'worker']);
  crew(['send', MANAGER_ID, WORKER_ID, SEEDED_TEXT]);
});

test.afterAll(async () => {
  if (server !== null && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGINT');
    await exited;
  }
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true });
});

test('the operator sends a message from the form; hostile content stays inert', async ({
  page,
}) => {
  let dialogFired = false;
  page.on('dialog', (dialog) => {
    dialogFired = true;
    void dialog.dismiss();
  });

  const consoleUrl = await startConsole();
  await page.goto(consoleUrl);
  await expect(page.locator('.brand-name')).toHaveText('crew');

  // The Messages view carries both the seed history and the compose form.
  await page.locator('.nav-item', { hasText: 'Messages' }).click();
  await expect(page.getByText(SEEDED_TEXT).first()).toBeVisible();

  // The redesigned compose: a recipient <select> plus a message <textarea>.
  const recipient = page.locator('#compose-recipient');
  const messageInput = page.locator('#compose-body');
  const sendButton = page.getByRole('button', { name: 'Send message' });

  // --- A browser-sent message (distinct from the seed) reaches the history.
  await recipient.selectOption(WORKER_ID);
  await messageInput.fill(SENT_TEXT);
  await sendButton.click();

  // The POST outcome is observed directly: success clears the body once the
  // send (POST + refetch) settles...
  await expect(messageInput).toHaveValue('', { timeout: 15000 });
  // ...and the post-action refetch shows the message in the history list
  // (scope to the list so we never match the compose textarea's own value).
  await expect(page.locator('.msg-content', { hasText: SENT_TEXT }).first()).toBeVisible();

  // --- Hostile content renders as text: visible in the list, no script node,
  // no dialog. Wait for the send to settle, then assert inertness.
  await recipient.selectOption(MANAGER_ID);
  await messageInput.fill(HOSTILE_TEXT);
  await sendButton.click();

  await expect(messageInput).toHaveValue('', { timeout: 15000 });
  await expect(page.locator('.msg-content', { hasText: 'alert("xss")' }).first()).toBeVisible();
  expect(await page.locator('.msg-content script').count()).toBe(0);
  expect(dialogFired).toBe(false);
});
