/**
 * Resumable Team recovery: clean-stop marker handling, strict plan matching,
 * and the explicit `crew team resume <session>` entrypoint. A stopped Crew can
 * only be resumed when its clean-stop marker exists, the stored launch plan
 * still matches the current Team/config, and every planned Agent remains an
 * archived exact-id row.
 */
import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CrewError } from '../errors.js';
import { MAX_CONFIG_BYTES, readManagedFile, resolveManagedTarget } from '../fs-safe.js';
import type { Io } from '../io.js';
import { loadLauncherConfig, mergeEffectiveConfig } from './config.js';
import { buildLaunchPlan, type LaunchAssembly, type LaunchPlan } from './plan.js';
import { renderTeamResumeResult } from '../format.js';
import { type LiveLaunchDeps, runLiveLaunch } from './session.js';
import { listOwnedSessions } from './sessions.js';
import type { TmuxAdapter } from './tmux.js';
import { resolveWorkspaceRoot } from '../workspace.js';
import { openWorkspaceStore } from '../store/index.js';
import { readResumeMarker } from './artifacts.js';

const LAUNCH_PLAN = 'launch-plan.json';
const RESUME_MARKER = 'resume.json';

/** One resumable session summary for the Console. */
export interface ResumableSessionSummary {
  readonly sessionName: string;
  readonly team: string;
  readonly stoppedAt: number;
  readonly agentsArchived: number;
}

function sessionRel(session: string, filename: string): string {
  return join('.crew', 'generated', session, filename);
}

function generatedSessionNames(root: string): string[] {
  try {
    return readdirSync(join(root, '.crew', 'generated'), { withFileTypes: true })
      .filter((entry: { isDirectory(): boolean }) => entry.isDirectory())
      .map((entry: { name: string }) => entry.name);
  } catch {
    return [];
  }
}

function parseJson<T>(raw: string, message: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new CrewError('INVALID_CONFIG', message);
  }
}

function readLaunchPlan(root: string, session: string): LaunchPlan {
  const rel = sessionRel(session, LAUNCH_PLAN);
  const raw = readResumeFile(root, rel, session);
  return parseJson<LaunchPlan>(raw, `${rel} is not valid JSON`);
}

/** Map only an absent resume artifact to the public session-not-found error. */
function readResumeFile(root: string, rel: string, session: string): string {
  try {
    return readManagedFile(root, rel, MAX_CONFIG_BYTES);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CrewError('NOT_FOUND', `no cleanly stopped crew-owned session named "${session}"`);
    }
    throw error;
  }
}

function assertResumeMarker(root: string, session: string): void {
  try {
    readResumeMarker(root, session);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CrewError('NOT_FOUND', `no cleanly stopped crew-owned session named "${session}"`);
    }
    throw error;
  }
}

function comparablePlan(plan: LaunchPlan): Omit<LaunchPlan, 'created_at'> {
  const { created_at, ...rest } = plan;
  void created_at;
  return rest;
}

function plansMatch(stored: LaunchPlan, current: LaunchPlan): boolean {
  return JSON.stringify(comparablePlan(stored)) === JSON.stringify(comparablePlan(current));
}

function loadCurrentAssembly(io: Io, team: string): LaunchAssembly {
  const root = resolveWorkspaceRoot(io.cwd);
  const config = mergeEffectiveConfig(loadLauncherConfig(root), {});
  return buildLaunchPlan(io, team, config);
}

function assertArchivedResumable(io: Io, root: string, plan: LaunchPlan): void {
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    for (const entry of plan.roster) {
      const agent = store.getAgent(entry.agent_id);
      if (
        agent === null ||
        agent.status !== 'archived' ||
        agent.role !== entry.role ||
        agent.platformId !== plan.client
      ) {
        throw new CrewError(
          'TEAM_DRIFT',
          `session "${plan.session_name}" is not resumable: Agent "${entry.agent_id}" is not the archived exact match`,
        );
      }
    }
  } finally {
    store.close();
  }
}

function retireResumeMarker(root: string, session: string): void {
  try {
    unlinkSync(resolveManagedTarget(root, sessionRel(session, RESUME_MARKER)));
  } catch {
    // best-effort cleanup only; a successful resume is the real contract.
  }
}

/**
 * List clean-stop resumable sessions that still match the current Team/config
 * and, when tmux is present, are not already live now. Broken leftovers are
 * omitted; `doctor` reports them separately.
 */
export async function listResumableSessions(
  io: Io,
  deps: { readonly adapter: TmuxAdapter },
): Promise<ResumableSessionSummary[]> {
  const root = resolveWorkspaceRoot(io.cwd);
  const names = generatedSessionNames(root);
  if (names.length === 0) return [];
  const tmuxPresent = await deps.adapter.isPresent();
  if (tmuxPresent && (await listOwnedSessions(io, { adapter: deps.adapter })).length > 0) {
    return [];
  }
  const summaries: ResumableSessionSummary[] = [];
  for (const name of names) {
    try {
      const marker = readResumeMarker(root, name);
      const storedPlan = readLaunchPlan(root, name);
      const current = loadCurrentAssembly(io, storedPlan.team);
      if (!plansMatch(storedPlan, current.plan)) continue;
      if (tmuxPresent && (await deps.adapter.hasSession(name))) continue;
      assertArchivedResumable(io, root, storedPlan);
      summaries.push({
        sessionName: name,
        team: storedPlan.team,
        stoppedAt: marker.stopped_at,
        agentsArchived: marker.agents_archived,
      });
    } catch {
      continue;
    }
  }
  summaries.sort((a, b) => b.stoppedAt - a.stoppedAt);
  return summaries;
}

/**
 * `crew team resume <session>`: strict recovery from a clean stop. The stored
 * launch plan must still match current tracked config exactly.
 */
export async function runTeamResume(
  io: Io,
  session: string,
  opts: { readonly json: boolean },
  deps: Pick<LiveLaunchDeps, 'adapter' | 'delay' | 'relayBin'>,
): Promise<void> {
  const root = resolveWorkspaceRoot(io.cwd);
  if (!(await deps.adapter.isPresent())) {
    throw new CrewError(
      'DEPENDENCY_MISSING',
      'tmux is required to resume a crew-owned Team but was not found',
    );
  }
  assertResumeMarker(root, session);
  const storedPlan = readLaunchPlan(root, session);
  if (storedPlan.session_name !== session) {
    throw new CrewError(
      'INVALID_CONFIG',
      `launch-plan.json for "${session}" does not match the session name`,
    );
  }
  if (await deps.adapter.hasSession(session)) {
    throw new CrewError(
      'ALREADY_EXISTS',
      `a tmux session named "${session}" already exists; kill it or choose another session name`,
    );
  }
  const current = loadCurrentAssembly(io, storedPlan.team);
  if (!plansMatch(storedPlan, current.plan)) {
    throw new CrewError(
      'TEAM_DRIFT',
      `session "${session}" is not resumable because the current Team/config no longer matches the stored launch plan`,
    );
  }
  assertArchivedResumable(io, root, storedPlan);
  await runLiveLaunch(
    io,
    {
      ...deps,
      resume: true,
      onLaunched: (result) => {
        renderTeamResumeResult(io, result, opts.json);
      },
    },
    current,
  );
  retireResumeMarker(root, session);
  return;
}
