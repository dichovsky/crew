/**
 * Real-tmux end-to-end proof. Gated on tmux being installed —
 * skipped where it is not (the orchestration/relay logic is fully covered by the
 * fake-adapter and reducer unit tests). These tests exercise the bits unit tests
 * cannot: that the adapter's argv actually drives tmux 3.6+, and that the Relay
 * pastes its exact fixed nudge into a real pane WITHOUT consuming the Inbox.
 *
 * The full fake-Participant launch (readiness → crew join → brief) against real
 * tmux is proven separately in launch-e2e.test.ts; here we prove the tmux wiring
 * with a `cat`-backed pane that logs whatever is pasted into it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { initWorkspace } from '../../src/init.js';
import { createTmuxAdapter } from '../../src/launcher/tmux.js';
import { nodeRunInteractive, nodeRunProcess } from '../../src/process.js';
import { relayTick } from '../../src/relay.js';
import { run } from '../../src/run.js';
import { openWorkspaceStore } from '../../src/store/index.js';
import { captureIo } from '../helpers/io.js';
import type { Io } from '../../src/io.js';

function tmuxAvailable(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const TMUX_PRESENT = tmuxAvailable();
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CREW_BIN = join(REPO_ROOT, 'dist', 'bin', 'crew.js');

// Local dev gracefully SKIPS these when tmux is absent. CI installs tmux and sets
// CREW_REQUIRE_TMUX=1, so a missing tmux there is a HARD failure — the real-tmux
// integration proof can never silently turn into a false green on CI.
if (!TMUX_PRESENT && process.env.CREW_REQUIRE_TMUX === '1') {
  throw new Error(
    'CREW_REQUIRE_TMUX=1 but tmux is not available: the real-tmux e2e must run in this environment (install tmux).',
  );
}

const cleanup: string[] = [];
const made: string[] = [];
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() > deadline) return false;
    await wait(stepMs);
  }
}

async function readLogUntil(logPath: string, substring: string, timeoutMs = 5000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const contents = readFileSync(logPath, 'utf8');
      if (contents.includes(substring)) {
        return contents;
      }
    } catch {
      // file might not exist yet
    }
    await wait(50);
  }
  return readFileSync(logPath, 'utf8');
}

function realIo(cwd: string): Io {
  return captureIo({
    cwd,
    env: process.env,
    clock: () => 0,
    runProcess: nodeRunProcess,
    runInteractive: nodeRunInteractive,
  }).io;
}

function uniqueSession(label: string): string {
  return `crew-e2e-${label}-${process.pid}-${cleanup.length}`;
}

function hasSession(session: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', `=${session}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function activeLaunchTokenRows(cwd: string): number {
  const db = new DatabaseSync(join(cwd, '.crew', 'state', 'crew.db'));
  try {
    return (
      db
        .prepare(
          "SELECT count(*) AS count FROM agents WHERE status = 'active' AND launch_token IS NOT NULL",
        )
        .get() as { count: number }
    ).count;
  } finally {
    db.close();
  }
}

afterEach(() => {
  while (cleanup.length) {
    try {
      execFileSync('tmux', ['kill-session', '-t', `=${cleanup.pop()!}`], { stdio: 'ignore' });
    } catch {
      // already gone
    }
  }
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

describe.skipIf(!TMUX_PRESENT)('tmux adapter against real tmux', () => {
  it('creates, splits, pastes (argv + file), reports a command, and tears down', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-tmux-'));
    made.push(dir);
    const log = join(dir, 'pane.log');
    const session = uniqueSession('adapter');
    cleanup.push(session);
    const adapter = createTmuxAdapter(realIo(dir));

    // A pane whose process appends everything pasted into it to a log file.
    const pane = await adapter.newSession({
      session,
      window: 'crew',
      width: 120,
      height: 30,
      cwd: dir,
      command: ['sh', '-c', `cat >> ${log}`],
    });
    expect(pane).toMatch(/^%\d+$/);
    expect(await adapter.hasSession(session)).toBe(true);
    const owner = '123e4567-e89b-42d3-a456-426614174000';
    await adapter.setSessionOwner(session, owner);
    expect(await adapter.sessionOwner(session)).toBe(owner);

    // set-buffer (argv) → bracketed paste → Enter lands the text in the pane.
    await adapter.setBufferArg('b1', 'hello-from-argv');
    await adapter.pasteBuffer({ bufferName: 'b1', target: pane });
    await adapter.sendEnter(pane);

    // load-buffer (file) → paste lands the file body in the pane (untrusted-brief path).
    const briefFile = join(dir, 'brief.md');
    writeFileSync(briefFile, 'brief-body-from-file\n');
    await adapter.loadBufferFile('b2', briefFile);
    await adapter.pasteBuffer({ bufferName: 'b2', target: pane });
    await adapter.sendEnter(pane);

    const contents = await readLogUntil(log, 'brief-body-from-file');
    expect(contents).toContain('hello-from-argv');
    expect(contents).toContain('brief-body-from-file');

    // split, tile, and a readiness probe all work against real tmux.
    const pane2 = await adapter.splitPane({
      target: `${session}:crew`,
      cwd: dir,
      command: ['sleep', '30'],
    });
    expect(pane2).toMatch(/^%\d+$/);
    await adapter.tileLayout(`${session}:crew`);
    expect((await adapter.paneCommand(pane2)).length).toBeGreaterThan(0);

    // Teardown leaves nothing behind.
    await adapter.killSession(session);
    expect(await adapter.hasSession(session)).toBe(false);
  }, 120_000);

  it('splits to a full roster size with a re-tile between splits (no space exhaustion)', async () => {
    // Mirrors session.ts: a default split halves the active pane, so without a
    // re-tile between splits the height is exhausted after ~5 panes. Prove that
    // tiling between splits lets a realistic roster (8 panes / 7 splits) succeed.
    const dir = mkdtempSync(join(tmpdir(), 'crew-tile-'));
    made.push(dir);
    const session = uniqueSession('tile');
    cleanup.push(session);
    const adapter = createTmuxAdapter(realIo(dir));
    await adapter.newSession({
      session,
      window: 'crew',
      width: 220,
      height: 50,
      cwd: dir,
      command: ['sleep', '60'],
    });
    for (let i = 0; i < 7; i++) {
      const pane = await adapter.splitPane({
        target: `${session}:crew`,
        cwd: dir,
        command: ['sleep', '60'],
      });
      expect(pane).toMatch(/^%\d+$/);
      await adapter.tileLayout(`${session}:crew`);
    }
    const panes = execFileSync('tmux', ['list-panes', '-t', `=${session}`, '-F', '#{pane_id}'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n');
    expect(panes).toHaveLength(8);
    await adapter.killSession(session);
  }, 120_000);

  it('lets team stop tear down a launch interrupted by SIGINT during the roster wait', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-sigint-'));
    made.push(dir);
    initWorkspace(captureIo({ cwd: dir }).io, { withGuides: false, json: false });

    const session = uniqueSession('sigint');
    cleanup.push(session);
    const binDir = join(dir, 'fakebin');
    mkdirSync(binDir);
    const fakeClaude = join(binDir, 'claude');
    writeFileSync(
      fakeClaude,
      '#!/usr/bin/env node\nprocess.stdin.on("data", () => {});\nprocess.stdin.resume();\n',
    );
    chmodSync(fakeClaude, 0o755);
    writeFileSync(
      join(dir, '.crew', 'launcher.yaml'),
      `version: 1
project:
  name: sigint-demo
  session_name: ${session}
runtime:
  client: claude-code
relay:
  enabled: true
  poll_seconds: 2
  reminder_seconds: 30
`,
    );
    writeFileSync(join(dir, '.crew', 'run-task.md'), '# Task\n\nStay idle.\n');

    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };
    const paneMap = join(dir, '.crew', 'generated', session, 'pane-map.json');
    const launch = execa(process.execPath, [CREW_BIN, 'team', 'dev', '--launch', '--no-attach'], {
      cwd: dir,
      env,
      reject: false,
    });

    const paneMapReady = await until(() => existsSync(paneMap) && hasSession(session), 15_000);
    expect(paneMapReady).toBe(true);

    launch.kill('SIGINT');
    const interrupted = await launch;
    expect(interrupted.signal === 'SIGINT' || interrupted.exitCode === 130).toBe(true);

    if (hasSession(session)) {
      const stopped = await execa(process.execPath, [CREW_BIN, 'team', 'stop', session, '--json'], {
        cwd: dir,
        env,
        reject: false,
      });
      expect(stopped.exitCode).toBe(0);
      expect(JSON.parse(stopped.stdout)).toMatchObject({
        type: 'stop_result',
        session_name: session,
        killed: true,
      });
      expect(hasSession(session)).toBe(false);
    } else {
      expect(hasSession(session)).toBe(false);
    }

    expect(activeLaunchTokenRows(dir)).toBe(0);
  }, 120_000);

  it('creates the relay window with -d so the crew window stays active (C10)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-window-'));
    made.push(dir);
    const session = uniqueSession('window');
    cleanup.push(session);
    const adapter = createTmuxAdapter(realIo(dir));
    await adapter.newSession({
      session,
      window: 'crew',
      width: 120,
      height: 30,
      cwd: dir,
      command: ['sleep', '60'],
    });
    const relayPane = await adapter.newWindow({
      session,
      window: 'crew-relay',
      cwd: dir,
      command: ['sleep', '60'],
    });
    expect(relayPane).toMatch(/^%\d+$/);
    const windows = execFileSync(
      'tmux',
      ['list-windows', '-t', `=${session}`, '-F', '#{window_active} #{window_name}'],
      { encoding: 'utf8' },
    );
    // The active window (active flag = 1) must remain 'crew', not the relay window,
    // so a later `attach` lands on the participant panes.
    expect(windows).toContain('1 crew\n');
    expect(windows).not.toContain('1 crew-relay');
    await adapter.killSession(session);
  }, 120_000);
});

describe.skipIf(!TMUX_PRESENT)('Relay nudge against real tmux', () => {
  it('pastes the exact fixed nudge into the target pane and does not consume the Inbox', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-relay-e2e-'));
    made.push(dir);
    const io = realIo(dir);
    // Seed a real workspace: two agents, an unread Message to the worker.
    initWorkspace(captureIo({ cwd: dir }).io, { withGuides: false, json: false });
    await run(['join', 'manager', '--role', 'manager'], io);
    await run(['join', 'worker', '--role', 'worker'], io);
    await run(['send', 'manager', 'worker', 'inspect the auth module'], io);

    const log = join(dir, 'worker.log');
    const session = uniqueSession('relay');
    cleanup.push(session);
    const adapter = createTmuxAdapter(io);
    const pane = await adapter.newSession({
      session,
      window: 'crew',
      width: 120,
      height: 30,
      cwd: dir,
      command: ['sh', '-c', `cat >> ${log}`],
    });

    const store = openWorkspaceStore(dir, () => 0);
    try {
      const before = store.getPendingSummary('worker');
      expect(before.unreadCount).toBe(1);

      await relayTick(
        {
          summaries: store,
          staleLeases: store,
          adapter,
          delay: () => Promise.resolve(),
          now: () => 0,
          workspaceExists: () => true,
          shouldStop: () => false,
        },
        {
          session,
          panes: [{ agentId: 'worker', paneId: pane }],
          pollMs: 0,
          reminderSeconds: 30,
        },
        new Map(),
      );

      const contents = await readLogUntil(log, 'Crew inbox changed. Run: crew receive worker');
      expect(contents).toContain('Crew inbox changed. Run: crew receive worker');

      // The Relay observed but never consumed — the Message is still unread.
      expect(store.getPendingSummary('worker').unreadCount).toBe(1);
    } finally {
      store.close();
    }
  }, 120_000);
});
