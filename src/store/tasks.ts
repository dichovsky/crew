/**
 * Internal Task and Task Event SQL, row mapping, and the reviewed-lifecycle
 * transitions. The public domain operations are thin wrappers on Store that
 * supply the operation clock and the `BEGIN IMMEDIATE` transaction; the logic
 * here runs inside that writer transaction so each transition's CAS update,
 * Task Event, and notification commit atomically (FR-E01-E21, FR-I12-I14).
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CrewError } from '../errors.js';
import { insertNotification, type MessageKind } from './messages.js';

export type TaskStatus = 'queued' | 'in_progress' | 'submitted' | 'completed' | 'abandoned';
export type TaskEventType =
  'created' | 'started' | 'submitted' | 'approved' | 'requeued' | 'abandoned';

/** A Task Lease lasts 15 minutes from the start operation (data-model "Tasks"). */
const LEASE_SECONDS = 900;

/** A test-only seam: transitions call it at labeled points so a spawned process
 * can crash deterministically mid-transaction. Production passes nothing. */
export type TransactionStep = (label: string) => void;

export interface TaskRecord {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly creatorId: string;
  readonly assigneeId: string;
  readonly reviewerId: string;
  readonly status: TaskStatus;
  readonly revision: number;
  readonly leaseOwnerId: string | null;
  readonly leaseExpiresAt: number | null;
  readonly submissionSummary: string | null;
  readonly submittedAt: number | null;
  readonly reviewSummary: string | null;
  readonly completedAt: number | null;
  readonly abandonedAt: number | null;
  readonly worktreePath: string | null;
  readonly worktreeBranch: string | null;
  readonly worktreeBaseRef: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly staleLease: boolean;
}

/** The on-disk worktree to record when an assignee starts a Task. */
export interface TaskWorktreeInput {
  readonly path: string;
  readonly branch: string;
  readonly baseRef: string;
}

export interface TaskEventRecord {
  readonly id: number;
  readonly taskId: string;
  readonly revision: number;
  readonly eventType: TaskEventType;
  readonly actorId: string;
  readonly fromStatus: TaskStatus | null;
  readonly toStatus: TaskStatus;
  readonly detail: string;
  readonly createdAt: number;
}

export interface CreateTaskInput {
  readonly creatorId: string;
  readonly assigneeId: string;
  readonly reviewerId: string;
  readonly title: string;
  readonly body: string;
}

export interface TaskListFilter {
  readonly assigneeId?: string;
  readonly reviewerId?: string;
  readonly status?: TaskStatus;
  readonly staleLease?: boolean;
}

interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly creator_id: string;
  readonly assignee_id: string;
  readonly reviewer_id: string;
  readonly status: TaskStatus;
  readonly revision: number;
  readonly lease_owner_id: string | null;
  readonly lease_expires_at: number | null;
  readonly submission_summary: string | null;
  readonly submitted_at: number | null;
  readonly review_summary: string | null;
  readonly completed_at: number | null;
  readonly abandoned_at: number | null;
  readonly worktree_path: string | null;
  readonly worktree_branch: string | null;
  readonly worktree_base_ref: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface TaskEventRow {
  readonly id: number;
  readonly task_id: string;
  readonly revision: number;
  readonly event_type: TaskEventType;
  readonly actor_id: string;
  readonly from_status: TaskStatus | null;
  readonly to_status: TaskStatus;
  readonly detail: string;
  readonly created_at: number;
}

const NOTIFY_VERB: Record<Exclude<MessageKind, 'note' | 'clear_safe'>, string> = {
  task_assigned: 'assigned',
  task_submitted: 'submitted for review',
  task_approved: 'approved',
  task_requeued: 'requeued',
};

function isStale(row: TaskRow, now: number): boolean {
  return (
    row.status === 'in_progress' && row.lease_expires_at !== null && row.lease_expires_at <= now
  );
}

function mapTask(row: TaskRow, now: number): TaskRecord {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    creatorId: row.creator_id,
    assigneeId: row.assignee_id,
    reviewerId: row.reviewer_id,
    status: row.status,
    revision: row.revision,
    leaseOwnerId: row.lease_owner_id,
    leaseExpiresAt: row.lease_expires_at,
    submissionSummary: row.submission_summary,
    submittedAt: row.submitted_at,
    reviewSummary: row.review_summary,
    completedAt: row.completed_at,
    abandonedAt: row.abandoned_at,
    worktreePath: row.worktree_path,
    worktreeBranch: row.worktree_branch,
    worktreeBaseRef: row.worktree_base_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    staleLease: isStale(row, now),
  };
}

function mapTaskEvent(row: TaskEventRow): TaskEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    revision: row.revision,
    eventType: row.event_type,
    actorId: row.actor_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

function loadTaskRow(db: DatabaseSync, id: string): TaskRow | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as
    TaskRow | undefined;
  return row ?? null;
}

function requireTaskRow(db: DatabaseSync, id: string): TaskRow {
  const row = loadTaskRow(db, id);
  if (row === null) throw new CrewError('NOT_FOUND', `no task with id "${id}"`);
  return row;
}

function agentStatus(db: DatabaseSync, id: string): 'active' | 'archived' | null {
  const row = db.prepare('SELECT status FROM agents WHERE id = ?').get(id) as unknown as
    { status: 'active' | 'archived' } | undefined;
  return row?.status ?? null;
}

/** Require an Agent that exists and is active, else NOT_FOUND/AGENT_INACTIVE. */
function assertActiveAgent(db: DatabaseSync, id: string): void {
  const status = agentStatus(db, id);
  if (status === null) throw new CrewError('NOT_FOUND', `no agent named "${id}"`);
  if (status === 'archived') throw new CrewError('AGENT_INACTIVE', `agent "${id}" is archived`);
}

/**
 * The plain, first-class human Agent identity from ADR-0012 — an ordinary
 * Agent row, not a privileged one. Authority is gated on this exact id FIRST,
 * never on a Role name generally: Roles grant no privilege (FR-C16), and `id`
 * is the `agents` primary key, so at most one row can ever hold it. The Role
 * and platform check below is not a second privilege grant — it verifies that
 * the one row at this id is genuinely the plain operator this identity means
 * (matching the exact shape the Console's own `ensureOperatorAgent` startup
 * guard requires), not a differently-shaped row (e.g. `crew join operator
 * --role worker --platform claude-code`) that merely occupies the same id.
 */
const OPERATOR_AGENT_ID = 'operator';

/** True when `id` is the active, genuinely-plain `operator` identity (the abandon fallback). */
function isActiveOperator(db: DatabaseSync, id: string): boolean {
  if (id !== OPERATOR_AGENT_ID) return false;
  const row = db
    .prepare(
      "SELECT 1 FROM agents WHERE id = ? AND status = 'active' AND role = 'operator' " +
        'AND platform_id IS NULL',
    )
    .get(id);
  return row !== undefined;
}

function conflict(message: string, id: string): never {
  throw new CrewError('TASK_CONFLICT', message, { task_id: id });
}

function touch(db: DatabaseSync, id: string, now: number): void {
  db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(now, id);
}

function appendEvent(
  db: DatabaseSync,
  input: {
    taskId: string;
    revision: number;
    eventType: TaskEventType;
    actorId: string;
    fromStatus: TaskStatus | null;
    toStatus: TaskStatus;
    detail: string;
    createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO task_events
       (task_id, revision, event_type, actor_id, from_status, to_status, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.taskId,
    input.revision,
    input.eventType,
    input.actorId,
    input.fromStatus,
    input.toStatus,
    input.detail,
    input.createdAt,
  );
}

/**
 * Notify recipients of a Task transition. The acting Agent is omitted, ids are
 * deduplicated, and archived targets are skipped (an empty recipient set is
 * valid). The body is a bounded pointer line; the free-text summary/reason lives
 * in the Task Event detail and Task columns (visible via `task show`).
 */
function notify(
  db: DatabaseSync,
  input: {
    actorId: string;
    recipientIds: readonly string[];
    kind: Exclude<MessageKind, 'note' | 'clear_safe'>;
    taskId: string;
    title: string;
    now: number;
  },
): void {
  const seen = new Set<string>();
  for (const recipientId of input.recipientIds) {
    if (recipientId === input.actorId || seen.has(recipientId)) continue;
    seen.add(recipientId);
    if (agentStatus(db, recipientId) !== 'active') continue;
    insertNotification(db, {
      senderId: input.actorId,
      recipientId,
      content: `Task ${input.taskId} "${input.title}" ${NOTIFY_VERB[input.kind]} by ${input.actorId}`,
      kind: input.kind,
      taskId: input.taskId,
      createdAt: input.now,
    });
  }
}

/**
 * Notify Abandon recipients. The ASSIGNEE's copy is the structured
 * `clear_safe` Sign-off (ADR-0016): an abandoned Task is terminal and never
 * merges, so its abandon notification doubles as the immediate Sign-off
 * (ADR-0014's exception). Unlike every courtesy notification, the Sign-off is
 * delivered even when the assignee IS the acting Agent — a self-abandoning
 * assignee (creator/reviewer roles may coincide with the assignee) still needs
 * the durable unread signal the Relay's reset keys on; self-actor suppression
 * applies only to the plain-`note` creator/reviewer copies, which carry no
 * context-clear permission. Neither wording fits {@link notify}'s
 * `NOTIFY_VERB` lookup (abandon is deliberately not a transition-verb kind).
 * Same dedup/archived-skip semantics as {@link notify} otherwise.
 */
function notifyAbandon(
  db: DatabaseSync,
  input: {
    actorId: string;
    recipientIds: readonly string[];
    assigneeId: string;
    taskId: string;
    title: string;
    now: number;
  },
): void {
  const content = `Task ${input.taskId} "${input.title}" abandoned by ${input.actorId}`;
  const seen = new Set<string>([input.assigneeId]);
  if (agentStatus(db, input.assigneeId) === 'active') {
    insertNotification(db, {
      senderId: input.actorId,
      recipientId: input.assigneeId,
      content,
      kind: 'clear_safe',
      taskId: input.taskId,
      createdAt: input.now,
    });
  }
  for (const recipientId of input.recipientIds) {
    if (recipientId === input.actorId || seen.has(recipientId)) continue;
    seen.add(recipientId);
    if (agentStatus(db, recipientId) !== 'active') continue;
    insertNotification(db, {
      senderId: input.actorId,
      recipientId,
      content,
      kind: 'note',
      taskId: input.taskId,
      createdAt: input.now,
    });
  }
}

/** Insert a fresh `queued` Task with its `created` Event and assignee notification. */
export function createTask(
  db: DatabaseSync,
  now: number,
  input: CreateTaskInput,
  step?: TransactionStep,
): TaskRecord {
  assertActiveAgent(db, input.creatorId);
  assertActiveAgent(db, input.assigneeId);
  assertActiveAgent(db, input.reviewerId);

  const id = randomUUID();
  const row = db
    .prepare(
      `INSERT INTO tasks
         (id, title, body, creator_id, assignee_id, reviewer_id, status, revision,
          lease_owner_id, lease_expires_at, submission_summary, submitted_at,
          review_summary, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
       RETURNING *`,
    )
    .get(
      id,
      input.title,
      input.body,
      input.creatorId,
      input.assigneeId,
      input.reviewerId,
      now,
      now,
    ) as unknown as TaskRow;
  step?.('create:after-insert');
  appendEvent(db, {
    taskId: id,
    revision: 0,
    eventType: 'created',
    actorId: input.creatorId,
    fromStatus: null,
    toStatus: 'queued',
    detail: '',
    createdAt: now,
  });
  notify(db, {
    actorId: input.creatorId,
    recipientIds: [input.assigneeId],
    kind: 'task_assigned',
    taskId: id,
    title: input.title,
    now,
  });
  touch(db, input.creatorId, now);
  return mapTask(row, now);
}

/**
 * Assignee moves `queued` -> `in_progress`, granting a 15-minute Lease. When
 * `worktree` is supplied (per-Worker Task worktrees enabled), the
 * worktree_path/worktree_branch/worktree_base_ref triple is set in the SAME
 * UPDATE that flips status, so a Task never has a partially-recorded worktree.
 * Omitting `worktree` preserves an already-recorded triple across a restart
 * while the opt-in feature is disabled.
 */
export function startTask(
  db: DatabaseSync,
  now: number,
  agentId: string,
  taskId: string,
  worktree?: TaskWorktreeInput,
  step?: TransactionStep,
): TaskRecord {
  const row = requireTaskRow(db, taskId);
  assertActiveAgent(db, row.creator_id);
  assertActiveAgent(db, row.assignee_id);
  assertActiveAgent(db, row.reviewer_id);
  if (row.status !== 'queued') conflict(`task is ${row.status}, expected queued`, taskId);
  if (row.assignee_id !== agentId) conflict(`agent "${agentId}" is not the assignee`, taskId);

  const revision = row.revision + 1;
  const result = db
    .prepare(
      `UPDATE tasks
         SET status = 'in_progress', revision = ?, lease_owner_id = ?,
             lease_expires_at = ?,
             worktree_path = COALESCE(?, worktree_path),
             worktree_branch = COALESCE(?, worktree_branch),
             worktree_base_ref = COALESCE(?, worktree_base_ref), updated_at = ?
       WHERE id = ? AND status = 'queued' AND revision = ?`,
    )
    .run(
      revision,
      agentId,
      now + LEASE_SECONDS,
      worktree?.path ?? null,
      worktree?.branch ?? null,
      worktree?.baseRef ?? null,
      now,
      taskId,
      row.revision,
    );
  if (result.changes !== 1) conflict('task changed concurrently', taskId);
  step?.('start:after-update');
  appendEvent(db, {
    taskId,
    revision,
    eventType: 'started',
    actorId: agentId,
    fromStatus: 'queued',
    toStatus: 'in_progress',
    detail: '',
    createdAt: now,
  });
  touch(db, agentId, now);
  return mapTask(requireTaskRow(db, taskId), now);
}

/** Unexpired Lease owner moves `in_progress` -> `submitted` with a Submission. */
export function submitTask(
  db: DatabaseSync,
  now: number,
  agentId: string,
  taskId: string,
  summary: string,
  step?: TransactionStep,
): TaskRecord {
  const row = requireTaskRow(db, taskId);
  assertActiveAgent(db, row.creator_id);
  assertActiveAgent(db, row.assignee_id);
  assertActiveAgent(db, row.reviewer_id);
  if (row.status !== 'in_progress') conflict(`task is ${row.status}, expected in_progress`, taskId);
  if (row.lease_owner_id !== agentId)
    conflict(`agent "${agentId}" does not hold the lease`, taskId);
  if (row.lease_expires_at === null || row.lease_expires_at <= now) {
    conflict('task lease has expired; it must be requeued before resubmission', taskId);
  }

  const revision = row.revision + 1;
  const result = db
    .prepare(
      `UPDATE tasks
         SET status = 'submitted', revision = ?, lease_owner_id = NULL,
             lease_expires_at = NULL, submission_summary = ?, submitted_at = ?, updated_at = ?
       WHERE id = ? AND status = 'in_progress' AND revision = ?
         AND lease_owner_id = ? AND lease_expires_at > ?`,
    )
    .run(revision, summary, now, now, taskId, row.revision, agentId, now);
  if (result.changes !== 1) conflict('task changed concurrently', taskId);
  step?.('submit:after-update');
  appendEvent(db, {
    taskId,
    revision,
    eventType: 'submitted',
    actorId: agentId,
    fromStatus: 'in_progress',
    toStatus: 'submitted',
    detail: summary,
    createdAt: now,
  });
  notify(db, {
    actorId: agentId,
    recipientIds: [row.reviewer_id, row.creator_id],
    kind: 'task_submitted',
    taskId,
    title: row.title,
    now,
  });
  touch(db, agentId, now);
  return mapTask(requireTaskRow(db, taskId), now);
}

/** Reviewer moves `submitted` -> `completed`, optionally recording a Review. */
export function approveTask(
  db: DatabaseSync,
  now: number,
  reviewerId: string,
  taskId: string,
  summary: string | null,
  step?: TransactionStep,
): TaskRecord {
  const row = requireTaskRow(db, taskId);
  assertActiveAgent(db, row.creator_id);
  assertActiveAgent(db, row.assignee_id);
  assertActiveAgent(db, row.reviewer_id);
  if (row.status !== 'submitted') conflict(`task is ${row.status}, expected submitted`, taskId);
  if (row.reviewer_id !== reviewerId) conflict(`agent "${reviewerId}" is not the reviewer`, taskId);

  const revision = row.revision + 1;
  const result = db
    .prepare(
      `UPDATE tasks
         SET status = 'completed', revision = ?, review_summary = ?,
             completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'submitted' AND revision = ?`,
    )
    .run(revision, summary, now, now, taskId, row.revision);
  if (result.changes !== 1) conflict('task changed concurrently', taskId);
  step?.('approve:after-update');
  appendEvent(db, {
    taskId,
    revision,
    eventType: 'approved',
    actorId: reviewerId,
    fromStatus: 'submitted',
    toStatus: 'completed',
    detail: summary ?? '',
    createdAt: now,
  });
  notify(db, {
    actorId: reviewerId,
    recipientIds: [row.creator_id, row.assignee_id],
    kind: 'task_approved',
    taskId,
    title: row.title,
    now,
  });
  touch(db, reviewerId, now);
  return mapTask(requireTaskRow(db, taskId), now);
}

/**
 * Creator or reviewer returns a `submitted` Task, or recovers an `in_progress`
 * Task whose Lease has expired, to `queued`. A `--to` retarget requires the new
 * assignee to be active; the departed old assignee is intentionally exempt so
 * Lease recovery stays reachable (FR-E09-E14).
 */
export function requeueTask(
  db: DatabaseSync,
  now: number,
  actorId: string,
  taskId: string,
  reason: string,
  to: string | undefined,
  step?: TransactionStep,
): TaskRecord {
  const row = requireTaskRow(db, taskId);
  if (actorId !== row.creator_id && actorId !== row.reviewer_id) {
    conflict(`agent "${actorId}" is not the creator or reviewer`, taskId);
  }
  assertActiveAgent(db, actorId);
  if (to !== undefined) assertActiveAgent(db, to);

  const expiredInProgress =
    row.status === 'in_progress' && row.lease_expires_at !== null && row.lease_expires_at <= now;
  if (row.status === 'completed') conflict('task is completed and cannot be requeued', taskId);
  if (row.status === 'abandoned') conflict('task is abandoned and cannot be requeued', taskId);
  if (row.status === 'queued')
    conflict('task is queued, expected submitted or in_progress', taskId);
  if (row.status === 'in_progress' && !expiredInProgress) {
    conflict('task lease is still active; it cannot be requeued before expiry', taskId);
  }

  const assigneeId = to ?? row.assignee_id;
  const revision = row.revision + 1;
  const result = db
    .prepare(
      `UPDATE tasks
         SET status = 'queued', revision = ?, assignee_id = ?, lease_owner_id = NULL,
             lease_expires_at = NULL, submission_summary = NULL, submitted_at = NULL,
             review_summary = NULL, completed_at = NULL, updated_at = ?
       WHERE id = ? AND revision = ?
         AND (status = 'submitted' OR (status = 'in_progress' AND lease_expires_at <= ?))`,
    )
    .run(revision, assigneeId, now, taskId, row.revision, now);
  if (result.changes !== 1) conflict('task changed concurrently', taskId);
  step?.('requeue:after-update');
  appendEvent(db, {
    taskId,
    revision,
    eventType: 'requeued',
    actorId,
    fromStatus: row.status,
    toStatus: 'queued',
    detail: reason,
    createdAt: now,
  });
  notify(db, {
    actorId,
    recipientIds: [assigneeId, row.creator_id, row.reviewer_id],
    kind: 'task_requeued',
    taskId,
    title: row.title,
    now,
  });
  touch(db, actorId, now);
  return mapTask(requireTaskRow(db, taskId), now);
}

/**
 * Creator/reviewer retires a `queued`, `in_progress`, or `submitted` Task to
 * the terminal `abandoned` status without it ever completing. When
 * BOTH the creator and reviewer are archived, the plain `operator` Agent
 * identity (id `operator`, Role `operator`, platform `NULL` — ADR-0012, the
 * same identity the Console's own startup guard recognizes) may abandon on
 * their behalf. `abandoned` is terminal like `completed` — there is no
 * un-abandon. Also clears `worktree_path`/`worktree_branch`/`worktree_base_ref`:
 * unlike `landTask`, this DB transition always succeeds regardless
 * of whether the caller can also remove the worktree on disk — an abandoned
 * Task is never coming back for rework, so its worktree bookkeeping is
 * unconditionally stale the moment this commits. The caller (`runTaskAbandon`)
 * attempts the actual on-disk removal AFTER this succeeds, best-effort.
 */
export function abandonTask(
  db: DatabaseSync,
  now: number,
  actorId: string,
  taskId: string,
  reason: string,
  step?: TransactionStep,
): TaskRecord {
  const row = requireTaskRow(db, taskId);
  assertActiveAgent(db, actorId);

  const isCreatorOrReviewer = actorId === row.creator_id || actorId === row.reviewer_id;
  if (!isCreatorOrReviewer) {
    const bothArchived =
      agentStatus(db, row.creator_id) === 'archived' &&
      agentStatus(db, row.reviewer_id) === 'archived';
    if (!bothArchived || !isActiveOperator(db, actorId)) {
      conflict(`agent "${actorId}" is not the creator or reviewer`, taskId);
    }
  }

  if (row.status === 'completed') conflict('task is completed and cannot be abandoned', taskId);
  if (row.status === 'abandoned') conflict('task is already abandoned', taskId);

  const revision = row.revision + 1;
  const result = db
    .prepare(
      `UPDATE tasks
         SET status = 'abandoned', revision = ?, lease_owner_id = NULL, lease_expires_at = NULL,
             review_summary = NULL, abandoned_at = ?, updated_at = ?,
             worktree_path = NULL, worktree_branch = NULL, worktree_base_ref = NULL
       WHERE id = ? AND revision = ? AND status IN ('queued', 'in_progress', 'submitted')`,
    )
    .run(revision, now, now, taskId, row.revision);
  if (result.changes !== 1) conflict('task changed concurrently', taskId);
  step?.('abandon:after-update');
  appendEvent(db, {
    taskId,
    revision,
    eventType: 'abandoned',
    actorId,
    fromStatus: row.status,
    toStatus: 'abandoned',
    detail: reason,
    createdAt: now,
  });
  notifyAbandon(db, {
    actorId,
    recipientIds: [row.creator_id, row.assignee_id, row.reviewer_id],
    assigneeId: row.assignee_id,
    taskId,
    title: row.title,
    now,
  });
  touch(db, actorId, now);
  return mapTask(requireTaskRow(db, taskId), now);
}

/**
 * Creator/reviewer clears a `completed` Task's worktree bookkeeping,
 * called ONLY after `task land` has already removed the worktree/branch on
 * disk with git — a DB transaction cannot itself prove that, so this trusts
 * the caller and focuses on making the DB-side clear safe and idempotent. NOT
 * a status transition: `status` stays `completed` and no Task Event is
 * appended (task_events is a status-transition log only). The UPDATE is gated
 * on `worktree_path` matching the row just read here (this function's CAS
 * predicate, standing in for the revision bump every status transition in
 * this file uses), so two concurrent `task land` calls cannot both "succeed"
 * against the same worktree. Sends the ADR-0014 Sign-off to the assignee
 * automatically as a structured `clear_safe` Message (ADR-0016; same wording
 * as before) — even when the assignee is itself the landing actor, because the
 * Sign-off is the durable unread signal the Relay's reset keys on, not a
 * courtesy note; only an archived assignee is skipped.
 */
export function landTask(
  db: DatabaseSync,
  now: number,
  actorId: string,
  taskId: string,
  step?: TransactionStep,
): TaskRecord {
  const row = requireTaskRow(db, taskId);
  assertActiveAgent(db, actorId);
  if (actorId !== row.creator_id && actorId !== row.reviewer_id) {
    conflict(`agent "${actorId}" is not the creator or reviewer`, taskId);
  }
  if (row.status !== 'completed') conflict(`task is ${row.status}, expected completed`, taskId);
  if (row.worktree_path === null) conflict('task has no active worktree to land', taskId);

  const result = db
    .prepare(
      `UPDATE tasks
         SET worktree_path = NULL, worktree_branch = NULL, worktree_base_ref = NULL, updated_at = ?
       WHERE id = ? AND worktree_path = ?`,
    )
    .run(now, taskId, row.worktree_path);
  if (result.changes !== 1) conflict('task changed concurrently', taskId);
  step?.('land:after-update');

  if (agentStatus(db, row.assignee_id) === 'active') {
    insertNotification(db, {
      senderId: actorId,
      recipientId: row.assignee_id,
      content: `Task ${taskId}: landed, safe to clear your context.`,
      kind: 'clear_safe',
      taskId,
      createdAt: now,
    });
  }
  touch(db, actorId, now);
  return mapTask(requireTaskRow(db, taskId), now);
}

/** Read one Task without changing activity metadata. */
export function selectTask(db: DatabaseSync, now: number, id: string): TaskRecord | null {
  const row = loadTaskRow(db, id);
  return row === null ? null : mapTask(row, now);
}

/** List Tasks in `(created_at, id)` order, AND-combining the supplied filters. */
export function selectTasks(db: DatabaseSync, now: number, filter: TaskListFilter): TaskRecord[] {
  const predicates: string[] = [];
  const values: Array<string | number> = [];
  if (filter.assigneeId !== undefined) {
    predicates.push('assignee_id = ?');
    values.push(filter.assigneeId);
  }
  if (filter.reviewerId !== undefined) {
    predicates.push('reviewer_id = ?');
    values.push(filter.reviewerId);
  }
  if (filter.status !== undefined) {
    predicates.push('status = ?');
    values.push(filter.status);
  }
  if (filter.staleLease === true) {
    predicates.push("status = 'in_progress' AND lease_expires_at <= ?");
    values.push(now);
  }
  const where = predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at, id`)
    .all(...values) as unknown as TaskRow[];
  return rows.map((row) => mapTask(row, now));
}

/** One currently-stale Task's id and creator, for the Relay's stale-lease nudge. */
export interface StaleLeaseTask {
  readonly taskId: string;
  readonly creatorId: string;
}

/** List currently-stale in_progress Tasks with their creator, oldest-Task-first. */
export function selectStaleLeaseTasks(db: DatabaseSync, now: number): StaleLeaseTask[] {
  const rows = db
    .prepare(
      `SELECT id, creator_id FROM tasks
        WHERE status = 'in_progress' AND lease_expires_at <= ?
        ORDER BY created_at, id`,
    )
    .all(now) as unknown as { id: string; creator_id: string }[];
  return rows.map((row) => ({ taskId: row.id, creatorId: row.creator_id }));
}

/** Read a Task's immutable Events in revision order. The Task must exist. */
export function selectTaskEvents(db: DatabaseSync, id: string): TaskEventRecord[] {
  requireTaskRow(db, id);
  const rows = db
    .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY revision, id')
    .all(id) as unknown as TaskEventRow[];
  return rows.map(mapTaskEvent);
}
