/**
 * Operator Console action handlers (FR-U13–U19): the write half of the
 * Console surface. Each handler validates one parsed JSON body shape, derives
 * the acting Agent from the authenticated Operator session — the plain Agent
 * `operator` (ADR-0012, FR-U13) — and calls the SAME Store domain method the
 * CLI command uses (FR-U11/FR-U18), so every authority rule (active sender,
 * reviewer-only approve, creator/reviewer-only requeue) stays enforced in one
 * place: the Store. A client-supplied identity field (`from`, `creator`,
 * `actor`) is accepted only when it equals the Operator id and is otherwise a
 * USAGE failure (FR-U14) — the browser can never impersonate another Agent.
 * Content bounds are NOT re-checked here; the Store's schema-CHECK-derived
 * assertions stay the single validation authority.
 */
import { CrewError } from '../errors.js';
import { sanitizeHuman } from '../format.js';
import type { Io } from '../io.js';
import { loadLauncherConfig, mergeEffectiveConfig } from '../launcher/config.js';
import { listResumableSessions, runTeamResume } from '../launcher/resume.js';
import { renderLaunchResult } from '../launcher/index.js';
import { buildLaunchPlan } from '../launcher/plan.js';
import { runLiveLaunch } from '../launcher/session.js';
import { listOwnedSessions } from '../launcher/sessions.js';
import { readOwnedSession, runTeamStop } from '../launcher/stop.js';
import type { TmuxAdapter } from '../launcher/tmux.js';
import { runClean, runPrune } from '../maintenance.js';
import { openWorkspaceStore } from '../store/index.js';
import type { MessageRecord, Store, TaskRecord } from '../store/index.js';
import { resolveWorkspaceRoot } from '../workspace.js';
import type { MessageSnapshotRecord, TaskSnapshotRecord } from './snapshot.js';

/** The human Operator's plain Agent id (ADR-0012: "the first-class Agent `operator`"). */
export const OPERATOR_AGENT_ID = 'operator';

/**
 * FR-U13: the human Operator is a plain Agent row (`operator`, platform NULL,
 * no packaged-role or schema change). Ensure it exists on the given Store —
 * create when absent, reactivate when archived, leave an active row
 * untouched — so every Console action has its session-derived actor. A row
 * that holds the id but is NOT that plain operator identity (different role,
 * or a platform-bound Agent someone joined as "operator") is never silently
 * adopted: the caller refuses instead. Called both at Console startup
 * (`runUi`) and whenever the server reopens a fresh Store after a
 * deleted-Workspace recovery (FR-U32) — a re-initialized workspace has no
 * operator row of its own, and the abandon-fallback authority keys
 * on this exact identity, so recovery must re-establish it too.
 */
export function ensureOperatorAgent(store: Store): void {
  const existing = store
    .listAgents({ includeArchived: true })
    .find((agent) => agent.id === OPERATOR_AGENT_ID);
  if (existing === undefined) {
    store.joinAgent({ id: OPERATOR_AGENT_ID, role: 'operator' });
    return;
  }
  if (existing.role !== 'operator' || existing.platformId !== null) {
    throw new CrewError(
      'ALREADY_EXISTS',
      `agent "${OPERATOR_AGENT_ID}" exists with role "${existing.role}"` +
        `${existing.platformId === null ? '' : ` on platform "${existing.platformId}"`}` +
        ' — the Console requires the plain operator row; archive or rename that agent first',
    );
  }
  if (existing.status === 'archived') {
    store.joinAgent({ id: OPERATOR_AGENT_ID, resume: true });
  }
}

/** The CLI `task` NDJSON record: a Task without its Event timeline. */
export type TaskActionRecord = Omit<TaskSnapshotRecord, 'events'>;

/**
 * The exact mutating Store surface the Console actions may call — the four
 * FR-U19 Message/Task actions and nothing else. The full Store satisfies this
 * structurally; narrowing the parameter keeps any other write (join, leave,
 * start, submit, prune) a compile error in this module.
 */
export interface ActionStore {
  sendMessages(input: {
    senderId: string;
    recipientId: string;
    content: string;
    replyTo?: number;
  }): MessageRecord[];
  createTask(input: {
    creatorId: string;
    assigneeId: string;
    reviewerId: string;
    title: string;
    body?: string;
  }): TaskRecord;
  approveTask(reviewerId: string, taskId: string, summary?: string | null): TaskRecord;
  requeueTask(input: { actorId: string; taskId: string; reason: string; to?: string }): TaskRecord;
}

/** Mirror of the CLI `message` NDJSON record (raw stored bytes, never rewritten). */
function messageRecord(message: MessageRecord): MessageSnapshotRecord {
  return {
    type: 'message',
    schema_version: 1,
    id: message.id,
    sender_id: message.senderId,
    recipient_id: message.recipientId,
    content: message.content,
    kind: message.kind,
    task_id: message.taskId,
    reply_to: message.replyTo,
    created_at: message.createdAt,
    read_at: message.readAt,
  };
}

/** Mirror of the CLI `task` NDJSON record. */
function taskRecord(task: TaskRecord): TaskActionRecord {
  return {
    type: 'task',
    schema_version: 1,
    id: task.id,
    title: task.title,
    body: task.body,
    creator_id: task.creatorId,
    assignee_id: task.assigneeId,
    reviewer_id: task.reviewerId,
    status: task.status,
    revision: task.revision,
    lease_owner_id: task.leaseOwnerId,
    lease_expires_at: task.leaseExpiresAt,
    submission_summary: task.submissionSummary,
    submitted_at: task.submittedAt,
    review_summary: task.reviewSummary,
    completed_at: task.completedAt,
    abandoned_at: task.abandonedAt,
    worktree_path: task.worktreePath,
    worktree_branch: task.worktreeBranch,
    worktree_base_ref: task.worktreeBaseRef,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    stale_lease: task.staleLease,
  };
}

/** Require a JSON object body whose keys all belong to the route's shape. */
function bodyFields(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new CrewError('USAGE', 'request body must be a JSON object');
  }
  const fields = body as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) {
      throw new CrewError('USAGE', `unexpected field "${key}"`);
    }
  }
  return fields;
}

function requiredString(fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  if (value === undefined) throw new CrewError('USAGE', `"${key}" is required`);
  if (typeof value !== 'string') throw new CrewError('USAGE', `"${key}" must be a string`);
  return value;
}

function optionalString(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new CrewError('USAGE', `"${key}" must be a string`);
  return value;
}

/**
 * The Operator session is the actor on every action; a client-supplied
 * identity field must equal it (FR-U13/U14) — anything else is rejected.
 */
function assertOperatorField(fields: Record<string, unknown>, key: string): void {
  const value = fields[key];
  if (value !== undefined && value !== OPERATOR_AGENT_ID) {
    throw new CrewError('USAGE', `"${key}" must be omitted or equal "${OPERATOR_AGENT_ID}"`);
  }
}

/** `POST /api/messages` — send a note from the Operator (FR-U14). */
export function sendMessage(
  store: ActionStore,
  body: unknown,
): { messages: MessageSnapshotRecord[] } {
  const fields = bodyFields(body, ['from', 'to', 'content', 'replyTo']);
  assertOperatorField(fields, 'from');
  const to = requiredString(fields, 'to');
  const content = requiredString(fields, 'content');
  const replyTo = fields['replyTo'];
  if (replyTo !== undefined && typeof replyTo !== 'number') {
    throw new CrewError('USAGE', '"replyTo" must be a number');
  }
  const messages = store.sendMessages({
    senderId: OPERATOR_AGENT_ID,
    recipientId: to,
    content,
    ...(replyTo !== undefined ? { replyTo } : {}),
  });
  return { messages: messages.map(messageRecord) };
}

/** `POST /api/tasks` — create a Task with any assignee/reviewer (FR-U15). */
export function createTask(store: ActionStore, body: unknown): { task: TaskActionRecord } {
  const fields = bodyFields(body, ['creator', 'assignee', 'reviewer', 'title', 'body']);
  assertOperatorField(fields, 'creator');
  const assignee = requiredString(fields, 'assignee');
  const reviewer = requiredString(fields, 'reviewer');
  const title = requiredString(fields, 'title');
  const taskBody = optionalString(fields, 'body');
  const task = store.createTask({
    creatorId: OPERATOR_AGENT_ID,
    assigneeId: assignee,
    reviewerId: reviewer,
    title,
    ...(taskBody !== undefined ? { body: taskBody } : {}),
  });
  return { task: taskRecord(task) };
}

/** `POST /api/tasks/:id/approve` — reviewer authority stays in the Store (FR-U16). */
export function approveTask(
  store: ActionStore,
  taskId: string,
  body: unknown,
): { task: TaskActionRecord } {
  const fields = bodyFields(body, ['actor', 'summary']);
  assertOperatorField(fields, 'actor');
  const summary = optionalString(fields, 'summary');
  return { task: taskRecord(store.approveTask(OPERATOR_AGENT_ID, taskId, summary ?? null)) };
}

/**
 * FR-U25: destructive Console actions require an explicit confirmation flag —
 * a single `{ "confirm": true }` in the body, set by the Console's confirm
 * modal. This is not a CSRF defense (the bearer token is); it stops a bare,
 * bodyless POST from firing an irreversible action, and keeps the server's
 * gate independent of the client's modal. Absence or any non-`true` value is a
 * USAGE failure.
 */
function assertConfirmed(fields: Record<string, unknown>): void {
  if (fields['confirm'] !== true) {
    throw new CrewError('USAGE', 'confirmation is required: send { "confirm": true }');
  }
}

/** The tmux-facing dependencies of the team/peek routes (injectable for tests). */
export interface TeamActionDeps {
  readonly io: Io;
  readonly adapter: TmuxAdapter;
  /** Launch readiness-poll delay; tests inject an instant one. */
  readonly delay: (ms: number) => Promise<void>;
  /** Base argv for the launched Relay window command. */
  readonly relayBin: readonly string[];
}

/**
 * Run an existing CLI command in-process with a captured Io in JSON mode and
 * return its single NDJSON result record (the /api/health collectHealth
 * pattern): the Console invokes the command implementations verbatim (FR-U18)
 * and surfaces the exact record shape the CLI emits.
 */
async function capturedRecord(
  io: Io,
  run: (captured: Io) => void | Promise<void>,
): Promise<Record<string, unknown>> {
  const lines: string[] = [];
  const captured: Io = {
    ...io,
    stdout: (text) => {
      lines.push(text);
    },
    stderr: () => {},
  };
  await run(captured);
  const record = lines
    .join('')
    .split('\n')
    .find((line) => line.length > 0);
  if (record === undefined) {
    throw new CrewError('INTEGRITY', 'the command produced no result record');
  }
  return JSON.parse(record) as Record<string, unknown>;
}

/**
 * `POST /api/team/launch` — a DETACHED live launch of a configured Team
 * (FR-U19/U20): the plan resolves through the existing Team config exactly as
 * `crew team <name> --launch` would, and Task 1's `noAttach` seam guarantees
 * no attach call ever reaches the tmux adapter (ADR-0012: attach stays a
 * terminal-only action). Unconfirmed: a launch is not destructive.
 */
export async function launchTeam(
  deps: TeamActionDeps,
  body: unknown,
): Promise<{ launch: Record<string, unknown> }> {
  const fields = bodyFields(body, ['team']);
  const team = requiredString(fields, 'team');
  const { io } = deps;
  const config = mergeEffectiveConfig(loadLauncherConfig(resolveWorkspaceRoot(io.cwd)), {});
  const assembly = buildLaunchPlan(io, team, config);
  // Mirrored from runLaunch: a worktree-enabled LIVE launch is deferred.
  if (assembly.plan.worktree.enabled) {
    throw new CrewError(
      'USAGE',
      'automatic launch into a worktree is not yet available; disable the worktree for this team or launch from the terminal',
    );
  }
  const launch = await capturedRecord(io, async (captured) => {
    await runLiveLaunch(
      io,
      {
        adapter: deps.adapter,
        delay: deps.delay,
        relayBin: deps.relayBin,
        noAttach: true,
        onLaunched: (result) => {
          renderLaunchResult(captured, result, true);
        },
      },
      assembly,
    );
  });
  return { launch };
}

/**
 * `POST /api/team/resume` — a DETACHED recovery launch of a cleanly stopped
 * Team session. The stored launch plan must still match the current Team
 * config exactly; broken leftovers are for `doctor` to diagnose, not repair.
 */
export async function resumeTeam(
  deps: TeamActionDeps,
  body: unknown,
): Promise<{ resume: Record<string, unknown> }> {
  const fields = bodyFields(body, ['session']);
  const session = requiredString(fields, 'session');
  const resume = await capturedRecord(deps.io, async (captured) => {
    await runTeamResume(captured, session, { json: true }, deps);
  });
  return { resume };
}

/**
 * `POST /api/team/stop` — stop one proven-owned session via the unchanged
 * `runTeamStop` (FR-U26–U29 reused: pane-map ownership proof, already-gone
 * NOT_FOUND path; TOCTOU is handled-by-reuse, never claimed atomic). Gated by
 * the FR-U25 confirmation flag.
 */
export async function stopTeam(
  deps: TeamActionDeps,
  body: unknown,
): Promise<{ stop: Record<string, unknown> }> {
  const fields = bodyFields(body, ['session', 'confirm']);
  const session = requiredString(fields, 'session');
  assertConfirmed(fields);
  const stop = await capturedRecord(deps.io, async (captured) => {
    await runTeamStop(captured, session, { json: true }, { adapter: deps.adapter });
  });
  return { stop };
}

/** Mirror of the CLI-style `session` NDJSON record for the Console Operations view. */
export interface SessionSnapshotRecord {
  readonly type: 'session';
  readonly schema_version: 1;
  readonly session_name: string;
  readonly pane_count: number;
  readonly agent_count: number;
  readonly started_at: number;
}

/**
 * `GET /api/sessions` — the crew-owned tmux Team sessions that are live now
 * (FR-U19 read side of the Operations Teams panel). Reuses the same pane-map
 * ownership proof as `team stop`/peek via {@link listOwnedSessions}, so a row
 * appears only for a session the Console could actually stop; a bare launch
 * form with no live sessions returns `{ sessions: [] }`.
 */
export async function listSessions(
  deps: TeamActionDeps,
): Promise<{ sessions: SessionSnapshotRecord[] }> {
  const owned = await listOwnedSessions(deps.io, { adapter: deps.adapter });
  return {
    sessions: owned.map((session) => ({
      type: 'session',
      schema_version: 1,
      session_name: session.sessionName,
      pane_count: session.paneCount,
      agent_count: session.agentCount,
      started_at: session.startedAt,
    })),
  };
}

/** Mirror of the resumable-session record for the Console Operations view. */
export interface ResumableSessionSnapshotRecord {
  readonly type: 'resumable_session';
  readonly schema_version: 1;
  readonly session_name: string;
  readonly team: string;
  readonly stopped_at: number;
  readonly agents_archived: number;
}

/**
 * `GET /api/resumable-sessions` — clean-stop-only sessions that still match the
 * current Team/config and can be resumed explicitly.
 */
export async function listResumableTeamSessions(
  deps: TeamActionDeps,
): Promise<{ resumable_sessions: ResumableSessionSnapshotRecord[] }> {
  const resumableSessions = await listResumableSessions(deps.io, { adapter: deps.adapter });
  return {
    resumable_sessions: resumableSessions.map((session) => ({
      type: 'resumable_session',
      schema_version: 1,
      session_name: session.sessionName,
      team: session.team,
      stopped_at: session.stoppedAt,
      agents_archived: session.agentsArchived,
    })),
  };
}

/**
 * `GET /api/peek` — the sanitized visible text of one owned pane target
 * (FR-U19). Ownership is proven exactly like `team stop`: the crew-written
 * pane-map under `.crew/generated/<session>/` must validate, else NOT_FOUND
 * BEFORE tmux is ever invoked — the Console is never a generic tmux reader.
 * The capture is then bound to the pane id the map RECORDS at launch, never
 * to a caller-supplied name: a stale map (crew session gone, an unrelated
 * same-name session running) points at pane ids that no longer exist, so the
 * capture fails NOT_FOUND instead of reading a foreign session's screen, and
 * a window the map does not list is NOT_FOUND outright. The capture is
 * control-stripped with the same central sanitizer the human surface uses:
 * the deliberate FR-U24 EXCEPTION to the raw-bytes JSON rule, because
 * captured terminal output can carry hostile escape sequences.
 */
export async function peekPane(
  deps: TeamActionDeps,
  sessionParam: string | null,
  windowParam: string | null,
): Promise<{ peek: Record<string, unknown> }> {
  if (sessionParam === null || sessionParam.length === 0) {
    throw new CrewError('USAGE', 'the session query parameter is required');
  }
  if (windowParam !== null && windowParam.length === 0) {
    throw new CrewError('USAGE', 'the window query parameter must not be empty');
  }
  const proof = readOwnedSession(resolveWorkspaceRoot(deps.io.cwd), sessionParam);
  if (!(await deps.adapter.isPresent())) {
    throw new CrewError('DEPENDENCY_MISSING', 'tmux is required for pane peek but was not found');
  }
  if (!(await deps.adapter.hasSession(sessionParam))) {
    throw new CrewError('NOT_FOUND', `the crew-owned session "${sessionParam}" is no longer live`);
  }
  if ((await deps.adapter.sessionOwner(sessionParam)) !== proof.ownershipToken) {
    throw new CrewError(
      'NOT_FOUND',
      `tmux session "${sessionParam}" is not the crew-owned instance`,
    );
  }
  const panes = proof.panes;
  const pane = windowParam === null ? panes[0] : panes.find((p) => p.window === windowParam);
  if (pane === undefined) {
    throw new CrewError(
      'NOT_FOUND',
      `session "${sessionParam}" has no crew-owned window "${windowParam ?? ''}"`,
    );
  }
  let raw: string;
  try {
    raw = await deps.adapter.capturePane(pane.paneId);
  } catch {
    throw new CrewError(
      'NOT_FOUND',
      `the crew-owned pane for "${sessionParam}:${pane.window}" is no longer live`,
    );
  }
  const text = sanitizeHuman(raw);
  return { peek: { target: `${sessionParam}:${pane.window}`, pane: pane.paneId, text } };
}

/**
 * `POST /api/prune` — the CLI prune with its default retention windows and
 * never a vacuum (a vacuum would always refuse while the Console's own
 * operator row is active). Gated by the FR-U25 confirmation flag.
 */
export async function pruneWorkspace(
  io: Io,
  body: unknown,
): Promise<{ prune: Record<string, unknown> }> {
  const fields = bodyFields(body, ['confirm']);
  assertConfirmed(fields);
  const prune = await capturedRecord(io, (captured) => {
    runPrune(captured, { vacuum: false, json: true });
  });
  return { prune };
}

/**
 * `POST /api/clean` — the CLI clean WITHOUT `--force`, so the CLI's guard
 * is reused verbatim for every OTHER Agent: it refuses with ACTIVE_AGENTS
 * while any active non-operator row exists. The Console's own actor is the
 * one row `crew ui` itself ensured at startup (FR-U13), so counting it would
 * make this route permanently unsatisfiable from the real Console: the
 * handler archives that own row first, runs the guarded clean, and restores
 * the row if the clean refuses. After a successful clean the State Store
 * files are gone; the server rejects later requests and the `crew ui`
 * lifecycle closes its pre-opened Store and exits, so no route can serve an
 * orphaned connection or implicitly recreate state. Gated by FR-U25.
 */
export async function cleanWorkspace(
  io: Io,
  body: unknown,
): Promise<{ clean: Record<string, unknown> }> {
  const fields = bodyFields(body, ['confirm']);
  assertConfirmed(fields);
  const root = resolveWorkspaceRoot(io.cwd);
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  let archivedOwnRow = false;
  try {
    const operator = store
      .listAgents({ includeArchived: false })
      .find((agent) => agent.id === OPERATOR_AGENT_ID);
    if (operator !== undefined) {
      store.leaveAgent(OPERATOR_AGENT_ID);
      archivedOwnRow = true;
    }
  } finally {
    // The connection must be closed before clean deletes the files under it.
    store.close();
  }
  try {
    const clean = await capturedRecord(io, (captured) => {
      runClean(captured, { force: false, json: true });
    });
    return { clean };
  } catch (err) {
    if (archivedOwnRow) {
      // Best effort: the clean refused (e.g. other active Agents), so put the
      // Console's own actor back; the original failure stays the result.
      try {
        const restore = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
        try {
          restore.joinAgent({ id: OPERATOR_AGENT_ID, resume: true });
        } finally {
          restore.close();
        }
      } catch {
        // The original error is the one the Operator needs to see.
      }
    }
    throw err;
  }
}

/** `POST /api/tasks/:id/requeue` — creator/reviewer authority stays in the Store (FR-U17). */
export function requeueTask(
  store: ActionStore,
  taskId: string,
  body: unknown,
): { task: TaskActionRecord } {
  const fields = bodyFields(body, ['actor', 'reason', 'to']);
  assertOperatorField(fields, 'actor');
  const reason = requiredString(fields, 'reason');
  const to = optionalString(fields, 'to');
  const task = store.requeueTask({
    actorId: OPERATOR_AGENT_ID,
    taskId,
    reason,
    ...(to !== undefined ? { to } : {}),
  });
  return { task: taskRecord(task) };
}
