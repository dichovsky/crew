/**
 * Deleted-workspace recovery.
 * Verifies that the Console handles a sudden disappearance of the .crew/state directory
 * gracefully (displaying a bounded error/recovery state) instead of crashing, ensures
 * last-known data remains visible while the workspace is missing, ensures no new database
 * files are implicitly created, and verifies that a genuinely re-initialized workspace at
 * the same path is detected and resumes normal operation with a fresh Store.
 *
 * Modeled on e2e/ui/actions.spec.ts.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const REPO_ROOT = process.cwd();
const CREW_BIN = join(REPO_ROOT, 'dist', 'bin', 'crew.js');

const AGENT_ID = 'e2e-manager';
const WORKER_ID = 'e2e-worker';
const MESSAGE_TEXT = 'last-known data test';

let workspace = '';
let server: ChildProcess | null = null;

function crew(args: readonly string[]): string {
  return execFileSync(process.execPath, [CREW_BIN, ...args], {
    cwd: workspace,
    encoding: 'utf8',
  });
}

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
  workspace = mkdtempSync(join(tmpdir(), 'crew-ui-e2e-recovery-'));
  crew(['init']);
  crew(['join', AGENT_ID, '--role', 'manager']);
  crew(['join', WORKER_ID, '--role', 'worker']);
  crew(['send', AGENT_ID, WORKER_ID, MESSAGE_TEXT]);
});

test.afterAll(async () => {
  if (server !== null && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGINT');
    await exited;
  }
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true });
});

test('the console handles workspace deletion and recovery gracefully', async ({ page }) => {
  const consoleUrl = await startConsole();
  await page.goto(consoleUrl);
  await expect(page.locator('.brand-name')).toHaveText('crew');

  // Load the Messages view so the seeded message is on screen before we crash.
  await page.locator('.nav-item', { hasText: 'Messages' }).click();
  await expect(page.getByText(MESSAGE_TEXT).first()).toBeVisible();

  // 1. Simulate workspace deletion (the .crew/state directory)
  const stateDir = join(workspace, '.crew', 'state');
  rmSync(stateDir, { recursive: true, force: true });

  // 2. Assert that the dashboard shows a recovery state instead of crashing.
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByText(/Workspace unavailable/i)).toBeVisible();

  // 3. Assert that actions are disabled (the redesigned compose controls).
  const recipient = page.locator('#compose-recipient');
  const messageInput = page.locator('#compose-body');
  const sendButton = page.getByRole('button', { name: 'Send message' });
  await expect(recipient).toBeDisabled();
  await expect(messageInput).toBeDisabled();
  await expect(sendButton).toBeDisabled();

  // 4. Assert that last-known data is still visible while the workspace is missing.
  await expect(page.getByText(MESSAGE_TEXT).first()).toBeVisible();

  // 5. Assert that no new database files are implicitly created in .crew/
  const crewDir = join(workspace, '.crew');
  const files = execFileSync('find', [crewDir, '-name', '*.db'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  expect(files.trim()).toBe('');

  // 6. Re-initialize the workspace as a genuinely fresh Store at the same path.
  // `crew init` alone only recreates directories/config, never crew.db — the
  // server's reopen seam checks existsSync specifically so it never creates
  // state itself; a real crew.db only appears once something joins.
  crew(['init']);
  crew(['join', AGENT_ID, '--role', 'manager']);
  crew(['join', WORKER_ID, '--role', 'worker']);

  // 7. Verify that the RecoveryBanner disappears once the fresh Store is detected.
  await expect(page.getByRole('alert')).not.toBeVisible({ timeout: 10000 });

  // The re-initialized Store is genuinely empty: the pre-deletion Message
  // does not exist in it, so the stale last-known snapshot must be replaced
  // by the fresh (empty) one, never preserved past recovery.
  await expect(page.getByText(MESSAGE_TEXT)).not.toBeVisible();

  // 8. New message flow resumes against the fresh Store.
  const NEW_MESSAGE = 'new message after recovery';
  await recipient.selectOption(WORKER_ID);
  await messageInput.fill(NEW_MESSAGE);
  await sendButton.click();

  // The POST outcome is observed directly: success clears the body...
  await expect(messageInput).toHaveValue('');
  // ...and the post-action refetch shows the message in the history.
  await expect(page.getByText(NEW_MESSAGE).first()).toBeVisible();
});
