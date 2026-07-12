/**
 * The Relay tick/loop and command guards. The loop is driven
 * through fully injected seams: a fake summary source, a recording nudge
 * adapter, an instant delay, and a controllable clock/stop — so the nudge path
 * and every stop condition (signal / session-gone / workspace-gone, FR-H20) are
 * deterministic without real timers, signals, or tmux.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboxState, StaleLeaseTask } from '../../src/store/index.js';
import { initWorkspace } from '../../src/init.js';
import {
  loadRelayPanes,
  nudgeText,
  runRelay,
  type RelayLoopConfig,
  type RelayLoopDeps,
  type RelayNudgeAdapter,
  type RelayStaleLeaseSource,
  type RelaySummarySource,
  relayTick,
  runRelayLoop,
  staleLeaseNudgeText,
} from '../../src/relay.js';
import { run } from '../../src/run.js';
import { captureIo } from '../helpers/io.js';
import { ANSI_OSC } from '../helpers/security-corpus.js';

function summaries(map: Record<string, InboxState>): RelaySummarySource {
  return {
    getPendingSummary: (agentId) => map[agentId] ?? { agentId, unreadCount: 0, maxUnreadId: null },
  };
}

function staleLeases(tasks: readonly StaleLeaseTask[] = []): RelayStaleLeaseSource {
  return { listStaleLeaseTasks: () => [...tasks] };
}

function inbox(agentId: string, unreadCount: number, maxUnreadId: number | null): InboxState {
  return { agentId, unreadCount, maxUnreadId };
}

function nudgeAdapter(throwOn: ReadonlySet<string> = new Set()) {
  const ops: string[] = [];
  const adapter: RelayNudgeAdapter = {
    hasSession: () => Promise.resolve(true),
    setBufferArg: (_b, content) => {
      ops.push(`set:${content}`);
      return Promise.resolve();
    },
    pasteBuffer: (o) => {
      if (throwOn.has(o.target)) return Promise.reject(new Error('pane is gone'));
      ops.push(`paste:${o.target}`);
      return Promise.resolve();
    },
    sendEnter: (p) => {
      ops.push(`enter:${p}`);
      return Promise.resolve();
    },
  };
  return { adapter, ops };
}

const CONFIG: RelayLoopConfig = {
  session: 'crew-demo',
  panes: [
    { agentId: 'manager', paneId: '%0' },
    { agentId: 'worker', paneId: '%1' },
  ],
  pollMs: 2000,
  reminderSeconds: 30,
};

function loopDeps(over: Partial<RelayLoopDeps>): RelayLoopDeps {
  const base = nudgeAdapter();
  return {
    summaries: summaries({}),
    staleLeases: staleLeases(),
    adapter: base.adapter,
    delay: () => Promise.resolve(),
    now: () => 0,
    workspaceExists: () => true,
    shouldStop: () => true,
    ...over,
  };
}

describe('nudgeText', () => {
  it('is the fixed command-to-run, carrying only the agent id', () => {
    expect(nudgeText('worker-2')).toBe('Crew inbox changed. Run: crew receive worker-2');
  });

  it('is a function of the agent id alone — never any Message/injection content [security]', () => {
    // nudgeText takes only an agent id; Message content never reaches it. The
    // output is exactly the fixed command carrying that id, so no prompt-injection
    // payload or ANSI control sequence that may live in a Message can appear.
    const agentId = 'worker-2';
    const nudge = nudgeText(agentId);
    expect(nudge).toBe(`Crew inbox changed. Run: crew receive ${agentId}`);
    expect(nudge).not.toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
    expect(nudge).not.toContain('rm -rf');
    for (const ansi of ANSI_OSC) expect(nudge).not.toContain(ansi);
  });
});

describe('staleLeaseNudgeText', () => {
  it('is the fixed command-to-run, carrying only the Task id', () => {
    const taskId = '11111111-1111-4111-8111-111111111111';
    expect(staleLeaseNudgeText(taskId)).toBe(
      `Task ${taskId}'s Lease is stale. Run: crew task requeue <you> ${taskId} --reason <text> (or abandon it).`,
    );
  });

  it('is a function of the Task id alone — never Task title/body/summary content [security]', () => {
    // A Task id is a server-generated UUID (randomUUID()), never user input, so
    // there is no injection surface here to begin with — but the fixed-command
    // shape is asserted the same way nudgeText's is, for consistency.
    const taskId = '22222222-2222-4222-8222-222222222222';
    const nudge = staleLeaseNudgeText(taskId);
    expect(nudge).not.toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
    expect(nudge).not.toContain('rm -rf');
    for (const ansi of ANSI_OSC) expect(nudge).not.toContain(ansi);
  });
});

describe('relayTick', () => {
  it('pastes the fixed nudge into the pane of each Agent the reducer flags', async () => {
    const adapter = nudgeAdapter();
    const deps = loopDeps({
      summaries: summaries({ worker: inbox('worker', 2, 9) }),
      adapter: adapter.adapter,
    });
    const { nudged } = await relayTick(deps, CONFIG, new Map());
    expect(nudged).toEqual(['worker']);
    expect(adapter.ops).toEqual([
      'set:Crew inbox changed. Run: crew receive worker',
      'paste:%1',
      'enter:%1',
    ]);
  });

  it('is best-effort per pane: a failed paste is skipped, others still nudge', async () => {
    const adapter = nudgeAdapter(new Set(['%0'])); // manager pane is dead
    const deps = loopDeps({
      summaries: summaries({
        manager: inbox('manager', 1, 4),
        worker: inbox('worker', 1, 7),
      }),
      adapter: adapter.adapter,
    });
    const { nudged } = await relayTick(deps, CONFIG, new Map());
    expect(nudged).toEqual(['worker']); // manager paste threw and was swallowed
    expect(adapter.ops).toContain('paste:%1');
  });

  it('nudges no one when no Inbox has unread work', async () => {
    const adapter = nudgeAdapter();
    const deps = loopDeps({ summaries: summaries({}), adapter: adapter.adapter });
    const { nudged } = await relayTick(deps, CONFIG, new Map());
    expect(nudged).toEqual([]);
    expect(adapter.ops).toEqual([]);
  });

  it('skips an Agent whose summary read throws, never crashing the loop (FR-H20 resilience)', async () => {
    const adapter = nudgeAdapter();
    const deps = loopDeps({
      summaries: {
        getPendingSummary: (agentId) => {
          if (agentId === 'manager') throw new Error('CONTENTION'); // transient Store error
          return inbox(agentId, 1, 7);
        },
      },
      adapter: adapter.adapter,
    });
    const { nudged } = await relayTick(deps, CONFIG, new Map());
    // The worker is still nudged; the manager is skipped this tick rather than crashing.
    expect(nudged).toEqual(['worker']);
  });

  it('pastes the stale-lease nudge into the Task creator pane', async () => {
    const adapter = nudgeAdapter();
    const deps = loopDeps({
      staleLeases: staleLeases([{ taskId: 'task-9', creatorId: 'manager' }]),
      adapter: adapter.adapter,
    });
    const { staleLeaseNudged, staleLeaseState } = await relayTick(deps, CONFIG, new Map());
    expect(staleLeaseNudged).toEqual(['manager']);
    expect(adapter.ops).toEqual([`set:${staleLeaseNudgeText('task-9')}`, 'paste:%0', 'enter:%0']);
    expect(staleLeaseState.get('task-9')).toEqual({ lastReminderAt: 0 });
  });

  it('an inbox nudge and a stale-lease nudge to the same pane both land intact (distinct buffers)', async () => {
    const adapter = nudgeAdapter();
    const deps = loopDeps({
      summaries: summaries({ manager: inbox('manager', 1, 3) }),
      staleLeases: staleLeases([{ taskId: 'task-9', creatorId: 'manager' }]),
      adapter: adapter.adapter,
    });
    const { nudged, staleLeaseNudged } = await relayTick(deps, CONFIG, new Map());
    expect(nudged).toEqual(['manager']);
    expect(staleLeaseNudged).toEqual(['manager']);
    expect(adapter.ops).toEqual([
      'set:Crew inbox changed. Run: crew receive manager',
      'paste:%0',
      'enter:%0',
      `set:${staleLeaseNudgeText('task-9')}`,
      'paste:%0',
      'enter:%0',
    ]);
  });

  it('skips a stale Task whose creator has no mapped pane', async () => {
    const adapter = nudgeAdapter();
    const deps = loopDeps({
      staleLeases: staleLeases([{ taskId: 'task-9', creatorId: 'departed-agent' }]),
      adapter: adapter.adapter,
    });
    const { staleLeaseNudged } = await relayTick(deps, CONFIG, new Map());
    expect(staleLeaseNudged).toEqual([]);
    expect(adapter.ops).toEqual([]);
  });

  it('skips stale-lease nudging this tick when the Store read throws, never crashing the loop', async () => {
    const adapter = nudgeAdapter();
    const deps = loopDeps({
      staleLeases: {
        listStaleLeaseTasks: () => {
          throw new Error('CONTENTION');
        },
      },
      adapter: adapter.adapter,
    });
    const { staleLeaseNudged } = await relayTick(deps, CONFIG, new Map());
    expect(staleLeaseNudged).toEqual([]);
  });
});

describe('runRelayLoop', () => {
  it('ticks until shouldStop becomes true', async () => {
    const adapter = nudgeAdapter();
    let ticks = 0;
    const deps = loopDeps({
      summaries: {
        getPendingSummary: (agentId) => {
          if (agentId === 'manager') ticks++; // counts once per tick (first pane)
          return inbox(agentId, 1, 1);
        },
      },
      adapter: adapter.adapter,
      shouldStop: () => ticks >= 2,
    });
    await runRelayLoop(deps, CONFIG);
    expect(ticks).toBe(2);
  });

  it('stops immediately when the tmux session is gone', async () => {
    let ticks = 0;
    const deps = loopDeps({
      summaries: {
        getPendingSummary: (agentId) => {
          ticks++;
          return inbox(agentId, 0, null);
        },
      },
      adapter: { ...nudgeAdapter().adapter, hasSession: () => Promise.resolve(false) },
      shouldStop: () => false,
    });
    await runRelayLoop(deps, CONFIG);
    expect(ticks).toBe(0);
  });

  it('stops immediately when the workspace is gone', async () => {
    let ticks = 0;
    const deps = loopDeps({
      summaries: {
        getPendingSummary: (agentId) => {
          ticks++;
          return inbox(agentId, 0, null);
        },
      },
      workspaceExists: () => false,
      shouldStop: () => false,
    });
    await runRelayLoop(deps, CONFIG);
    expect(ticks).toBe(0);
  });

  it('keeps running when every summary read throws — the loop never crashes (C2)', async () => {
    let reads = 0;
    const deps = loopDeps({
      summaries: {
        getPendingSummary: () => {
          reads++;
          throw new Error('store contention'); // a transient Store error each poll
        },
      },
      shouldStop: () => reads >= 4, // two panes per tick → stop after ~2 ticks
    });
    // The loop must resolve (survive), not reject/crash.
    await expect(runRelayLoop(deps, CONFIG)).resolves.toBeUndefined();
    expect(reads).toBeGreaterThanOrEqual(4);
  });

  it('re-nudges across ticks once the reminder interval elapses (advancing clock)', async () => {
    const adapter = nudgeAdapter();
    let tick = 0;
    const clockByTick = [100, 100, 130]; // 3rd tick is 30s after the 1st nudge
    const deps = loopDeps({
      summaries: summaries({ worker: inbox('worker', 1, 5) }),
      adapter: adapter.adapter,
      now: () => clockByTick[Math.min(tick, clockByTick.length - 1)] ?? 130,
      shouldStop: () => tick++ >= 3,
    });
    await runRelayLoop(deps, CONFIG);
    const pastes = adapter.ops.filter((o) => o === 'paste:%1');
    expect(pastes.length).toBe(2); // first observation + the reminder at +30s
  });
});

describe('loadRelayPanes', () => {
  const made: string[] = [];
  afterEach(() => {
    while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
  });

  function workspaceWithPaneMap(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'crew-panemap-'));
    made.push(dir);
    initWorkspace(captureIo({ cwd: dir }).io, { withGuides: false, json: false });
    const genDir = join(dir, '.crew', 'generated', 'crew-demo');
    mkdirSync(genDir, { recursive: true });
    writeFileSync(join(genDir, 'pane-map.json'), body);
    return dir;
  }

  it('reads the agent→pane mapping from a valid pane-map.json', () => {
    const dir = workspaceWithPaneMap(
      JSON.stringify({
        schema_version: 1,
        session_name: 'crew-demo',
        relay_window: { present: true, name: 'crew-relay' },
        panes: [
          { agent_id: 'manager', pane_id: '%0' },
          { agent_id: 'worker', pane_id: '%1' },
        ],
      }),
    );
    expect(loadRelayPanes(dir, 'crew-demo')).toEqual([
      { agentId: 'manager', paneId: '%0' },
      { agentId: 'worker', paneId: '%1' },
    ]);
  });

  it('rejects malformed JSON', () => {
    const dir = workspaceWithPaneMap('{ not json');
    expect(() => loadRelayPanes(dir, 'crew-demo')).toThrow(/not valid JSON/);
  });

  it('rejects a document with no panes array', () => {
    const dir = workspaceWithPaneMap(JSON.stringify({ schema_version: 1 }));
    expect(() => loadRelayPanes(dir, 'crew-demo')).toThrow(/no panes array/);
  });

  it('reports an ABSENT pane-map as NOT_FOUND, not a misleading invalid-JSON error (C1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-nomap-'));
    made.push(dir);
    initWorkspace(captureIo({ cwd: dir }).io, { withGuides: false, json: false });
    // No pane-map.json written for this session.
    expect(() => loadRelayPanes(dir, 'crew-demo')).toThrow(/no pane-map\.json/);
  });

  it('rejects a literal null document with INVALID_CONFIG (not a TypeError)', () => {
    const dir = workspaceWithPaneMap('null');
    expect(() => loadRelayPanes(dir, 'crew-demo')).toThrow(/not an object/);
  });

  it('rejects a null pane entry with INVALID_CONFIG (not a TypeError)', () => {
    const dir = workspaceWithPaneMap(JSON.stringify({ panes: [null] }));
    expect(() => loadRelayPanes(dir, 'crew-demo')).toThrow(/malformed pane/);
  });

  it('rejects a pane missing its pane id', () => {
    const dir = workspaceWithPaneMap(JSON.stringify({ panes: [{ agent_id: 'worker' }] }));
    expect(() => loadRelayPanes(dir, 'crew-demo')).toThrow(/malformed pane/);
  });

  it('rejects a pane whose agent id is not a valid id', () => {
    const dir = workspaceWithPaneMap(
      JSON.stringify({ panes: [{ agent_id: 'Bad Id!', pane_id: '%0' }] }),
    );
    expect(() => loadRelayPanes(dir, 'crew-demo')).toThrow();
  });

  it('runRelay wires the loop and exits cleanly when the session is already gone', async () => {
    const dir = workspaceWithPaneMap(
      JSON.stringify({ panes: [{ agent_id: 'worker', pane_id: '%0' }] }),
    );
    // has-session reports absent (status 1) -> the loop breaks on the first check,
    // exercising the full runRelay shell (workspace resolve, pane-map load, store
    // open, signal wiring, loop invocation, cleanup) without a real session.
    const io = captureIo({
      cwd: dir,
      runProcess: () => Promise.resolve({ status: 1, stdout: '', stderr: '' }),
    }).io;
    await expect(runRelay(io, { internal: true, session: 'crew-demo' })).resolves.toBeUndefined();
  });
});

describe('crew relay command guards', () => {
  it('refuses without --internal (it is an internal command)', async () => {
    const { io, err } = captureIo({ cwd: '/tmp' });
    expect(await run(['relay', '--session', 'demo'], io)).toBe(2);
    expect(err.join('')).toContain('[USAGE]');
    expect(err.join('')).toContain('internal');
  });

  it('requires --session', async () => {
    const { io } = captureIo({ cwd: '/tmp' });
    expect(await run(['relay', '--internal'], io)).toBe(2);
  });
});
