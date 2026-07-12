/**
 * Full fake-Participant real-tmux LAUNCH e2e (closing the
 * remaining part of the Relay-proof release gate). This is the meet-point the two
 * earlier proofs never reached: tmux-e2e.test.ts drives the real adapter with
 * `cat` panes (no orchestrator, no participant); team-launch-live.test.ts drives
 * the whole `runLiveLaunch` orchestration but against an in-process FAKE adapter.
 * Here `runLiveLaunch` runs IN-PROCESS against REAL tmux with a homogeneous fake
 * Participant, so the entire live path is exercised end to end:
 *
 *   (a) session built → (b) two-stage readiness → (c) each pane runs real `crew
 *   join` → (d) the Manager pane receives the brief paste → (e) a Message is sent
 *   to the idle Worker → (f) the real `crew relay` window pastes the fixed nudge →
 *   (g) the fake Worker runs `crew receive` exactly once (no double-consume) →
 *   (h) session termination stops the Relay process.
 *
 * The fake Participant is a real Node executable injected via the launcher's
 * `resolveTarget` dependency seam (Q2 decision), so NO test hook ships in the
 * binary. Its `readinessNames` match the interpreter process name (`node`) that
 * tmux reports for the pane — the cross-platform-robust choice over forcing an
 * OS-level process name (Q2). It reads its pasted invocation, runs the REAL built
 * `crew join`/`crew receive` (honouring the injected CREW_LAUNCH_TOKEN), and logs
 * what it does so the test can assert each step.
 *
 * Heavy and nightly-only: gated behind CREW_LAUNCH_E2E=1 (mirrors the
 * CREW_REQUIRE_TMUX idiom) so per-PR `npm test` COLLECTS but SKIPS it — a visible
 * skip that cannot rot silently. The launch-e2e.yml workflow sets the flag.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { basename, delimiter, join } from 'node:path';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initWorkspace } from '../../src/init.js';
import { createTmuxAdapter } from '../../src/launcher/tmux.js';
import type { LaunchAssembly, LaunchPlan } from '../../src/launcher/plan.js';
import type { LiveLaunchDeps } from '../../src/launcher/session.js';
import { runLiveLaunch } from '../../src/launcher/session.js';
import type { ParticipantTarget } from '../../src/platforms/registry.js';
import { nodeRunInteractive, nodeRunProcess } from '../../src/process.js';
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
const RUN_LAUNCH_E2E = process.env.CREW_LAUNCH_E2E === '1';

// When explicitly opted in (nightly launch-e2e.yml sets CREW_LAUNCH_E2E=1 and
// CREW_REQUIRE_TMUX=1), a missing tmux is a HARD failure — the launch e2e must not
// silently turn into a false green on the release tier. Locally, without the flag,
// the whole describe is skipped (a visible "skipped", never a false pass).
if (RUN_LAUNCH_E2E && !TMUX_PRESENT && process.env.CREW_REQUIRE_TMUX === '1') {
  throw new Error(
    'CREW_LAUNCH_E2E=1 with CREW_REQUIRE_TMUX=1 but tmux is not available: install tmux to run the launch e2e.',
  );
}

// Derived from this file's own URL (not process.cwd()) so the e2e resolves the
// built entrypoint correctly even when Vitest runs from a non-repo working
// directory (IDE runner, `vitest --dir`), matching the other spawn suites.
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** Absolute path to the built crew entrypoint the fake participant / relay re-invoke. */
const CREW_BIN = join(REPO_ROOT, 'dist', 'bin', 'crew.js');
/** tmux reports the pane's interpreter as the readiness process name for a node fake. */
const READINESS_NAME = basename(process.execPath); // 'node' on every supported runner

const cleanupSessions: string[] = [];
const madeDirs: string[] = [];
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `check` until it returns true or the budget elapses; returns the final value. */
async function until(check: () => boolean, budgetMs: number, stepMs = 300): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() > deadline) return false;
    await wait(stepMs);
  }
}

/** Real epoch seconds: the fake's `crew join`/`receive` and the relay run as real
 * subprocesses on the real clock, so every in-process op MUST share it — a fixed
 * clock=0 would violate the Store's `last_seen >= joined_at` invariant. */
const realClock = (): number => Math.floor(Date.now() / 1000);

function realIo(cwd: string, env: NodeJS.ProcessEnv): { io: Io; err: string[] } {
  const cap = captureIo({
    cwd,
    env,
    clock: realClock,
    runProcess: nodeRunProcess,
    runInteractive: nodeRunInteractive,
  });
  return { io: cap.io, err: cap.err };
}

function uniqueSession(): string {
  return `crew-launch-e2e-${process.pid}-${cleanupSessions.length}`;
}

/**
 * A real Node executable that behaves like a Participant CLI pane: it stays alive
 * reading stdin (so tmux reports its process as `node` for readiness), and on each
 * pasted line it (1) runs real `crew join <id> --role <role>` when it sees its
 * invocation, and (2) runs real `crew receive <id>` EXACTLY once when it sees the
 * exact fixed relay nudge — logging every matched nudge line regardless, so a
 * broadcast or duplicate nudge is observable even though only the first triggers a
 * receive. Every action is appended to `<logDir>/<id>.log`.
 */
function fakeParticipantScript(logDir: string): string {
  const cfg = { NODE: process.execPath, CREW: CREW_BIN, LOGDIR: logDir };
  return `#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const CFG = ${JSON.stringify(cfg)};
let myId = null;
let received = 0;
function log(id, line) {
  try { fs.appendFileSync(path.join(CFG.LOGDIR, id + '.log'), line + '\\n'); } catch {}
}
function crew(args) {
  return spawnSync(CFG.NODE, [CFG.CREW, ...args], { cwd: process.cwd(), env: process.env, encoding: 'utf8' });
}
function handle(raw) {
  const line = raw.replace(/\\r$/, '');
  const invoke = /^CREWJOIN\\s+(\\S+)\\s+(\\S+)$/.exec(line.trim());
  if (invoke) {
    const role = invoke[1], id = invoke[2];
    myId = id;
    log(id, 'INVOCATION ' + line.trim());
    const r = crew(['join', id, '--role', role]);
    log(id, 'JOIN_STATUS ' + r.status);
    return;
  }
  // The exact fixed relay nudge — anchored so the Manager's brief text (which
  // itself mentions \`crew receive <actual-id>\`) can never trigger a spurious receive.
  const nudge = /^Crew inbox changed\\. Run: crew receive (\\S+)$/.exec(line.trim());
  if (nudge) {
    const id = nudge[1];
    // Logged on EVERY match, not gated on \`received\` — a broadcast or duplicate
    // nudge must be observable even though the guard below still runs \`crew
    // receive\` at most once (a real Participant would not re-run it either).
    log(myId || id, 'NUDGE_SEEN ' + line.trim());
    if (received === 0) {
      received += 1;
      const r = crew(['receive', id, '--json']);
      log(myId || id, 'RECEIVE COUNT ' + received + ' STATUS ' + r.status + ' STDOUT ' + JSON.stringify(r.stdout));
    }
    return;
  }
  if (myId) log(myId, 'PASTE ' + line.trim());
}
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    handle(buf.slice(0, i));
    buf = buf.slice(i + 1);
  }
});
process.stdin.resume();
`;
}

/** A fake homogeneous Participant target injected in-process (no shipped hook). */
function fakeTarget(executable: string): ParticipantTarget {
  return {
    id: 'codex-cli', // typing only; getTarget is bypassed via resolveTarget
    category: 'participant',
    executable,
    versionArgs: ['--version'],
    userPath: '.config/fake',
    projectPath: '.fake',
    format: 'markdown',
    readinessNames: [READINESS_NAME],
    minimumVerifiedVersion: null,
    verifiedOn: '2026-07-01',
    officialSources: [],
    permissionNote: '',
    invocation: (role, id) => `CREWJOIN ${role} ${id}`,
    render: () => '',
  };
}

function buildAssembly(session: string, executablePath: string, marker: string): LaunchAssembly {
  const plan: LaunchPlan = {
    schema_version: 1,
    session_name: session,
    created_at: 0,
    team: 'e2e',
    client: 'codex-cli',
    executable: executablePath,
    worktree: { enabled: false, path: null, branch: null, base_ref: 'HEAD' },
    relay: { enabled: true, poll_seconds: 1, reminder_seconds: 30, attach: false },
    roster: [
      { agent_id: 'manager', role: 'manager', replica_base: 'manager' },
      { agent_id: 'worker', role: 'worker', replica_base: 'worker' },
    ],
    focus: { files: [], docs: [] },
    constraints: [],
    task_brief: { present: true, target_role: 'manager' },
    artifacts: ['pane-map.json', 'manager-prompt.md', 'inspector-prompt.md', 'run-summary.md'],
  };
  return {
    plan,
    clientSource: 'flag',
    brief: {
      present: true,
      path: '.crew/run-task.md',
      lineCount: 1,
      explicit: false,
      body: `Investigate the login flow. ${marker}`,
    },
  };
}

/** The dir launch-e2e.yml uploads on failure (`tests/spawn/__artifacts__/`). */
const ARTIFACT_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '__artifacts__');

/**
 * On failure, retain the tmux version and a capture of every pane in the session
 * (the participant panes' scrollback + the relay window) so a flaky nightly
 * failure is debuggable from the uploaded artifact. Best-effort; runs before the
 * afterEach teardown kills the session.
 */
function captureLaunchFailure(session: string): void {
  try {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    let dump = `tmux ${execFileSync('tmux', ['-V'], { encoding: 'utf8' }).trim()}\nsession ${session}\n`;
    const panes = execFileSync(
      'tmux',
      [
        'list-panes',
        '-s',
        '-t',
        `=${session}`,
        '-F',
        '#{window_name} #{pane_id} #{pane_current_command}',
      ],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n');
    for (const line of panes) {
      const paneId = line.split(' ')[1];
      dump += `\n===== ${line} =====\n`;
      try {
        dump += execFileSync('tmux', ['capture-pane', '-p', '-t', paneId!], { encoding: 'utf8' });
      } catch {
        dump += '(capture failed)\n';
      }
    }
    writeFileSync(join(ARTIFACT_DIR, `launch-e2e-${process.pid}-${Date.now()}.log`), dump);
  } catch {
    // best-effort: capturing diagnostics must never mask the original failure
  }
}

/** True while a `crew relay` process for this session is still alive. */
function relayRunning(session: string): boolean {
  try {
    const out = execFileSync('pgrep', ['-f', `relay --internal --session ${session}`], {
      encoding: 'utf8',
    });
    return out.trim().length > 0;
  } catch (err) {
    // A missing pgrep must fail loudly, not masquerade as "relay not running".
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('pgrep is missing: install pgrep to run the launch e2e test.', {
        cause: err,
      });
    }
    return false; // pgrep exits non-zero when nothing matches
  }
}

afterEach((ctx) => {
  // Capture pane diagnostics BEFORE teardown when the test failed (ordering-
  // independent: the session still exists here because this hook does the kill).
  if (ctx.task.result?.state === 'fail') {
    for (const session of cleanupSessions) captureLaunchFailure(session);
  }
  while (cleanupSessions.length) {
    try {
      execFileSync('tmux', ['kill-session', '-t', `=${cleanupSessions.pop()!}`], {
        stdio: 'ignore',
      });
    } catch {
      // already gone
    }
  }
  while (madeDirs.length) rmSync(madeDirs.pop()!, { recursive: true, force: true });
});

describe.skipIf(!RUN_LAUNCH_E2E || !TMUX_PRESENT)(
  'full fake-Participant launch against real tmux',
  () => {
    it('drives readiness → join → brief → nudge → receive-once → relay stop', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'crew-launch-'));
      madeDirs.push(dir);
      const binDir = join(dir, 'bin');
      const logDir = join(dir, 'logs');
      mkdirSync(binDir);
      mkdirSync(logDir);

      // The fake participant on a controlled PATH (for the preflight) AND run by
      // absolute path in the pane (tmux's server env need not carry binDir).
      const fakePath = join(binDir, 'crewfakecli');
      writeFileSync(fakePath, fakeParticipantScript(logDir));
      chmodSync(fakePath, 0o755);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
      };
      const { io } = realIo(dir, env);
      initWorkspace(captureIo({ cwd: dir }).io, { withGuides: false, json: false });

      const session = uniqueSession();
      cleanupSessions.push(session);
      const marker = `E2EBRIEF${process.pid}`;
      const assembly = buildAssembly(session, fakePath, marker);

      const deps: LiveLaunchDeps = {
        adapter: createTmuxAdapter(io),
        // A short real delay per poll (session.ts asks for 500ms/1000ms; the fake
        // registers in well under a second, so this keeps the readiness/roster polls
        // spanning real wall-clock without waiting the full production budget).
        delay: () => wait(120),
        relayBin: [process.execPath, CREW_BIN],
        resolveTarget: () => fakeTarget('crewfakecli'),
      };

      // (a)+(b)+(c)+(d): runLiveLaunch builds the session, gates on two-stage
      // readiness, each pane's real `crew join` satisfies the roster gate, and the
      // brief is pasted into the Manager pane. Returns only after all of that.
      const result = await runLiveLaunch(io, deps, assembly);
      expect(result.panes).toBe(2);
      expect(result.relay).toBe(true);
      expect(result.attached).toBe(false);

      const adapter = createTmuxAdapter(io);
      expect(await adapter.hasSession(session)).toBe(true);

      const store = openWorkspaceStore(dir, realClock);
      try {
        // (c): both panes ran real `crew join` — the roster exists in the Store.
        const ids = new Set(store.listAgents().map((a) => a.id));
        expect(ids.has('manager')).toBe(true);
        expect(ids.has('worker')).toBe(true);

        // (d): the untrusted brief body reached the Manager pane (marker present).
        // runLiveLaunch pastes the brief and returns without waiting for the pane
        // process to read and log it, so poll rather than assume it already has.
        const managerBriefed = await until(() => {
          try {
            return readFileSync(join(logDir, 'manager.log'), 'utf8').includes(marker);
          } catch {
            return false;
          }
        }, 15_000);
        expect(managerBriefed).toBe(true);
        const managerLog = readFileSync(join(logDir, 'manager.log'), 'utf8');
        expect(managerLog).toContain('JOIN_STATUS 0');

        // (e): a Message to the idle Worker.
        const sendContent = 'please inspect the login flow';
        expect(await run(['send', 'manager', 'worker', sendContent], io)).toBe(0);
        expect(store.getPendingSummary('worker').unreadCount).toBe(1);

        // (f)+(g): the REAL relay window observes the pending summary, pastes the
        // fixed nudge into the Worker pane, and the fake Worker runs `crew receive`
        // exactly once — draining the Inbox with no double-consume.
        const consumed = await until(
          () => store.getPendingSummary('worker').unreadCount === 0,
          30_000,
        );
        expect(consumed).toBe(true);
        const workerLog = readFileSync(join(logDir, 'worker.log'), 'utf8');
        expect(workerLog).toContain('RECEIVE COUNT 1 STATUS 0');
        expect(workerLog).toContain(sendContent);
        // NUDGE_SEEN is logged on every matched nudge line regardless of whether a
        // receive fires, so — unlike a count of completed receives — this can
        // actually catch a Relay regression that broadcasts or repeats the nudge.
        expect((workerLog.match(/NUDGE_SEEN/g) ?? []).length).toBe(1);

        // FR-H17: the fixed nudge targets only the intended Agent — the Manager
        // pane must never see it or run `crew receive` for the Worker's Message.
        const managerLogFinal = readFileSync(join(logDir, 'manager.log'), 'utf8');
        expect(managerLogFinal).not.toContain('NUDGE_SEEN');
        expect(managerLogFinal).not.toContain('RECEIVE COUNT');
      } finally {
        store.close();
      }

      // (h): tearing the session down stops the Relay process (no lingering child).
      expect(relayRunning(session)).toBe(true);
      await adapter.killSession(session);
      expect(await adapter.hasSession(session)).toBe(false);
      const stopped = await until(() => !relayRunning(session), 15_000);
      expect(stopped).toBe(true);
    }, 180_000);
  },
);
