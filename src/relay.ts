/**
 * The internal `crew relay` Relay. Launched as the
 * `crew-relay` tmux window's command, it is the session-scoped process that wakes
 * idle Agents without consuming their Inbox (ADR-0001). Each poll it reads every
 * Agent's content-free summary via the SHARED `getPendingSummary` query (no
 * `receive`, never marks rows read), feeds the observations to the pure
 * `relayStep` reducer, and pastes ONLY the fixed nudge into the
 * Agent's pane (FR-H15/H17). It never injects Message content.
 *
 * The loop is a thin tick-driver over fully injected seams so stop-on-signal /
 * session-gone / workspace-gone (FR-H20) and the nudge path are unit-testable
 * without real timers, signals, or tmux.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { assertAgentId } from './agent-id.js';
import { realDelay } from './delay.js';
import { CrewError } from './errors.js';
import { MAX_CONFIG_BYTES, readManagedFile } from './fs-safe.js';
import type { Io } from './io.js';
import { loadLauncherConfig } from './launcher/config.js';
import {
  relayStep,
  type RelayState,
  type StaleLeaseObservation,
  staleLeaseStep,
  type StaleLeaseState,
} from './launcher/relay.js';
import { createTmuxAdapter, type TmuxAdapter } from './launcher/tmux.js';
import { type InboxState, openWorkspaceStore, type StaleLeaseTask } from './store/index.js';
import { resolveWorkspaceRoot, workspacePaths } from './workspace.js';

const NUDGE_BUFFER = 'crewnudge';

/** The single fixed nudge — a command to RUN, never Message content (FR-H17). */
export function nudgeText(agentId: string): string {
  return `Crew inbox changed. Run: crew receive ${agentId}`;
}

/** The fixed stale-lease reminder — a command to RUN, never Task content. */
export function staleLeaseNudgeText(taskId: string): string {
  return `Task ${taskId}'s Lease is stale. Run: crew task requeue <you> ${taskId} --reason <text> (or abandon it).`;
}

interface RelayPane {
  readonly agentId: string;
  readonly paneId: string;
}

/** The content-free summary source — satisfied by the Store's getPendingSummary. */
export interface RelaySummarySource {
  getPendingSummary(agentId: string): InboxState;
}

/** The stale-lease source — satisfied by the Store's listStaleLeaseTasks. */
export interface RelayStaleLeaseSource {
  listStaleLeaseTasks(): StaleLeaseTask[];
}

/** The tmux operations the Relay needs to paste a nudge and detect a dead session. */
export type RelayNudgeAdapter = Pick<
  TmuxAdapter,
  'hasSession' | 'setBufferArg' | 'pasteBuffer' | 'sendEnter'
>;

export interface RelayLoopDeps {
  readonly summaries: RelaySummarySource;
  readonly staleLeases: RelayStaleLeaseSource;
  readonly adapter: RelayNudgeAdapter;
  readonly delay: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly workspaceExists: () => boolean;
  readonly shouldStop: () => boolean;
}

export interface RelayLoopConfig {
  readonly session: string;
  readonly panes: readonly RelayPane[];
  readonly pollMs: number;
  readonly reminderSeconds: number;
}

const STALE_LEASE_NUDGE_BUFFER = 'crewstalenudge';

/** Run one poll: read summaries, decide nudges, paste each (best-effort per pane). */
export async function relayTick(
  deps: RelayLoopDeps,
  config: RelayLoopConfig,
  state: RelayState,
  staleLeaseState: StaleLeaseState = new Map(),
): Promise<{
  state: RelayState;
  staleLeaseState: StaleLeaseState;
  nudged: readonly string[];
  staleLeaseNudged: readonly string[];
}> {
  const now = deps.now();
  const observations = config.panes.flatMap((pane) => {
    try {
      const summary = deps.summaries.getPendingSummary(pane.agentId);
      return [
        {
          agentId: pane.agentId,
          unreadCount: summary.unreadCount,
          maxUnreadId: summary.maxUnreadId,
        },
      ];
    } catch {
      // A transient Store error (e.g. CONTENTION) or an absent row must not crash
      // the long-lived Relay: skip this Agent this tick — the next tick re-reads —
      // mirroring the best-effort paste path below (FR-H20 resilience).
      return [];
    }
  });
  const decision = relayStep(state, observations, now, {
    reminderSeconds: config.reminderSeconds,
  });
  const nudged: string[] = [];
  for (const agentId of decision.nudges) {
    const pane = config.panes.find((p) => p.agentId === agentId);
    if (pane === undefined) continue;
    try {
      await deps.adapter.setBufferArg(NUDGE_BUFFER, nudgeText(agentId));
      await deps.adapter.pasteBuffer({ bufferName: NUDGE_BUFFER, target: pane.paneId });
      await deps.adapter.sendEnter(pane.paneId);
      nudged.push(agentId);
    } catch {
      // Best-effort per pane: a closed/dead pane is skipped, never fatal to the loop.
    }
  }

  // A Lease crossing its expiry is otherwise a purely passive fact —
  // no row is written when the clock ticks past it — so without this, only a
  // human polling `doctor` would ever notice. Same best-effort resilience as
  // the inbox path; a separate buffer name so a creator who ALSO has unread
  // work this tick gets both pastes intact, never one clobbering the other.
  let staleObservations: readonly StaleLeaseObservation[] = [];
  try {
    staleObservations = deps.staleLeases
      .listStaleLeaseTasks()
      .map((task) => ({ taskId: task.taskId, creatorId: task.creatorId }));
  } catch {
    // Transient Store error: skip this tick, the next tick re-reads.
  }
  const staleLeaseDecision = staleLeaseStep(staleLeaseState, staleObservations, now, {
    reminderSeconds: config.reminderSeconds,
  });
  const staleLeaseNudged: string[] = [];
  for (const { taskId, creatorId } of staleLeaseDecision.nudges) {
    const pane = config.panes.find((p) => p.agentId === creatorId);
    if (pane === undefined) continue;
    try {
      await deps.adapter.setBufferArg(STALE_LEASE_NUDGE_BUFFER, staleLeaseNudgeText(taskId));
      await deps.adapter.pasteBuffer({ bufferName: STALE_LEASE_NUDGE_BUFFER, target: pane.paneId });
      await deps.adapter.sendEnter(pane.paneId);
      staleLeaseNudged.push(creatorId);
    } catch {
      // Best-effort per pane: a closed/dead pane is skipped, never fatal to the loop.
    }
  }

  return {
    state: decision.state,
    staleLeaseState: staleLeaseDecision.state,
    nudged,
    staleLeaseNudged,
  };
}

/** The Relay loop: tick, sleep, and stop on signal / session-gone / workspace-gone (FR-H20). */
export async function runRelayLoop(deps: RelayLoopDeps, config: RelayLoopConfig): Promise<void> {
  let state: RelayState = new Map();
  let staleLeaseState: StaleLeaseState = new Map();
  while (!deps.shouldStop()) {
    if (!deps.workspaceExists()) break;
    if (!(await deps.adapter.hasSession(config.session))) break;
    // relayTick is internally resilient: the per-Agent summary read and per-pane
    // paste are each guarded, so a transient Store error (e.g. CONTENTION) or a dead
    // pane skips that Agent for the tick rather than crashing the long-lived
    // Relay. FR-H20 stop conditions (signal / workspace-gone / session-gone)
    // are the only loop exits.
    ({ state, staleLeaseState } = await relayTick(deps, config, state, staleLeaseState));
    if (deps.shouldStop()) break;
    await deps.delay(config.pollMs);
  }
}

/** Read and validate the realized agent→pane mapping from the session's pane-map.json. */
export function loadRelayPanes(root: string, session: string): RelayPane[] {
  const rel = join('.crew', 'generated', session, 'pane-map.json');
  // Report an ABSENT pane-map as NOT_FOUND, not a misleading "invalid JSON": the
  // file is missing when the session was never launched or was pruned.
  if (!existsSync(join(root, rel))) {
    throw new CrewError(
      'NOT_FOUND',
      `no pane-map.json for session "${session}"; was the session launched with \`crew team … --launch\`?`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readManagedFile(root, rel, MAX_CONFIG_BYTES));
  } catch (err) {
    if (err instanceof CrewError) throw err;
    throw new CrewError(
      'INVALID_CONFIG',
      `pane-map.json for session "${session}" is not valid JSON`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CrewError(
      'INVALID_CONFIG',
      `pane-map.json for session "${session}" is not an object`,
    );
  }
  const panes = (parsed as { panes?: unknown }).panes;
  if (!Array.isArray(panes)) {
    throw new CrewError(
      'INVALID_CONFIG',
      `pane-map.json for session "${session}" has no panes array`,
    );
  }
  return panes.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new CrewError(
        'INVALID_CONFIG',
        `pane-map.json for session "${session}" has a malformed pane`,
      );
    }
    const agentId = (entry as { agent_id?: unknown }).agent_id;
    const paneId = (entry as { pane_id?: unknown }).pane_id;
    if (typeof agentId !== 'string' || typeof paneId !== 'string' || paneId.length === 0) {
      throw new CrewError(
        'INVALID_CONFIG',
        `pane-map.json for session "${session}" has a malformed pane`,
      );
    }
    assertAgentId(agentId); // defense-in-depth: validate before it ever reaches a nudge
    return { agentId, paneId };
  });
}

interface RelayOptions {
  readonly internal?: boolean;
  readonly session?: string;
}

/** `crew relay --internal --session <name>`: service one launched session until it ends. */
export async function runRelay(io: Io, options: RelayOptions): Promise<void> {
  if (options.internal !== true) {
    throw new CrewError(
      'USAGE',
      'crew relay is an internal Launcher command, started automatically by `crew team <name> --launch`',
    );
  }
  const session = options.session;
  if (session === undefined || session.length === 0) {
    throw new CrewError('USAGE', 'crew relay requires --session');
  }
  const root = resolveWorkspaceRoot(io.cwd);
  const panes = loadRelayPanes(root, session);
  const config = loadLauncherConfig(root);
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  const adapter = createTmuxAdapter(io);

  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('SIGHUP', stop);
  try {
    await runRelayLoop(
      {
        summaries: store,
        staleLeases: store,
        adapter,
        delay: realDelay,
        now: io.clock,
        workspaceExists: () => existsSync(workspacePaths(root).crew),
        shouldStop: () => stopped,
      },
      {
        session,
        panes,
        pollMs: config.relay.pollSeconds * 1000,
        reminderSeconds: config.relay.reminderSeconds,
      },
    );
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    process.off('SIGHUP', stop);
    store.close();
  }
}
