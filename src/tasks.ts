/** Reviewed Task command validation, Store calls, and human/NDJSON rendering. */
import { assertAgentId } from './agent-id.js';
import { loadWorkspaceConfig } from './config.js';
import { CrewError } from './errors.js';
import {
  formatTimestamp,
  humanCell,
  sanitizeHuman,
  writeJsonLine,
  writeLine,
  writeTable,
} from './format.js';
import type { Io } from './io.js';
import { managedWorktreeBase } from './launcher/derive.js';
import {
  openWorkspaceStore,
  type Store,
  type TaskEventRecord,
  type TaskListFilter,
  type TaskRecord,
  type TaskStatus,
} from './store/index.js';
import { assertTaskId } from './task-id.js';
import {
  checkoutRef,
  deriveReviewWorktreePath,
  deriveTaskWorktreePath,
  hasUnlandedChanges,
  removeTaskWorktree,
  resolveConcreteBaseRef,
  resolveWorktree,
  type RemoveTaskWorktreeResult,
} from './worktree.js';
import { resolveWorkspaceRoot, writeWorkspacePointer } from './workspace.js';

interface CreateOptions {
  readonly reviewer: string;
  readonly title: string;
  readonly body?: string;
  readonly json: boolean;
}

interface SubmitOptions {
  readonly summary: string;
  readonly json: boolean;
}

interface ApproveOptions {
  readonly summary?: string;
  readonly json: boolean;
}

interface RequeueOptions {
  readonly reason: string;
  readonly to?: string;
  readonly json: boolean;
}

interface AbandonOptions {
  readonly reason?: string;
  readonly json: boolean;
}

interface ReviewOptions {
  readonly json: boolean;
}

interface LandOptions {
  readonly force: boolean;
  readonly json: boolean;
}

interface ListOptions {
  readonly assignee?: string;
  readonly reviewer?: string;
  readonly status?: TaskStatus;
  readonly staleLease: boolean;
  readonly json: boolean;
}

function taskRecord(task: TaskRecord): Record<string, unknown> {
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

function taskEventRecord(event: TaskEventRecord): Record<string, unknown> {
  return {
    type: 'task_event',
    schema_version: 1,
    id: event.id,
    task_id: event.taskId,
    revision: event.revision,
    event_type: event.eventType,
    actor_id: event.actorId,
    from_status: event.fromStatus,
    to_status: event.toStatus,
    detail: event.detail,
    created_at: event.createdAt,
  };
}

/** Print a labeled multi-line block; continuation lines are visibly indented. */
function writeBlock(io: Io, label: string, content: string): void {
  const lines = sanitizeHuman(content).split('\n');
  writeLine(io, `${label}`);
  for (const line of lines) writeLine(io, `  ${line}`);
}

function writeTaskHuman(io: Io, task: TaskRecord): void {
  writeLine(io, `Task    ${humanCell(task.id)}`);
  writeLine(io, `Title   ${humanCell(task.title)}`);
  writeLine(io, `Status  ${task.status} (revision ${task.revision})`);
  writeLine(
    io,
    `Roles   creator=${humanCell(task.creatorId)} assignee=${humanCell(task.assigneeId)} reviewer=${humanCell(task.reviewerId)}`,
  );
  if (task.leaseOwnerId === null) {
    writeLine(io, 'Lease   none');
  } else {
    const stale = task.staleLease ? ' (stale)' : '';
    writeLine(
      io,
      `Lease   ${humanCell(task.leaseOwnerId)} until ${formatTimestamp(task.leaseExpiresAt ?? 0)}${stale}`,
    );
  }
  if (task.worktreePath !== null && task.worktreeBranch !== null && task.worktreeBaseRef !== null) {
    writeLine(
      io,
      `Worktree ${humanCell(task.worktreePath)} branch=${humanCell(task.worktreeBranch)} base=${humanCell(task.worktreeBaseRef)}`,
    );
  }
  if (task.body.length > 0) writeBlock(io, 'Body', task.body);
  if (task.submissionSummary !== null) writeBlock(io, 'Submission', task.submissionSummary);
  if (task.reviewSummary !== null) writeBlock(io, 'Review', task.reviewSummary);
}

function writeTaskMutation(io: Io, task: TaskRecord, json: boolean): void {
  if (json) {
    writeJsonLine(io, taskRecord(task));
    return;
  }
  writeLine(io, `Task ${humanCell(task.id)} -> ${task.status} (revision ${task.revision})`);
}

function writeTaskList(io: Io, tasks: readonly TaskRecord[], json: boolean): void {
  if (json) {
    for (const task of tasks) writeJsonLine(io, taskRecord(task));
    return;
  }
  if (tasks.length === 0) {
    writeLine(io, 'No tasks.');
    return;
  }
  const rows = tasks.map((task) => [
    humanCell(task.id),
    task.staleLease ? `${task.status} (stale)` : task.status,
    String(task.revision),
    humanCell(task.assigneeId),
    humanCell(task.reviewerId),
    humanCell(task.title),
  ]);
  writeTable(io, ['ID', 'STATUS', 'REV', 'ASSIGNEE', 'REVIEWER', 'TITLE'], rows);
}

/** `crew task create`: open the Store and insert a queued Task. */
export function runTaskCreate(
  io: Io,
  creator: string,
  assignee: string,
  options: CreateOptions,
): void {
  assertAgentId(creator);
  assertAgentId(assignee);
  assertAgentId(options.reviewer);
  const root = resolveWorkspaceRoot(io.cwd);
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    const task = store.createTask({
      creatorId: creator,
      assigneeId: assignee,
      reviewerId: options.reviewer,
      title: options.title,
      ...(options.body !== undefined ? { body: options.body } : {}),
    });
    writeTaskMutation(io, task, options.json);
  } finally {
    store.close();
  }
}

/**
 * `crew task start`: the assignee claims a queued Task. When
 * `worker_worktrees.enabled` is set in `.crew/config.yaml`, this
 * creates (or reuses) the assignee's dedicated per-Task worktree BEFORE the
 * Store transition, records it on the Task in the SAME transition, points the
 * new worktree's workspace-pointer back at this shared Workspace, and prints
 * the resulting path.
 */
export async function runTaskStart(
  io: Io,
  agent: string,
  taskId: string,
  options: { json: boolean },
): Promise<void> {
  assertAgentId(agent);
  assertTaskId(taskId);
  const root = resolveWorkspaceRoot(io.cwd);
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    const config = loadWorkspaceConfig(root);
    let worktree: { path: string; branch: string; baseRef: string } | undefined;
    let createdFreshWorktree = false;
    if (config.workerWorktrees.enabled) {
      const existing = store.getTask(taskId);
      if (existing === null) throw new CrewError('NOT_FOUND', `no task with id "${taskId}"`);
      // Reuse the ALREADY-PERSISTED base ref when this Task already has a worktree
      // (a requeue-then-restart reusing the same worktree/branch) instead of
      // re-resolving a fresh one every call — worktree_base_ref must stay fixed to
      // the ref the branch was actually created from, or `task land`'s later
      // merge-safety check compares against the wrong, drifted ancestor (ADR-0015).
      const baseRef =
        existing.worktreeBaseRef ??
        (await resolveConcreteBaseRef(io, root, config.workerWorktrees.baseRef));
      const derived = deriveTaskWorktreePath(io.env, taskId, existing.title, root);
      const resolution = await resolveWorktree(io, {
        repoRoot: root,
        targetPath: derived.path,
        managedBase: managedWorktreeBase(io.env),
        branch: derived.branch,
        baseRef,
      });
      writeWorkspacePointer(resolution.path, root);
      worktree = { path: resolution.path, branch: derived.branch, baseRef };
      createdFreshWorktree = resolution.action === 'create';
    }
    let task: TaskRecord;
    try {
      task = store.startTask(agent, taskId, worktree);
    } catch (err) {
      // The worktree was just created on disk (not merely reused from an earlier
      // start) but the Task's own transition failed (e.g. a concurrent abandon won
      // the race) — remove it rather than leaving an orphan with no DB reference.
      // A REUSED worktree is never touched here: it predates this call and may
      // hold real, in-progress work.
      if (worktree !== undefined && createdFreshWorktree) {
        try {
          // force: true — crew itself already wrote the untracked
          // .crew/state/workspace-pointer file into this fresh worktree above,
          // so real git unconditionally refuses a non-forced `worktree remove`
          // (untracked files present); forcing is safe here specifically
          // because createdFreshWorktree scopes this branch to a worktree this
          // call created moments ago, containing nothing but that pointer file.
          await removeTaskWorktree(io, root, worktree.path, worktree.branch, { force: true });
        } catch (cleanupErr) {
          // Best-effort only; the original error below is what the caller
          // sees — but leave a breadcrumb, matching runTaskAbandon/runTaskLand's
          // equivalent warnings, rather than silently leaving an orphan.
          const message = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
          io.stderr(
            `Warning: could not remove orphaned worktree at ${sanitizeHuman(worktree.path)}: ${sanitizeHuman(message)}\n`,
          );
        }
      }
      throw err;
    }
    writeTaskMutation(io, task, options.json);
    if (worktree !== undefined && !options.json) {
      writeLine(io, `Worktree ${sanitizeHuman(worktree.path)}`);
    }
  } finally {
    store.close();
  }
}

/** `crew task submit`: the Lease owner records a Submission. */
export function runTaskSubmit(io: Io, agent: string, taskId: string, options: SubmitOptions): void {
  assertAgentId(agent);
  assertTaskId(taskId);
  const root = resolveWorkspaceRoot(io.cwd);
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    writeTaskMutation(io, store.submitTask(agent, taskId, options.summary), options.json);
  } finally {
    store.close();
  }
}

/**
 * Best-effort: if the acting Agent's dedicated review worktree currently sits
 * on `task`'s branch, switch it back to its resting base ref and mark it
 * idle. Never fails the caller — the Task's DB transition already
 * committed by the time this runs; a `checkoutRef` failure here is a warning
 * on stderr, not a command failure, and NOT printed to stdout so `--json`
 * output stays parseable NDJSON.
 */
async function restoreReviewWorktreeIfNeeded(
  io: Io,
  store: Store,
  reviewerId: string,
  task: TaskRecord,
): Promise<void> {
  if (task.worktreeBranch === null) return;
  const row = store.getReviewWorktree(reviewerId);
  if (row === null || row.currentRef !== task.worktreeBranch) return;
  try {
    await checkoutRef(io, row.path, row.baseRef);
    const restored = store.setReviewWorktreeCurrentRef({
      agentId: reviewerId,
      currentRef: null,
      expectedCurrentRef: row.currentRef,
    });
    if (!restored) {
      // Lost the race to a concurrent `task review`/restore for the same
      // reviewer — leave it as-is rather than clobber whatever that call is
      // now doing; it owns the row's next transition.
      io.stderr(
        `Warning: review worktree at ${sanitizeHuman(row.path)} changed concurrently; left checked out.\n`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(
      `Warning: could not restore review worktree at ${sanitizeHuman(row.path)} to ${sanitizeHuman(row.baseRef)}: ${sanitizeHuman(message)}\n`,
    );
  }
}

/**
 * Best-effort reconciliation after `task review` loses the review-worktree CAS:
 * another actor already changed the row, so restore the filesystem checkout to
 * that row's CURRENT intended ref (or its resting base) instead of leaving the
 * on-disk worktree pointed at the losing command's branch.
 */
async function reconcileReviewWorktreeAfterConflict(
  io: Io,
  store: Store,
  reviewerId: string,
  reviewPath: string,
  fallbackBaseRef: string,
): Promise<void> {
  const latest = store.getReviewWorktree(reviewerId);
  const desiredRef = latest?.currentRef ?? latest?.baseRef ?? fallbackBaseRef;
  try {
    await checkoutRef(io, reviewPath, desiredRef);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(
      `Warning: could not restore review worktree at ${sanitizeHuman(reviewPath)} after a concurrent change: ${sanitizeHuman(message)}\n`,
    );
  }
}

/** `crew task approve`: the reviewer completes a submitted Task. */
export async function runTaskApprove(
  io: Io,
  reviewer: string,
  taskId: string,
  options: ApproveOptions,
): Promise<void> {
  assertAgentId(reviewer);
  assertTaskId(taskId);
  const root = resolveWorkspaceRoot(io.cwd);
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    const task = store.approveTask(reviewer, taskId, options.summary ?? null);
    await restoreReviewWorktreeIfNeeded(io, store, task.reviewerId, task);
    writeTaskMutation(io, task, options.json);
  } finally {
    store.close();
  }
}

/** `crew task requeue`: the creator/reviewer returns work to the queue. */
export async function runTaskRequeue(
  io: Io,
  actor: string,
  taskId: string,
  options: RequeueOptions,
): Promise<void> {
  assertAgentId(actor);
  assertTaskId(taskId);
  if (options.to !== undefined) assertAgentId(options.to);
  const root = resolveWorkspaceRoot(io.cwd);
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    const task = store.requeueTask({
      actorId: actor,
      taskId,
      reason: options.reason,
      ...(options.to !== undefined ? { to: options.to } : {}),
    });
    // The review worktree always belongs to the Task's REVIEWER, never the
    // acting actor — requeue permits either the creator or the reviewer to
    // act (unlike approve, which requires the reviewer), so using `actor`
    // here would look up the wrong Agent's row whenever the creator requeues,
    // silently skipping the restore of the reviewer's actual worktree.
    await restoreReviewWorktreeIfNeeded(io, store, task.reviewerId, task);
    writeTaskMutation(io, task, options.json);
  } finally {
    store.close();
  }
}

/**
 * `crew task abandon`: the creator/reviewer (or, once both are archived, an
 * active `operator`-Role Agent) retires a Task to the terminal `abandoned`
 * status without it ever completing.
 */
export async function runTaskAbandon(
  io: Io,
  actor: string,
  taskId: string,
  options: AbandonOptions,
): Promise<void> {
  assertAgentId(actor);
  assertTaskId(taskId);
  const root = resolveWorkspaceRoot(io.cwd);
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    const before = store.getTask(taskId);
    const task = store.abandonTask({ actorId: actor, taskId, reason: options.reason ?? '' });
    // Best-effort only: the Task is already terminally abandoned above regardless of
    // whether this succeeds. Unlike `task land`, abandonment never re-checks for
    // uncommitted/unmerged work first — abandoning explicitly means discarding it.
    if (before !== null && before.worktreePath !== null && before.worktreeBranch !== null) {
      try {
        // force: true — abandoning explicitly means discarding the work, so
        // there is no reason to let uncommitted changes block the worktree
        // itself from being removed (unlike `task land`, which requires the
        // change to have actually landed first).
        const removal = await removeTaskWorktree(
          io,
          root,
          before.worktreePath,
          before.worktreeBranch,
          { force: true },
        );
        if (!removal.branchDeleted) {
          io.stderr(
            `Warning: removed the worktree at ${sanitizeHuman(before.worktreePath)}, but its branch "${sanitizeHuman(before.worktreeBranch)}" could not be deleted (${sanitizeHuman(removal.branchDeleteError ?? '')}); remove it manually with "git branch -D ${sanitizeHuman(before.worktreeBranch)}" if it's no longer needed.\n`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        io.stderr(
          `Warning: could not remove worktree at ${sanitizeHuman(before.worktreePath)}: ${sanitizeHuman(message)}\n`,
        );
      }
    }
    writeTaskMutation(io, task, options.json);
  } finally {
    store.close();
  }
}

/**
 * `crew task review`: the reviewer checks out a `submitted` Task's worktree
 * branch in their OWN dedicated, reusable review worktree — created
 * lazily on first use, then reused (and re-checked-out) for every later
 * review. Prints the resulting path.
 */
export async function runTaskReview(
  io: Io,
  agent: string,
  taskId: string,
  options: ReviewOptions,
): Promise<void> {
  assertAgentId(agent);
  assertTaskId(taskId);
  const root = resolveWorkspaceRoot(io.cwd);
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    const task = store.getTask(taskId);
    if (task === null) throw new CrewError('NOT_FOUND', `no task with id "${taskId}"`);
    if (agent !== task.reviewerId) {
      throw new CrewError('TASK_CONFLICT', `agent "${agent}" is not the reviewer`, {
        task_id: taskId,
      });
    }
    if (task.status !== 'submitted') {
      throw new CrewError('TASK_CONFLICT', `task is ${task.status}, expected submitted`, {
        task_id: taskId,
      });
    }
    if (task.worktreeBranch === null) {
      throw new CrewError('TASK_CONFLICT', 'task has no worktree to review', {
        task_id: taskId,
      });
    }

    const existing = store.getReviewWorktree(agent);
    let reviewPath: string;
    let reviewBaseRef: string;
    // The row's current_ref at the moment we read/created it — the CAS
    // predicate for the write below, so a second overlapping `task review`
    // (or an approve/requeue-triggered restore) for this same reviewer can't
    // silently clobber this call's effect.
    let expectedCurrentRef: string | null;
    if (existing === null) {
      const config = loadWorkspaceConfig(root);
      const baseRef = await resolveConcreteBaseRef(io, root, config.workerWorktrees.baseRef);
      const derived = deriveReviewWorktreePath(io.env, agent, root);
      const resolution = await resolveWorktree(io, {
        repoRoot: root,
        targetPath: derived.path,
        managedBase: managedWorktreeBase(io.env),
        branch: derived.branch,
        baseRef,
      });
      // Same as the assignee's own task worktree: a fresh git worktree checks
      // out tracked .crew/roles/.crew/teams but never the gitignored
      // .crew/state/, so any crew command the Inspector runs from inside its
      // review copy needs this redirect back to the real shared Workspace.
      writeWorkspacePointer(resolution.path, root);
      const created = store.createReviewWorktree({
        agentId: agent,
        path: resolution.path,
        baseRef,
      });
      reviewPath = created.path;
      reviewBaseRef = created.baseRef;
      expectedCurrentRef = created.currentRef;
    } else {
      reviewPath = existing.path;
      reviewBaseRef = existing.baseRef;
      expectedCurrentRef = existing.currentRef;
    }

    await checkoutRef(io, reviewPath, task.worktreeBranch);
    const switched = store.setReviewWorktreeCurrentRef({
      agentId: agent,
      currentRef: task.worktreeBranch,
      expectedCurrentRef,
    });
    if (!switched) {
      await reconcileReviewWorktreeAfterConflict(io, store, agent, reviewPath, reviewBaseRef);
      throw new CrewError(
        'TASK_CONFLICT',
        'review worktree changed concurrently; rerun "crew task review"',
        { task_id: taskId },
      );
    }

    if (options.json) {
      writeJsonLine(io, {
        type: 'task_review',
        schema_version: 1,
        task_id: taskId,
        agent_id: agent,
        path: reviewPath,
        branch: task.worktreeBranch,
        base_ref: reviewBaseRef,
      });
      return;
    }
    writeLine(io, sanitizeHuman(reviewPath));
  } finally {
    store.close();
  }
}

/**
 * `crew task land`: the creator/reviewer removes a `completed` Task's
 * worktree/branch on disk, then clears the Task's worktree bookkeeping and
 * sends the ADR-0014 Sign-off (a structured `clear_safe` Message, ADR-0016)
 * to the assignee automatically.
 * `--force` overrides only crew's own `hasUnlandedChanges` heuristic — it does
 * NOT force git's own independent, unmerged-branch-refusing `branch -d`
 * safety net inside `removeTaskWorktree`.
 */
export async function runTaskLand(
  io: Io,
  actor: string,
  taskId: string,
  options: LandOptions,
): Promise<void> {
  assertAgentId(actor);
  assertTaskId(taskId);
  const root = resolveWorkspaceRoot(io.cwd);
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    const task = store.getTask(taskId);
    if (task === null) throw new CrewError('NOT_FOUND', `no task with id "${taskId}"`);
    if (actor !== task.creatorId && actor !== task.reviewerId) {
      throw new CrewError('TASK_CONFLICT', `agent "${actor}" is not the creator or reviewer`, {
        task_id: taskId,
      });
    }
    // Disk removal is irreversible from crew's perspective, whereas landTask
    // rejects archived actors. Check activity before touching Git so a failed
    // command has no disk or Task-record side effect. landTask repeats this
    // check inside its transaction as the authoritative write-time guard.
    const actorRecord = store.getAgent(actor);
    if (actorRecord === null) {
      throw new CrewError('NOT_FOUND', `no agent named "${actor}"`);
    }
    if (actorRecord.status === 'archived') {
      throw new CrewError('AGENT_INACTIVE', `agent "${actor}" is archived`);
    }
    if (task.status !== 'completed') {
      throw new CrewError('TASK_CONFLICT', `task is ${task.status}, expected completed`, {
        task_id: taskId,
      });
    }
    const { worktreePath, worktreeBranch, worktreeBaseRef } = task;
    if (worktreePath === null || worktreeBranch === null || worktreeBaseRef === null) {
      throw new CrewError('TASK_CONFLICT', 'task has no active worktree to land', {
        task_id: taskId,
      });
    }

    const unlanded = await hasUnlandedChanges(io, worktreePath, worktreeBranch, worktreeBaseRef);
    if (unlanded && !options.force) {
      throw new CrewError(
        'TASK_CONFLICT',
        'worktree has uncommitted or unmerged changes; rerun with --force to remove anyway',
        { task_id: taskId },
      );
    }

    let removal: RemoveTaskWorktreeResult;
    try {
      // force here overrides only the git-level `worktree remove` refusal on
      // uncommitted/untracked changes — it mirrors options.force, which
      // already gated whether we got past the hasUnlandedChanges check above.
      removal = await removeTaskWorktree(io, root, worktreePath, worktreeBranch, {
        force: options.force,
      });
    } catch (err) {
      if (err instanceof CrewError) {
        throw new CrewError(
          err.code,
          `${err.message}; as a last resort, manually run "git worktree remove --force ${worktreePath}" and "git branch -D ${worktreeBranch}"`,
          err.details,
        );
      }
      throw err;
    }

    // The worktree itself is gone either way — that's the primary goal, so a
    // leftover local branch object (typically: `--force` overrode an unmerged
    // branch, which the SAFE `branch -d` deliberately still refuses) does not
    // block clearing the Task's bookkeeping. Leaving it stuck because of a
    // low-stakes leftover branch would be worse than a stderr warning.
    if (!removal.branchDeleted) {
      io.stderr(
        `Warning: worktree removed, but branch "${sanitizeHuman(worktreeBranch)}" could not be deleted (${sanitizeHuman(removal.branchDeleteError ?? '')}); remove it manually with "git branch -D ${sanitizeHuman(worktreeBranch)}" if it's no longer needed.\n`,
      );
    }

    const landed = store.landTask({ actorId: actor, taskId });
    writeTaskMutation(io, landed, options.json);
  } finally {
    store.close();
  }
}

/** `crew task show`: render one Task, optionally followed by its Events. */
export function runTaskShow(
  io: Io,
  taskId: string,
  options: { events: boolean; json: boolean },
): void {
  assertTaskId(taskId);
  const root = resolveWorkspaceRoot(io.cwd);
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    // With --events read the Task and its Events from one snapshot so a
    // concurrent transition cannot make the pair internally inconsistent.
    const { task, events } = options.events
      ? store.getTaskWithEvents(taskId)
      : { task: store.getTask(taskId), events: [] };
    if (task === null) {
      throw new CrewError('NOT_FOUND', `no task with id "${taskId}"`);
    }
    if (options.json) {
      writeJsonLine(io, taskRecord(task));
      for (const event of events) writeJsonLine(io, taskEventRecord(event));
      return;
    }
    writeTaskHuman(io, task);
    if (options.events) {
      writeLine(io, 'Events');
      for (const event of events) {
        writeLine(
          io,
          `  #${event.revision} ${event.eventType} by ${humanCell(event.actorId)} ${formatTimestamp(event.createdAt)}`,
        );
        // Render the Event detail (Submission/Review/requeue reason) so the
        // audit trail is visible on the human surface, not only in --json.
        if (event.detail.length > 0) {
          for (const line of sanitizeHuman(event.detail).split('\n')) writeLine(io, `    ${line}`);
        }
      }
    }
  } finally {
    store.close();
  }
}

/** `crew task list`: filter and render the current Task set. */
export function runTaskList(io: Io, options: ListOptions): void {
  if (options.assignee !== undefined) assertAgentId(options.assignee);
  if (options.reviewer !== undefined) assertAgentId(options.reviewer);
  if (options.staleLease && options.status !== undefined && options.status !== 'in_progress') {
    throw new CrewError(
      'USAGE',
      `--stale-lease selects in_progress tasks and conflicts with --status ${options.status}`,
    );
  }
  const filter: TaskListFilter = {
    ...(options.assignee !== undefined ? { assigneeId: options.assignee } : {}),
    ...(options.reviewer !== undefined ? { reviewerId: options.reviewer } : {}),
    ...(options.status !== undefined ? { status: options.status } : {}),
    ...(options.staleLease ? { staleLease: true } : {}),
  };
  const root = resolveWorkspaceRoot(io.cwd);
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    writeTaskList(io, store.listTasks(filter), options.json);
  } finally {
    store.close();
  }
}
