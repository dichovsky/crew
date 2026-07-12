/**
 * Console destructive-flow smoke (FR-U25, one-click): build the REAL bundle,
 * seed a temp Workspace with an old READ Message, start `crew ui`, and drive
 * the one-click confirmation in a real browser: navigate to Operations, open
 * Prune, and confirm with a single click (the modal names the irreversible
 * effect; there is no typed phrase) — the dialog closes and a "Prune complete"
 * toast reflects the completed action. Runs via `npm run e2e:ui`
 * (nightly / label-gated) — never as part of `npm test`.
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

  workspace = mkdtempSync(join(tmpdir(), 'crew-ui-e2e-maintenance-'));
  crew(['init']);
  crew(['join', MANAGER_ID, '--role', 'manager']);
  crew(['join', WORKER_ID, '--role', 'worker']);
  // Some real traffic so the workspace is non-trivial. The message is read
  // but younger than the 30-day retention window, so the prune legitimately
  // deletes nothing — the flow under test is the one-click confirmation gate
  // and the honest completed-action result, not retention arithmetic.
  crew(['send', MANAGER_ID, WORKER_ID, 'read but recent']);
  crew(['receive', WORKER_ID]);
});

test.afterAll(async () => {
  if (server !== null && server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGINT');
    await exited;
  }
  if (workspace !== '') rmSync(workspace, { recursive: true, force: true });
});

test('the one-click confirmation runs prune: open Operations, confirm, see the result', async ({
  page,
}) => {
  const consoleUrl = await startConsole();
  await page.goto(consoleUrl);

  // The sidebar shell renders once the snapshot loads; move to Operations.
  await page.getByRole('button', { name: 'Operations' }).click();
  await expect(page.getByRole('heading', { name: 'Maintenance' })).toBeVisible();

  // Open the prune confirmation — a modal that names the irreversible effect
  // and has NO typed-phrase input (the one-click design).
  await page.getByRole('button', { name: 'Prune…' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Prune workspace history');
  await expect(dialog.getByRole('textbox')).toHaveCount(0);

  // A single click on the labelled confirm button runs the real action.
  await dialog.getByRole('button', { name: 'Prune', exact: true }).click();

  // The dialog closes and a toast reflects the completed action.
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('Prune complete')).toBeVisible();
});
