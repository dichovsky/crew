/**
 * Stop a crew-owned tmux Team and archive the Agents recorded in its pane map.
 * The generated pane-map plus its marker on the exact live tmux session are the
 * ownership boundary. Both are validated before kill, so stale artifacts and
 * unrelated sessions that reuse a name are never touched.
 */
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { assertAgentId } from '../agent-id.js';
import { CrewError } from '../errors.js';
import { MAX_CONFIG_BYTES, readManagedFile, resolveManagedTarget } from '../fs-safe.js';
import { renderTeamStopResult } from '../format.js';
import type { Io } from '../io.js';
import { openWorkspaceStore } from '../store/index.js';
import { resolveWorkspaceRoot } from '../workspace.js';
import type { PaneMap, PaneMapPane } from './artifacts.js';
import { writeResumeMarker } from './artifacts.js';
import { createTmuxAdapter, type TmuxAdapter } from './tmux.js';

const PANE_MAP = 'pane-map.json';
const PANE_ID = /^%\d+$/;
const OWNERSHIP_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface TeamStopOptions {
  readonly json: boolean;
}

export interface TeamStopDeps {
  readonly adapter: TmuxAdapter;
}

export interface TeamStopResult {
  readonly sessionName: string;
  readonly killed: boolean;
  readonly agentsArchived: number;
}

function paneMapRel(session: string): string {
  return join('.crew', 'generated', session, PANE_MAP);
}

/** True for a Node filesystem error reporting a missing path. */
function isMissingFile(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/** One validated ownership-proof entry: the pane crew created for an Agent. */
export interface OwnedPane {
  /** Null only for the non-Agent Relay pane. */
  readonly agentId: string | null;
  readonly paneId: string;
  readonly window: string;
}

/** Validated generated proof for one exact live launch instance. */
export interface OwnedSession {
  readonly ownershipToken: string;
  readonly panes: readonly OwnedPane[];
}

/**
 * Read the crew-written ownership proof and return its validated pane
 * entries. Exported: the Console peek route reuses this exact gate (11d-2
 * binding supplement) so "owned" means the same thing for peek as for stop —
 * and peek additionally binds its capture to the recorded pane id, never to a
 * caller-supplied name.
 */
export function readOwnedSession(root: string, session: string): OwnedSession {
  const rel = paneMapRel(session);

  // Read in one operation (no existsSync pre-check) so a pane-map that never
  // existed OR vanishes mid-call is the same "not a crew-owned session"
  // NOT_FOUND, never a misleading INVALID_CONFIG.
  let raw: string;
  try {
    raw = readManagedFile(root, rel, MAX_CONFIG_BYTES);
  } catch (err) {
    if (isMissingFile(err)) {
      throw new CrewError('NOT_FOUND', `no crew-owned session named "${session}"`);
    }
    throw err; // INVALID_CONFIG (not-a-file / too-big / bad-UTF-8) surfaces as-is.
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CrewError('INVALID_CONFIG', `${rel} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CrewError('INVALID_CONFIG', `${rel} is not an object`);
  }

  const paneMap = parsed as Partial<PaneMap>;
  if (
    paneMap.schema_version !== 1 ||
    paneMap.session_name !== session ||
    typeof paneMap.ownership_token !== 'string' ||
    !OWNERSHIP_TOKEN.test(paneMap.ownership_token) ||
    typeof paneMap.relay_window !== 'object' ||
    paneMap.relay_window === null ||
    !Array.isArray(paneMap.panes)
  ) {
    throw new CrewError('INVALID_CONFIG', `${rel} is not a valid pane map for "${session}"`);
  }

  const panes: OwnedPane[] = paneMap.panes.map((pane) => {
    if (typeof pane !== 'object' || pane === null) {
      throw new CrewError('INVALID_CONFIG', `${rel} has a malformed pane`);
    }
    const { agent_id: agentId, pane_id: paneId, window } = pane as Partial<PaneMapPane>;
    if (
      typeof agentId !== 'string' ||
      typeof paneId !== 'string' ||
      !PANE_ID.test(paneId) ||
      typeof window !== 'string' ||
      window.length === 0
    ) {
      throw new CrewError('INVALID_CONFIG', `${rel} has a malformed pane`);
    }
    try {
      assertAgentId(agentId);
    } catch {
      throw new CrewError('INVALID_CONFIG', `${rel} has a malformed pane`);
    }
    return { agentId, paneId, window };
  });

  const relay = paneMap.relay_window;
  if (
    typeof relay.present !== 'boolean' ||
    typeof relay.name !== 'string' ||
    relay.name.length === 0 ||
    (relay.present
      ? typeof relay.pane_id !== 'string' || !PANE_ID.test(relay.pane_id)
      : relay.pane_id !== null)
  ) {
    throw new CrewError('INVALID_CONFIG', `${rel} has a malformed Relay window`);
  }
  if (relay.present) {
    panes.push({ agentId: null, paneId: relay.pane_id!, window: relay.name });
  }
  if (new Set(panes.map((pane) => pane.paneId)).size !== panes.length) {
    throw new CrewError('INVALID_CONFIG', `${rel} contains duplicate pane ids`);
  }
  return { ownershipToken: paneMap.ownership_token, panes };
}

/** Retire the name-bearing ownership proof after the owned session is gone. */
function retireOwnershipProof(root: string, session: string): void {
  try {
    unlinkSync(resolveManagedTarget(root, paneMapRel(session)));
  } catch {
    // The live marker remains authoritative even if a local permission error
    // prevents this defense-in-depth cleanup; never mask a completed stop.
  }
}

function archiveMappedAgents(io: Io, root: string, agentIds: readonly string[]): number {
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    let archived = 0;
    for (const agentId of agentIds) {
      try {
        store.leaveAgent(agentId);
        archived++;
      } catch (err) {
        // Pane maps can outlive their registrations; already-archived/missing ids are benign.
        if (
          err instanceof CrewError &&
          (err.code === 'NOT_FOUND' || err.code === 'AGENT_INACTIVE')
        ) {
          continue;
        }
        throw err;
      }
    }
    return archived;
  } finally {
    store.close();
  }
}

/** `crew team stop <session> [--json]`: stop one proven-owned Team session. */
export async function runTeamStop(
  io: Io,
  session: string,
  opts: TeamStopOptions,
  deps: TeamStopDeps = { adapter: createTmuxAdapter(io) },
): Promise<TeamStopResult> {
  const root = resolveWorkspaceRoot(io.cwd);

  // The filesystem half of ownership MUST precede every tmux operation; when
  // the session exists, its live marker must match before kill.
  const proof = readOwnedSession(root, session);
  const agentIds = proof.panes.flatMap((pane) => (pane.agentId === null ? [] : [pane.agentId]));
  if (!(await deps.adapter.isPresent())) {
    throw new CrewError(
      'DEPENDENCY_MISSING',
      'tmux is required to stop a crew-owned Team but was not found',
    );
  }

  let killed = false;
  if (await deps.adapter.hasSession(session)) {
    const liveOwner = await deps.adapter.sessionOwner(session);
    if (liveOwner !== proof.ownershipToken) {
      throw new CrewError('NOT_FOUND', `tmux session "${session}" is not the crew-owned instance`);
    }
    await deps.adapter.killSession(session);
    killed = true;
  }

  const result: TeamStopResult = {
    sessionName: session,
    killed,
    agentsArchived: archiveMappedAgents(io, root, agentIds),
  };
  writeResumeMarker(root, session, {
    schema_version: 1,
    session_name: session,
    stopped_at: io.clock(),
    agents_archived: result.agentsArchived,
    cleanly_stopped: true,
  });
  retireOwnershipProof(root, session);
  renderTeamStopResult(io, result, opts.json);
  return result;
}
