/**
 * List the crew-owned tmux Team sessions that are live RIGHT NOW, for the
 * Console's Operations view. "Owned" means exactly what `team stop` and pane
 * peek mean by it: a validated pane-map under `.crew/generated/<session>/`
 * whose ownership token still matches the marker on the live tmux session of
 * the same name. Anything that fails that proof — a stale artifact with no
 * live session, a same-name session crew did not launch, a malformed map — is
 * simply omitted, never reported as owned. The listing therefore invents no
 * data: every row corresponds to a session the Console could actually stop.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Io } from '../io.js';
import { resolveWorkspaceRoot } from '../workspace.js';
import { readOwnedSession } from './stop.js';
import type { TmuxAdapter } from './tmux.js';

const PANE_MAP = 'pane-map.json';

/** One live, crew-owned Team session summarized for the Console. */
export interface OwnedSessionSummary {
  readonly sessionName: string;
  /** Every crew-created pane, including the Relay pane. */
  readonly paneCount: number;
  /** Panes bound to an Agent (excludes the non-Agent Relay pane). */
  readonly agentCount: number;
  /** Launch time in epoch SECONDS (the pane-map's write time), matching the Store clock. */
  readonly startedAt: number;
}

export interface ListSessionsDeps {
  readonly adapter: TmuxAdapter;
}

/** The direct child directory names of `.crew/generated/`, or `[]` when absent. */
function generatedSessionNames(root: string): string[] {
  try {
    return readdirSync(join(root, '.crew', 'generated'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // No generated directory yet (or it is unreadable): no owned sessions.
    return [];
  }
}

/**
 * Enumerate the crew-owned sessions that are currently live. The filesystem
 * proof (a valid pane-map) is read first for every candidate; tmux is queried
 * only when the adapter reports tmux is present, and a session is included
 * only when it exists AND its live ownership marker matches the recorded
 * token. Ordering is newest-launch-first so the Console shows recent work at
 * the top.
 */
export async function listOwnedSessions(
  io: Io,
  deps: ListSessionsDeps,
): Promise<OwnedSessionSummary[]> {
  const root = resolveWorkspaceRoot(io.cwd);
  const names = generatedSessionNames(root);
  if (names.length === 0) return [];
  // Without tmux there is nothing to verify as live; report none rather than
  // list sessions whose liveness we cannot prove.
  if (!(await deps.adapter.isPresent())) return [];

  const summaries: OwnedSessionSummary[] = [];
  for (const name of names) {
    let proof;
    try {
      proof = readOwnedSession(root, name);
    } catch {
      // A malformed/missing/foreign pane-map (readOwnedSession only throws
      // CrewError) means "not a crew-owned session" — skip it.
      continue;
    }
    if (!(await deps.adapter.hasSession(name))) continue;
    if ((await deps.adapter.sessionOwner(name)) !== proof.ownershipToken) continue;
    const paneMap = join(root, '.crew', 'generated', name, PANE_MAP);
    summaries.push({
      sessionName: name,
      paneCount: proof.panes.length,
      agentCount: proof.panes.filter((pane) => pane.agentId !== null).length,
      // The pane-map was just validated as readable by readOwnedSession, so
      // its stat drives the launch time directly.
      startedAt: Math.floor(statSync(paneMap).mtimeMs / 1000),
    });
  }
  summaries.sort((a, b) => b.startedAt - a.startedAt);
  return summaries;
}
