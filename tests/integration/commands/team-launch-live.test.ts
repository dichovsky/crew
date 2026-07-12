/**
 * Live launch orchestration proven against a FAKE semantic
 * tmux adapter that simulates each pane running `crew join` when its
 * invocation is pasted, against the REAL Store. Covers the happy-path sequence,
 * the FR-H02 missing-tmux / missing-client / pre-existing-session / pre-existing-id
 * refusals (no session created), the readiness/join timeouts (owned teardown),
 * the scoped reap that archives only the untouched joined rows on a failed
 * teardown, and --no-relay/--no-attach.
 */
import { afterEach, describe, expect, it } from 'vitest';
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
import { initWorkspace } from '../../../src/init.js';
import {
  type LaunchFlags,
  loadLauncherConfig,
  mergeEffectiveConfig,
} from '../../../src/launcher/config.js';
import { buildLaunchPlan } from '../../../src/launcher/plan.js';
import { codexTarget } from '../../../src/platforms/codex.js';
import { type LiveLaunchDeps, runLiveLaunch } from '../../../src/launcher/session.js';
import type { TmuxAdapter } from '../../../src/launcher/tmux.js';
import { openWorkspaceStore } from '../../../src/store/index.js';
import type { WorktreeResolution } from '../../../src/worktree.js';
import { captureIo, recordingRunProcess } from '../../helpers/io.js';
import type { Io } from '../../../src/io.js';

const made: string[] = [];
const LAUNCHER_YAML = `version: 1
project:
  name: crew-demo
  session_name: crew-demo
runtime:
  client: codex-cli
relay:
  enabled: true
  poll_seconds: 2
  reminder_seconds: 30
`;
const ROSTER = ['manager', 'worker', 'worker-2', 'inspector'];

/** A workspace plus a fake `codex` executable on PATH (the C6 preflight needs it). */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-live-'));
  made.push(dir);
  initWorkspace(captureIo({ cwd: dir }).io, { withGuides: false, json: false });
  writeFileSync(join(dir, '.crew', 'launcher.yaml'), LAUNCHER_YAML);
  writeFileSync(join(dir, '.crew', 'run-task.md'), '# Task\n\nDo the thing.\n');
  mkdirSync(join(dir, 'fakebin'));
  writeFileSync(join(dir, 'fakebin', 'codex'), '#!/bin/sh\n');
  chmodSync(join(dir, 'fakebin', 'codex'), 0o755);
  return dir;
}

function testIo(cwd: string, env: Record<string, string> = {}): Io {
  return captureIo({
    cwd,
    env: { HOME: '/home/u', PATH: join(cwd, 'fakebin'), ...env },
    clock: () => 0,
  }).io;
}

function assembly(io: Io, flags: LaunchFlags = {}) {
  const config = mergeEffectiveConfig(loadLauncherConfig(io.cwd), flags);
  return buildLaunchPlan(io, 'dev', config);
}

function storedAgentIds(cwd: string): Set<string> {
  const store = openWorkspaceStore(cwd, () => 0);
  try {
    return new Set(store.listAgents().map((agent) => agent.id));
  } finally {
    store.close();
  }
}

/** Map every Agent id (active and archived) to its status. */
function allAgents(cwd: string): Map<string, string> {
  const store = openWorkspaceStore(cwd, () => 0);
  try {
    return new Map(store.listAgents({ includeArchived: true }).map((a) => [a.id, a.status]));
  } finally {
    store.close();
  }
}

/** Join one Agent directly, optionally stamped with a launch token (as a live
 * pane would, having received CREW_LAUNCH_TOKEN in its environment). */
function joinAgent(cwd: string, id: string, role: string, launchToken?: string): void {
  const store = openWorkspaceStore(cwd, () => 0);
  try {
    store.joinAgent({ id, role, ...(launchToken !== undefined ? { launchToken } : {}) });
  } finally {
    store.close();
  }
}

interface FakeOptions {
  present?: boolean;
  exists?: boolean;
  paneCommand?: string;
  /**
   * Successive paneCommand answers, applied INDEPENDENTLY per pane; each pane
   * walks its own copy and the last value repeats (for not-shell readiness, so
   * every pane genuinely exercises the shell→ready transition, not just the
   * first).
   */
  paneCommands?: readonly string[];
  join?: boolean;
  /** Simulate a TUI that drops early pastes: join only on the Nth invocation paste per agent. */
  joinAfterInvocationPastes?: number;
  killThrows?: boolean;
  newWindowThrows?: boolean;
  attachCode?: number;
}

/**
 * A fake TmuxAdapter that records its call sequence and, when an invocation is
 * pasted (`$crew <role> <id>`), simulates the Participant running `crew join` so
 * the REAL stage-2 Store gate observes a FRESH registration (no pre-seeding).
 */
function fakeAdapter(io: Io, opts: FakeOptions = {}) {
  const present = opts.present ?? true;
  const exists = opts.exists ?? false;
  const paneCommand = opts.paneCommand ?? 'codex';
  // Per-pane readiness sequences: each pane id gets its own cursor into a copy
  // of paneCommands, so all panes exercise the shell→ready transition, not only
  // the first (a shared cursor would let later panes see only the final value).
  const paneSequences = new Map<string, string[]>();
  const pasteCounts = new Map<string, number>();
  const joins = opts.join ?? true;
  const ops: string[] = [];
  const windows: { window: string; command: readonly string[] }[] = [];
  const participantCommands: (readonly string[])[] = [];
  let paneCounter = 0;
  let pendingJoin: { id: string; role: string } | null = null;
  let sessionOwner: string | null = null;
  // The launch token the real session.ts injects into each pane's environment;
  // captured here so a simulated `crew join` stamps it, exactly as a live pane
  // would after receiving CREW_LAUNCH_TOKEN.
  let launchToken: string | undefined;

  const startParticipant = (command: readonly string[]) => {
    participantCommands.push(command);
    const promptIndex = command.indexOf('--prompt');
    if (joins && command[0] === 'copilot' && command.includes('--agent=crew') && promptIndex >= 0) {
      const prompt = command[promptIndex + 1];
      const [role, id] = prompt?.split(/\s+/, 2) ?? [];
      if (role !== undefined && id !== undefined) joinAgent(io.cwd, id, role, launchToken);
    }
  };

  const adapter: TmuxAdapter = {
    isPresent: () => {
      ops.push('isPresent');
      return Promise.resolve(present);
    },
    hasSession: () => {
      ops.push('hasSession');
      return Promise.resolve(exists);
    },
    newSession: (o) => {
      ops.push('newSession');
      launchToken = o.env?.CREW_LAUNCH_TOKEN ?? launchToken;
      startParticipant(o.command);
      return Promise.resolve(`%${paneCounter++}`);
    },
    splitPane: (o) => {
      ops.push('splitPane');
      launchToken = o.env?.CREW_LAUNCH_TOKEN ?? launchToken;
      startParticipant(o.command);
      return Promise.resolve(`%${paneCounter++}`);
    },
    tileLayout: () => {
      ops.push('tileLayout');
      return Promise.resolve();
    },
    paneCommand: (paneId: string) => {
      if (opts.paneCommands === undefined) return Promise.resolve(paneCommand);
      let seq = paneSequences.get(paneId);
      if (seq === undefined) {
        seq = [...opts.paneCommands];
        paneSequences.set(paneId, seq);
      }
      // Advance this pane's own cursor; the last value repeats.
      return Promise.resolve(seq.length > 1 ? seq.shift()! : seq[0]!);
    },
    setSessionOwner: (_session, token) => {
      ops.push('setSessionOwner');
      sessionOwner = token;
      return Promise.resolve();
    },
    sessionOwner: () => Promise.resolve(sessionOwner),
    capturePane: (target: string) => {
      ops.push(`capturePane:${target}`);
      return Promise.resolve('');
    },
    setBufferArg: (_b, content) => {
      ops.push('setBufferArg');
      const parts = content.trim().split(/\s+/);
      if (parts.length >= 3 && parts[0]?.includes('crew')) {
        const id = parts[parts.length - 1]!;
        pasteCounts.set(id, (pasteCounts.get(id) ?? 0) + 1);
        if ((pasteCounts.get(id) ?? 0) >= (opts.joinAfterInvocationPastes ?? 1)) {
          pendingJoin = { role: parts[parts.length - 2]!, id };
        }
      }
      return Promise.resolve();
    },
    loadBufferFile: (_b, file) => {
      ops.push(`loadBufferFile:${file}`);
      return Promise.resolve();
    },
    pasteBuffer: (o) => {
      ops.push(`pasteBuffer:${o.target}`);
      return Promise.resolve();
    },
    sendEnter: (p) => {
      ops.push(`sendEnter:${p}`);
      if (joins && pendingJoin) {
        joinAgent(io.cwd, pendingJoin.id, pendingJoin.role, launchToken);
        pendingJoin = null;
      }
      return Promise.resolve();
    },
    newWindow: (o) => {
      ops.push(`newWindow:${o.window}`);
      windows.push({ window: o.window, command: o.command });
      return opts.newWindowThrows === true
        ? Promise.reject(new Error('newWindow failed'))
        : Promise.resolve(`%${paneCounter++}`);
    },
    killSession: () => {
      ops.push('killSession');
      return opts.killThrows === true
        ? Promise.reject(new Error('tmux kill-session failed'))
        : Promise.resolve();
    },
    attach: () => {
      ops.push('attach');
      return Promise.resolve(opts.attachCode ?? 0);
    },
  };
  const deps: LiveLaunchDeps = {
    adapter,
    delay: () => Promise.resolve(),
    relayBin: ['node', 'crew'],
  };
  return { adapter, ops, windows, participantCommands, deps };
}

afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('runLiveLaunch', () => {
  it('starts Copilot with its agent and prompt arguments instead of pasting a shell command into its TUI', async () => {
    const cwd = workspace();
    writeFileSync(
      join(cwd, '.crew', 'launcher.yaml'),
      LAUNCHER_YAML.replace('codex-cli', 'copilot-cli'),
    );
    writeFileSync(join(cwd, 'fakebin', 'copilot'), '#!/bin/sh\n');
    chmodSync(join(cwd, 'fakebin', 'copilot'), 0o755);
    const io = testIo(cwd);
    const fake = fakeAdapter(io, { paneCommand: 'copilot' });

    await expect(runLiveLaunch(io, fake.deps, assembly(io))).resolves.toMatchObject({ panes: 4 });

    expect(fake.participantCommands).toHaveLength(4);
    for (const command of fake.participantCommands) {
      expect(command).toEqual(['copilot', '--agent=crew', '--prompt', expect.any(String)]);
    }
    expect(fake.ops.filter((op) => op === 'setBufferArg')).toHaveLength(0);
  });

  it('drives the full happy-path sequence (panes join fresh) and writes pane-map.json', async () => {
    const io = testIo(workspace());
    const fake = fakeAdapter(io);
    const result = await runLiveLaunch(io, fake.deps, assembly(io));

    expect(result).toEqual({ sessionName: 'crew-demo', panes: 4, relay: true, attached: true });
    expect(fake.ops.filter((o) => o === 'newSession')).toHaveLength(1);
    expect(fake.ops.filter((o) => o === 'splitPane')).toHaveLength(3);
    expect(fake.ops).toContain('tileLayout');
    expect(fake.ops).toContain('attach');
    expect(fake.ops).not.toContain('killSession');
    expect(
      fake.ops.some((o) => o.startsWith('loadBufferFile:') && o.includes('manager-prompt.md')),
    ).toBe(true);
    const paneMapPath = join(io.cwd, '.crew', 'generated', 'crew-demo', 'pane-map.json');
    expect(existsSync(paneMapPath)).toBe(true);
    const paneMap = JSON.parse(readFileSync(paneMapPath, 'utf8')) as {
      ownership_token: string;
      relay_window: { present: boolean; name: string; pane_id: string | null };
    };
    expect(paneMap.ownership_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(paneMap.relay_window).toMatchObject({
      present: true,
      name: 'crew-relay',
    });
    expect(paneMap.relay_window.pane_id).toMatch(/^%\d+$/);
    expect(fake.ops.indexOf('setSessionOwner')).toBeLessThan(fake.ops.indexOf('splitPane'));
    // The Relay window runs the exact internal `crew relay` command for this session.
    expect(fake.windows).toEqual([
      {
        window: 'crew-relay',
        command: ['node', 'crew', 'relay', '--internal', '--session', 'crew-demo'],
      },
    ]);
    // The four planned ids registered fresh during the launch.
    expect(storedAgentIds(io.cwd)).toEqual(new Set(ROSTER));
  });

  it('uses a unique tmux buffer name per paste (no fixed global buffer)', async () => {
    const io = testIo(workspace());
    const names: string[] = [];
    const fake = fakeAdapter(io);
    const spied: TmuxAdapter = {
      ...fake.adapter,
      setBufferArg: (b, content) => {
        names.push(b);
        return fake.adapter.setBufferArg(b, content);
      },
      loadBufferFile: (b, file) => {
        names.push(b);
        return fake.adapter.loadBufferFile(b, file);
      },
    };
    await runLiveLaunch(io, { ...fake.deps, adapter: spied }, assembly(io));
    // One name per invocation (4) + the brief (1); all distinct and prefixed.
    expect(names).toHaveLength(5);
    expect(new Set(names).size).toBe(5);
    expect(names.every((n) => /^crew-(inv|brief)-/.test(n))).toBe(true);
  });

  it('emits the launch result (onLaunched) before the blocking attach', async () => {
    const io = testIo(workspace());
    const fake = fakeAdapter(io);
    await runLiveLaunch(
      io,
      { ...fake.deps, onLaunched: () => fake.ops.push('onLaunched') },
      assembly(io),
    );
    expect(fake.ops.indexOf('onLaunched')).toBeLessThan(fake.ops.indexOf('attach'));
  });

  it('refuses a pre-existing session with ALREADY_EXISTS and never creates one', async () => {
    const io = testIo(workspace());
    const fake = fakeAdapter(io, { exists: true });
    await expect(runLiveLaunch(io, fake.deps, assembly(io))).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });
    expect(fake.ops).not.toContain('newSession');
  });

  it('refuses with DEPENDENCY_MISSING when tmux is absent and creates nothing', async () => {
    const io = testIo(workspace());
    const fake = fakeAdapter(io, { present: false });
    await expect(runLiveLaunch(io, fake.deps, assembly(io))).rejects.toMatchObject({
      code: 'DEPENDENCY_MISSING',
    });
    expect(fake.ops).not.toContain('newSession');
  });

  it('preflights the Participant executable: a missing client is DEPENDENCY_MISSING, no session (C6)', async () => {
    const cwd = workspace();
    rmSync(join(cwd, 'fakebin', 'codex')); // client not on PATH
    const io = testIo(cwd);
    const fake = fakeAdapter(io);
    const err = await runLiveLaunch(io, fake.deps, assembly(io)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'DEPENDENCY_MISSING' });
    expect((err as Error).message).toContain('codex');
    expect(fake.ops).not.toContain('newSession');
  });

  it('refuses when a planned Agent id already exists, before creating a session (C5)', async () => {
    const io = testIo(workspace());
    joinAgent(io.cwd, 'worker', 'worker'); // a stale/pre-existing planned id
    const fake = fakeAdapter(io);
    const err = await runLiveLaunch(io, fake.deps, assembly(io)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'ALREADY_EXISTS' });
    expect((err as Error).message).toContain('worker');
    expect(fake.ops).not.toContain('newSession');
  });

  it('tears down the owned session when a pane never reaches readiness (stage 1)', async () => {
    const io = testIo(workspace());
    const fake = fakeAdapter(io, { paneCommand: 'zsh' }); // never matches 'codex'
    await expect(runLiveLaunch(io, fake.deps, assembly(io))).rejects.toMatchObject({
      code: 'LAUNCH_FAILED',
    });
    expect(fake.ops).toContain('newSession');
    expect(fake.ops).toContain('killSession');
    expect(fake.ops).not.toContain('attach');
  });

  it('not-shell readiness: a claude-code pane is ready once its command leaves the shell', async () => {
    const cwd = workspace();
    // The C6 preflight needs the client executable on PATH.
    writeFileSync(join(cwd, 'fakebin', 'claude'), '#!/bin/sh\n');
    chmodSync(join(cwd, 'fakebin', 'claude'), 0o755);
    const io = testIo(cwd);
    // Live probe 2026-07-02: claude reports its version string (e.g. "2.1.198")
    // as the pane's foreground command, never "claude" — exact names cannot match.
    const fake = fakeAdapter(io, { paneCommands: ['zsh', '2.1.198'] });
    const result = await runLiveLaunch(io, fake.deps, assembly(io, { client: 'claude-code' }));
    expect(result).toEqual({ sessionName: 'crew-demo', panes: 4, relay: true, attached: true });
    expect(fake.ops).not.toContain('killSession');
    expect(storedAgentIds(cwd)).toEqual(new Set(ROSTER));
  });

  it('not-shell readiness: a pane that stays a shell fails stage 1 with owned teardown', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'fakebin', 'claude'), '#!/bin/sh\n');
    chmodSync(join(cwd, 'fakebin', 'claude'), 0o755);
    const io = testIo(cwd);
    const fake = fakeAdapter(io, { paneCommands: ['zsh'] });
    const err = await runLiveLaunch(io, fake.deps, assembly(io, { client: 'claude-code' })).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'LAUNCH_FAILED' });
    expect((err as Error).message).toContain('stayed a shell');
    expect(fake.ops).toContain('killSession');
  });

  it('names mode with an empty readinessNames list skips Stage-1 matching (legacy)', async () => {
    const io = testIo(workspace());
    // 'zsh' never matches a readiness name; with an empty list the launch must
    // proceed on the settle delay alone (the documented legacy semantics).
    const fake = fakeAdapter(io, { paneCommand: 'zsh' });
    const bare = { ...codexTarget, readinessNames: [] as const };
    const result = await runLiveLaunch(
      io,
      { ...fake.deps, resolveTarget: () => bare },
      assembly(io),
    );
    expect(result).toEqual({ sessionName: 'crew-demo', panes: 4, relay: true, attached: true });
  });

  it('redelivers the invocation to panes that missed the first paste (stage 2)', async () => {
    const io = testIo(workspace());
    // Observed live with Codex (startup banner) and Claude Code (slow interactive
    // start): the pane process is up but the TUI drops the first paste.
    const fake = fakeAdapter(io, { joinAfterInvocationPastes: 2 });
    const result = await runLiveLaunch(io, fake.deps, assembly(io));
    expect(result).toEqual({ sessionName: 'crew-demo', panes: 4, relay: true, attached: true });
    // Every agent needed exactly one redelivery: 4 initial + 4 redelivered pastes.
    expect(fake.ops.filter((o) => o === 'setBufferArg')).toHaveLength(8);
    expect(storedAgentIds(io.cwd)).toEqual(new Set(ROSTER));
  });

  it('bounds redelivery: at most two extra pastes per pane before the join timeout', async () => {
    const io = testIo(workspace());
    const fake = fakeAdapter(io, { join: false });
    await expect(runLiveLaunch(io, fake.deps, assembly(io))).rejects.toMatchObject({
      code: 'LAUNCH_FAILED',
    });
    // 4 initial pastes + 2 bounded redelivery rounds x 4 panes = 12, never more.
    expect(fake.ops.filter((o) => o === 'setBufferArg')).toHaveLength(12);
  });

  it('tears down the owned session when the roster never registers (stage 2)', async () => {
    const io = testIo(workspace());
    const fake = fakeAdapter(io, { join: false }); // panes are ready but never `crew join`
    const err = await runLiveLaunch(io, fake.deps, assembly(io)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'LAUNCH_FAILED' });
    expect((err as Error).message).toContain('did not register');
    expect(fake.ops).toContain('killSession');
  });

  it('reaps (deletes) the untouched joined rows it stamped, so the team relaunches', async () => {
    const io = testIo(workspace());
    // Panes join (stamped with this launch's token), then the relay-window step
    // fails -> teardown. The untouched joined rows are DELETED by the scoped reap,
    // freeing their ids so the same team is immediately relaunchable.
    const fake = fakeAdapter(io, { newWindowThrows: true });
    await expect(runLiveLaunch(io, fake.deps, assembly(io))).rejects.toBeInstanceOf(Error);
    expect(fake.ops).toContain('killSession');
    expect(allAgents(io.cwd).size).toBe(0); // no rows left at all (deleted, not archived)

    // A second launch of the SAME team now succeeds — the preflight no longer
    // trips on reserved ids, which is the reap's whole purpose.
    const retry = fakeAdapter(io);
    const result = await runLiveLaunch(io, retry.deps, assembly(io));
    expect(result).toEqual({ sessionName: 'crew-demo', panes: 4, relay: true, attached: true });
    expect(storedAgentIds(io.cwd)).toEqual(new Set(ROSTER));
  });

  it('does NOT reap when teardown is unconfirmed: live panes keep their active rows (C1)', async () => {
    const io = testIo(workspace());
    // The relay step fails AND killSession fails, so the session may still be
    // alive with live participant processes. Reaping their (untouched) rows would
    // break them with AGENT_INACTIVE, so the reap must be skipped and the rows
    // left ACTIVE — and the original launch error must stay primary.
    const fake = fakeAdapter(io, { newWindowThrows: true, killThrows: true });
    const err = await runLiveLaunch(io, fake.deps, assembly(io)).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain('kill-session'); // launch error primary
    expect(fake.ops).toContain('killSession');
    expect(storedAgentIds(io.cwd)).toEqual(new Set(ROSTER)); // every joined row still active
  });

  it('a kill-session failure during teardown does not mask the original launch error', async () => {
    const io = testIo(workspace());
    const fake = fakeAdapter(io, { paneCommand: 'zsh', killThrows: true });
    const err = await runLiveLaunch(io, fake.deps, assembly(io)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'LAUNCH_FAILED' });
    expect((err as Error).message).not.toContain('kill-session');
    expect(fake.ops).toContain('killSession');
  });

  it('surfaces a non-zero attach as a failure but does NOT tear down the built session (C9)', async () => {
    const io = testIo(workspace());
    const fake = fakeAdapter(io, { attachCode: 1 });
    const err = await runLiveLaunch(io, fake.deps, assembly(io)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'LAUNCH_FAILED' });
    expect((err as Error).message).toContain('attach');
    // The session was fully built; attach failure must not kill it.
    expect(fake.ops).toContain('attach');
    expect(fake.ops).not.toContain('killSession');
  });

  it('omits the relay window with --no-relay and the attach with --no-attach', async () => {
    const io = testIo(workspace());
    const fake = fakeAdapter(io);
    const result = await runLiveLaunch(
      io,
      fake.deps,
      assembly(io, { noRelay: true, noAttach: true }),
    );
    expect(result.relay).toBe(false);
    expect(result.attached).toBe(false);
    expect(fake.ops).not.toContain('newWindow:crew-relay');
    expect(fake.ops).not.toContain('attach');
  });

  it('deps.noAttach forces a detached launch even when the plan says attach (ADR-0012)', async () => {
    const io = testIo(workspace());
    const fake = fakeAdapter(io);
    // The default assembly plans an attach — the caller option must override it.
    const result = await runLiveLaunch(io, { ...fake.deps, noAttach: true }, assembly(io));

    // The session is fully built: panes, readiness, roster, relay, brief.
    expect(result).toEqual({ sessionName: 'crew-demo', panes: 4, relay: true, attached: false });
    expect(fake.ops.filter((o) => o === 'newSession')).toHaveLength(1);
    expect(fake.ops).toContain('newWindow:crew-relay');
    expect(storedAgentIds(io.cwd)).toEqual(new Set(ROSTER));
    // ...but ZERO attach invocations ever reach the adapter.
    expect(fake.ops).not.toContain('attach');
  });

  it('regression pin: a default launch (no option set) still attaches', async () => {
    const io = testIo(workspace());
    const fake = fakeAdapter(io);
    const result = await runLiveLaunch(io, fake.deps, assembly(io));
    expect(result.attached).toBe(true);
    expect(fake.ops).toContain('attach');
  });
});

/**
 * A worktree-enabled live launch resolves the single whole-Crew
 * worktree (ADR-0011) and runs the whole live Crew — pane `cwd`, the Store,
 * and every generated artifact — inside it. `resolveWorktree` is injected
 * (mirrors `resolveTarget`) so these tests never touch a real git repo; the
 * worktree resolver itself is proven separately in `worktree.test.ts`.
 */
describe('runLiveLaunch (worktree-enabled)', () => {
  /** A second temp dir standing in for the resolved worktree, with its own `.crew/`. */
  function worktreeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'crew-live-wt-'));
    made.push(dir);
    initWorkspace(captureIo({ cwd: dir }).io, { withGuides: false, json: false });
    return dir;
  }

  function worktreeAssembly(io: Io) {
    return assembly(io, { worktree: 'feature/x' });
  }

  it('creates the pane-map/prompts/Store inside the resolved worktree, not the original root', async () => {
    const cwd = workspace();
    const io = testIo(cwd);
    const wt = worktreeDir();
    // The fake adapter's simulated `crew join` on `sendEnter` writes to
    // `io.cwd`'s Store — since the real pane's cwd (and hence its own `crew
    // join`) is the WORKTREE once resolved, build the fake against a worktree-cwd
    // Io so the simulation matches where the launch itself opens its Store.
    const fake = fakeAdapter({ ...io, cwd: wt });
    const resolution: WorktreeResolution = {
      path: wt,
      action: 'create',
      branch: 'feature/x',
      baseRef: 'HEAD',
    };
    const result = await runLiveLaunch(
      io,
      { ...fake.deps, resolveWorktree: () => Promise.resolve(resolution) },
      worktreeAssembly(io),
    );
    expect(result).toEqual({ sessionName: 'crew-demo', panes: 4, relay: true, attached: true });

    // Artifacts and the pane-map land under the WORKTREE, never the original root.
    expect(existsSync(join(wt, '.crew', 'generated', 'crew-demo', 'pane-map.json'))).toBe(true);
    expect(existsSync(join(cwd, '.crew', 'generated', 'crew-demo', 'pane-map.json'))).toBe(false);

    // The Store the Agents joined is the WORKTREE's own, not the original root's.
    expect(storedAgentIds(wt)).toEqual(new Set(ROSTER));
    expect(storedAgentIds(cwd).size).toBe(0);
  });

  it('a failed build removes a NEWLY CREATED worktree once teardown is confirmed', async () => {
    const cwd = workspace();
    const io = testIo(cwd);
    const wt = worktreeDir();
    // Panes never register (stage 2) -> LAUNCH_FAILED -> teardown kills the
    // session successfully -> the created worktree must be removed.
    const fake = fakeAdapter(io, { join: false });
    const rec = recordingRunProcess([{ status: 0, stdout: '', stderr: '' }]);
    const ioWithGit: Io = { ...io, runProcess: rec.runProcess };
    const resolution: WorktreeResolution = {
      path: wt,
      action: 'create',
      branch: 'feature/x',
      baseRef: 'HEAD',
    };
    await expect(
      runLiveLaunch(
        ioWithGit,
        { ...fake.deps, resolveWorktree: () => Promise.resolve(resolution) },
        worktreeAssembly(io),
      ),
    ).rejects.toMatchObject({ code: 'LAUNCH_FAILED' });
    expect(fake.ops).toContain('killSession');
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toMatchObject({
      file: 'git',
      args: ['-C', cwd, 'worktree', 'remove', '--force', wt],
    });
  });

  it('a failed build leaves a REUSED worktree intact (no git worktree remove call)', async () => {
    const cwd = workspace();
    const io = testIo(cwd);
    const wt = worktreeDir();
    const fake = fakeAdapter(io, { join: false });
    const rec = recordingRunProcess([{ status: 0, stdout: '', stderr: '' }]);
    const ioWithGit: Io = { ...io, runProcess: rec.runProcess };
    const resolution: WorktreeResolution = {
      path: wt,
      action: 'reuse',
      branch: 'feature/x',
      baseRef: 'HEAD',
    };
    await expect(
      runLiveLaunch(
        ioWithGit,
        { ...fake.deps, resolveWorktree: () => Promise.resolve(resolution) },
        worktreeAssembly(io),
      ),
    ).rejects.toMatchObject({ code: 'LAUNCH_FAILED' });
    expect(fake.ops).toContain('killSession');
    expect(rec.calls).toHaveLength(0); // never removed — it pre-existed this launch
  });

  it('does not remove a newly created worktree when teardown itself could not be confirmed', async () => {
    const cwd = workspace();
    const io = testIo(cwd);
    const wt = worktreeDir();
    const fake = fakeAdapter(io, { join: false, killThrows: true });
    const rec = recordingRunProcess([{ status: 0, stdout: '', stderr: '' }]);
    const ioWithGit: Io = { ...io, runProcess: rec.runProcess };
    const resolution: WorktreeResolution = {
      path: wt,
      action: 'create',
      branch: 'feature/x',
      baseRef: 'HEAD',
    };
    await expect(
      runLiveLaunch(
        ioWithGit,
        { ...fake.deps, resolveWorktree: () => Promise.resolve(resolution) },
        worktreeAssembly(io),
      ),
    ).rejects.toMatchObject({ code: 'LAUNCH_FAILED' });
    expect(fake.ops).toContain('killSession'); // attempted, but killThrows -> not confirmed
    expect(rec.calls).toHaveLength(0); // unconfirmed teardown -> worktree left alone
  });

  it('resolves the worktree BEFORE any tmux mutation: a resolution failure creates no session', async () => {
    const cwd = workspace();
    const io = testIo(cwd);
    const fake = fakeAdapter(io);
    await expect(
      runLiveLaunch(
        io,
        {
          ...fake.deps,
          resolveWorktree: () =>
            Promise.reject(new (class extends Error {})('git worktree add failed')),
        },
        worktreeAssembly(io),
      ),
    ).rejects.toThrow('git worktree add failed');
    expect(fake.ops).not.toContain('newSession');
  });
});
