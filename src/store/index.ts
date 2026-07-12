/**
 * State Store: the sole owner of SQLite access, schema lifecycle, transactions,
 * contention retries, and connection cleanup. Agent persistence lives in
 * `./agents.js` and the stateless retry/clock helpers in `./connection.js`; this
 * module owns the connection and delegates domain SQL to its siblings.
 */
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { assertAgentId } from '../agent-id.js';
import { assertTaskId } from '../task-id.js';
import { CrewError } from '../errors.js';
import { ensureManagedDir, resolveManagedTarget } from '../fs-safe.js';
import { isParticipantId } from '../participants.js';
import { STATE_DB_BASENAME, WORKSPACE_DIRNAME } from '../workspace.js';
import {
  assertCurrentSchema,
  assertDatabaseChecks,
  CURRENT_SCHEMA_VERSION,
  isEmptyVersionZero,
  MIGRATIONS,
  runMigrations,
  SCHEMA_SQL,
  schemaState,
  schemaVersion,
} from './schema.js';
import { countActiveAgents, pruneState, vacuum } from './maintenance.js';
import { type ChangeSignature, selectChangeSignature } from './change-signature.js';
import {
  claimUnreadMessages,
  type InboxState,
  insertNote,
  messageHistory,
  messageParticipantIds,
  type MessageRecord,
  pendingMessages,
  pendingSummary,
} from './messages.js';
import {
  abandonTask,
  approveTask,
  createTask,
  landTask,
  requeueTask,
  selectStaleLeaseTasks,
  selectTask,
  selectTaskEvents,
  selectTasks,
  startTask,
  submitTask,
  type StaleLeaseTask,
  type TaskEventRecord,
  type TaskListFilter,
  type TaskRecord,
  type TaskWorktreeInput,
  type TransactionStep,
} from './tasks.js';
import {
  insertReviewWorktree,
  selectReviewWorktree,
  updateReviewWorktreeCurrentRef,
  type ReviewWorktreeRecord,
} from './review-worktrees.js';
import {
  type AgentRecord,
  assertActiveAgent,
  assertAgentExists,
  getAgentRecord,
  joinAgentTx,
  type JoinAgentInput,
  leaveAgentTx,
  listAgentRecords,
  reapByLaunchTokenTx,
} from './agents.js';
import {
  assertCodePointRange,
  assertLimit,
  assertMessageContent,
  backoffMs,
  BUSY_TIMEOUT_MS,
  isBusy,
  mapUnexpectedSqlite,
  operationTime,
  readConnectionSettings,
  sleep,
  type StoreConnectionSettings,
} from './connection.js';

export type { InboxState, MessageKind, MessageRecord } from './messages.js';
export type {
  StaleLeaseTask,
  TaskEventRecord,
  TaskEventType,
  TaskListFilter,
  TaskRecord,
  TaskStatus,
  TaskWorktreeInput,
} from './tasks.js';
export type { ReviewWorktreeRecord } from './review-worktrees.js';
export type { AgentRecord } from './agents.js';
export type { ChangeSignature } from './change-signature.js';
// Re-exported for the contention-retry unit tests; production draws
// randomness from Io.random through the Store's injected #random.
export { backoffMs };

interface SendMessagesInput {
  readonly senderId: string;
  readonly recipientId: string;
  readonly content: string;
  readonly replyTo?: number;
}

interface PendingMessagesInput {
  readonly agentId?: string;
  readonly limit?: number;
}

interface MessageHistoryInput {
  readonly agentId?: string;
  readonly senderId?: string;
  readonly recipientId?: string;
  readonly since?: number;
  readonly limit?: number;
}

interface StoreOptions {
  readonly clock?: () => number;
  /**
   * Injected randomness for contention-retry jitter (default `Math.random`).
   * Tests and the test-only fault build pass a seeded stream so a flaky stress
   * failure replays exactly. Production never seeds it.
   */
  readonly random?: () => number;
  /**
   * Test-only seam: called at labeled points inside Task transition
   * transactions so a spawned process can crash deterministically
   * mid-transaction. Undefined (the production default) is a no-op.
   */
  readonly onTransactionStep?: TransactionStep;
}

interface CreateTaskCommand {
  readonly creatorId: string;
  readonly assigneeId: string;
  readonly reviewerId: string;
  readonly title: string;
  readonly body?: string;
}

interface RequeueTaskCommand {
  readonly actorId: string;
  readonly taskId: string;
  readonly reason: string;
  readonly to?: string;
}

interface AbandonTaskCommand {
  readonly actorId: string;
  readonly taskId: string;
  readonly reason: string;
}

interface LandTaskCommand {
  readonly actorId: string;
  readonly taskId: string;
}

interface CreateReviewWorktreeCommand {
  readonly agentId: string;
  readonly path: string;
  readonly baseRef: string;
}

interface SetReviewWorktreeCurrentRefCommand {
  readonly agentId: string;
  readonly currentRef: string | null;
  readonly expectedCurrentRef: string | null;
}

export class Store {
  readonly databasePath: string;
  readonly #clock: () => number;
  readonly #random: () => number;
  readonly #onStep: TransactionStep | undefined;
  readonly #db: DatabaseSync;
  // Inode of the database file at open. A write that finds a different inode (or
  // none) was opened before a `clean`/replace removed the original, so it fails
  // detectably instead of committing to an orphaned file (no silent loss).
  readonly #openInode: number;
  #closed = false;

  constructor(databasePath: string, options: StoreOptions = {}) {
    this.databasePath = databasePath;
    this.#clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
    this.#random = options.random ?? Math.random;
    this.#onStep = options.onTransactionStep;
    let db: DatabaseSync;
    try {
      db = this.retry(() => {
        return new DatabaseSync(databasePath, {
          allowExtension: false,
          defensive: true,
          enableDoubleQuotedStringLiterals: false,
          enableForeignKeyConstraints: true,
          timeout: BUSY_TIMEOUT_MS,
        });
      });
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
    this.#db = db;
    this.#openInode = statSync(databasePath).ino;

    try {
      this.retry(() => {
        this.configureConnection();
      });
      this.initializeOrValidate();
    } catch (err) {
      this.close();
      mapUnexpectedSqlite(err);
    }
  }

  /**
   * Run an operation, retrying once on SQLITE_BUSY/LOCKED after a bounded
   * jitter wait, then surfacing CONTENTION. The wait draws from the injected
   * `#random` so a seeded run replays identical timing.
   */
  private retry<T>(operation: () => T): T {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return operation();
      } catch (err) {
        if (!isBusy(err)) throw err;
        if (attempt === 1) {
          throw new CrewError(
            'CONTENTION',
            `State Store remained locked after two ${BUSY_TIMEOUT_MS}ms attempts`,
          );
        }
        sleep(backoffMs(this.#random));
      }
    }
    throw new CrewError('CONTENTION', 'State Store remained locked');
  }

  private configureConnection(): void {
    this.#db.exec(`
      PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
      PRAGMA foreign_keys = ON;
      PRAGMA trusted_schema = OFF;
      PRAGMA cell_size_check = ON;
      PRAGMA synchronous = NORMAL;
    `);
  }

  private initializeOrValidate(): void {
    const initialState = this.retry(() => schemaState(this.#db));
    const initialVersion = initialState.version;
    if (initialVersion > CURRENT_SCHEMA_VERSION) {
      throw new CrewError(
        'UNSUPPORTED_SCHEMA',
        `State Store schema version ${initialVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
      );
    }
    if (initialVersion === 0 && !initialState.empty) {
      throw new CrewError(
        'UNSUPPORTED_SCHEMA',
        'refusing to initialize a non-empty schema-version-0 database; export it or use a compatible crew version',
      );
    }

    // WAL is applied only after unsupported-version checks so refusing an old or
    // future database does not rewrite its persistent journal mode.
    this.retry(() => {
      this.#db.exec('PRAGMA journal_mode = WAL');
    });

    if (initialVersion === 0) {
      this.transaction('EXCLUSIVE', () => {
        // A concurrent opener may have initialized while this connection waited.
        const lockedVersion = schemaVersion(this.#db);
        if (lockedVersion === CURRENT_SCHEMA_VERSION) return;
        if (lockedVersion > CURRENT_SCHEMA_VERSION) {
          throw new CrewError(
            'UNSUPPORTED_SCHEMA',
            `State Store schema version ${lockedVersion} is newer than supported version ${CURRENT_SCHEMA_VERSION}`,
          );
        }
        if (lockedVersion !== 0 || !isEmptyVersionZero(this.#db)) {
          throw new CrewError(
            'UNSUPPORTED_SCHEMA',
            'refusing to initialize a non-empty schema-version-0 database; export it or use a compatible crew version',
          );
        }
        this.#db.exec(SCHEMA_SQL);
        assertDatabaseChecks(this.#db);
        this.#db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
      });
    } else if (initialVersion < CURRENT_SCHEMA_VERSION) {
      // An older supported released version: upgrade it under an exclusive
      // migration transaction that rolls back as a whole on any failure.
      this.retry(() => {
        runMigrations(this.#db, initialVersion, CURRENT_SCHEMA_VERSION, MIGRATIONS, () =>
          this.#onStep?.('migrate:before-commit'),
        );
      });
    }

    this.retry(() => {
      assertCurrentSchema(this.#db);
    });
  }

  private transaction<T>(mode: 'IMMEDIATE' | 'EXCLUSIVE', operation: () => T): T {
    return this.retry(() => {
      this.#db.exec(`BEGIN ${mode}`);
      try {
        // With the write lock held, confirm this connection's database file is
        // still the live one. A `clean` that removed it out from under a
        // pre-opened contender is detected here, so the write fails detectably
        // instead of committing to an orphaned file (no silent loss).
        this.#assertLiveStore();
        const result = operation();
        this.#db.exec('COMMIT');
        return result;
      } catch (err) {
        this.#safeRollback();
        throw err;
      }
    });
  }

  /** Throw STALE_STORE if the database file was removed/replaced since open. */
  #assertLiveStore(): void {
    let inode: number;
    try {
      inode = statSync(this.databasePath).ino;
    } catch {
      throw new CrewError(
        'STALE_STORE',
        'the workspace State Store was removed while this operation was in progress; retry',
      );
    }
    if (inode !== this.#openInode) {
      throw new CrewError(
        'STALE_STORE',
        'the workspace State Store was replaced while this operation was in progress; retry',
      );
    }
  }

  /**
   * Read-side liveness check (FR-U32): throw STALE_STORE when the database
   * file was removed or replaced since open. The transaction path runs the
   * same inode comparison under the write lock; Console-facing reads call
   * this wrapper first so an externally deleted Workspace is a deliberate,
   * bounded failure instead of driver-/cache-dependent behavior.
   */
  assertLive(): void {
    this.#assertLiveStore();
  }

  /** Best-effort ROLLBACK; the backing files may already be gone (lock drops on close). */
  #safeRollback(): void {
    if (!this.#db.isTransaction) return;
    try {
      this.#db.exec('ROLLBACK');
    } catch {
      /* store was removed mid-operation; the lock releases when the connection closes */
    }
  }

  /** Read one exact Agent without changing activity metadata. */
  getAgent(id: string): AgentRecord | null {
    assertAgentId(id);
    try {
      const now = operationTime(this.#clock);
      // Like every other read accessor below, the query runs inside retry()
      // so a transient SQLITE_BUSY/LOCKED surfaces as CONTENTION after the
      // bounded retry (FR-I10), never as INTEGRITY.
      return this.retry(() => getAgentRecord(this.#db, id, now));
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /** Atomically allocate a new id, or reactivate one exact archived id. */
  joinAgent(input: JoinAgentInput): AgentRecord {
    assertAgentId(input.id);
    if (input.role !== undefined && (input.role.length < 1 || input.role.length > 64)) {
      throw new CrewError('USAGE', 'role must be between 1 and 64 characters');
    }
    if (input.platformId !== undefined && !isParticipantId(input.platformId)) {
      throw new CrewError(
        'UNSUPPORTED_PLATFORM',
        `unsupported Participant platform "${String(input.platformId)}"`,
      );
    }
    const now = operationTime(this.#clock);
    try {
      return this.transaction('IMMEDIATE', () => joinAgentTx(this.#db, input, now));
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /** Archive one active Agent while preserving its last_seen timestamp. */
  leaveAgent(id: string): AgentRecord {
    assertAgentId(id);
    const now = operationTime(this.#clock);
    try {
      return this.transaction('IMMEDIATE', () => leaveAgentTx(this.#db, id, now));
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /**
   * Remove every untouched Agent stamped with this launch's token (the
   * launch-teardown scoped reap). Best-effort on a CONFIRMED failed
   * teardown; the caller tolerates any throw and degrades to leaving every
   * joined row behind — never a destructive partial state. See
   * {@link reapByLaunchTokenTx} for what "untouched" means and why rows are
   * deleted rather than archived.
   */
  reapByLaunchToken(launchToken: string): number {
    if (typeof launchToken !== 'string' || launchToken.length < 32 || launchToken.length > 128) {
      throw new CrewError('USAGE', 'launch token must be 32 to 128 characters');
    }
    try {
      return this.transaction('IMMEDIATE', () => reapByLaunchTokenTx(this.#db, launchToken));
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /** List Agents in id order, active-only unless includeArchived is true. */
  listAgents(options: { includeArchived?: boolean } = {}): AgentRecord[] {
    this.assertLive();
    const now = operationTime(this.#clock);
    try {
      return this.retry(() => listAgentRecords(this.#db, options.includeArchived === true, now));
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /** Send one direct note or atomically expand @all to the other active Agents. */
  sendMessages(input: SendMessagesInput): MessageRecord[] {
    assertAgentId(input.senderId);
    if (input.recipientId !== '@all') assertAgentId(input.recipientId);
    assertMessageContent(input.content);
    if (
      input.replyTo !== undefined &&
      (!Number.isSafeInteger(input.replyTo) || input.replyTo < 1)
    ) {
      throw new CrewError('USAGE', 'reply-to must be a positive integer Message id');
    }
    if (input.recipientId === '@all' && input.replyTo !== undefined) {
      throw new CrewError('USAGE', 'broadcast Messages cannot be replies');
    }
    const now = operationTime(this.#clock);

    try {
      return this.transaction('IMMEDIATE', () => {
        assertActiveAgent(this.#db, input.senderId);
        let recipients: string[];
        if (input.recipientId === '@all') {
          recipients = (
            this.#db
              .prepare("SELECT id FROM agents WHERE status = 'active' AND id <> ? ORDER BY id")
              .all(input.senderId) as unknown as Array<{ id: string }>
          ).map((row) => row.id);
        } else {
          assertActiveAgent(this.#db, input.recipientId);
          recipients = [input.recipientId];
        }

        if (input.replyTo !== undefined) {
          const participants = messageParticipantIds(this.#db, input.replyTo);
          if (participants === null) {
            throw new CrewError('NOT_FOUND', `no message with id ${input.replyTo}`);
          }
          if (
            participants.senderId !== input.senderId &&
            participants.recipientId !== input.senderId
          ) {
            throw new CrewError('NOT_FOUND', `message ${input.replyTo} is not accessible`);
          }
        }

        const records = recipients.map((recipientId) =>
          insertNote(this.#db, {
            senderId: input.senderId,
            recipientId,
            content: input.content,
            replyTo: input.replyTo ?? null,
            createdAt: now,
          }),
        );
        this.#db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(now, input.senderId);
        return records;
      });
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /** Atomically claim unread Messages for one active Agent with at-most-once delivery. */
  receiveMessages(agentId: string, limit = 50): MessageRecord[] {
    assertAgentId(agentId);
    assertLimit(limit, 500);
    const now = operationTime(this.#clock);
    try {
      return this.transaction('IMMEDIATE', () => {
        assertActiveAgent(this.#db, agentId);
        this.#db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(now, agentId);
        return claimUnreadMessages(this.#db, agentId, limit, now);
      });
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /** List the oldest unread Messages without consuming or touching any Agent. */
  listPendingMessages(input: PendingMessagesInput = {}): MessageRecord[] {
    const limit = input.limit ?? 50;
    assertLimit(limit, 500);
    if (input.agentId !== undefined) assertAgentId(input.agentId);
    try {
      return this.retry(() => {
        if (input.agentId !== undefined) assertAgentExists(this.#db, input.agentId);
        return pendingMessages(this.#db, input.agentId, limit);
      });
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /** Return a content-free summary over the complete unread Inbox. */
  getPendingSummary(agentId: string): InboxState {
    this.assertLive();
    assertAgentId(agentId);
    try {
      return this.retry(() => {
        assertAgentExists(this.#db, agentId);
        return pendingSummary(this.#db, agentId);
      });
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /** List a newest bounded history window, returned oldest-to-newest. */
  listMessageHistory(input: MessageHistoryInput = {}): MessageRecord[] {
    this.assertLive();
    const limit = input.limit ?? 100;
    assertLimit(limit, 1_000);
    if (input.since !== undefined && !Number.isSafeInteger(input.since)) {
      throw new CrewError('USAGE', 'since must resolve to safe integer epoch seconds');
    }
    const filterIds = [input.agentId, input.senderId, input.recipientId].filter(
      (id): id is string => id !== undefined,
    );
    for (const id of filterIds) assertAgentId(id);
    try {
      return this.retry(() => {
        for (const id of new Set(filterIds)) assertAgentExists(this.#db, id);
        return messageHistory(this.#db, {
          ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
          ...(input.senderId !== undefined ? { senderId: input.senderId } : {}),
          ...(input.recipientId !== undefined ? { recipientId: input.recipientId } : {}),
          ...(input.since !== undefined ? { since: input.since } : {}),
          limit,
        });
      });
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /** Create a `queued` Task, its `created` Event, and the assignee notification. */
  createTask(input: CreateTaskCommand): TaskRecord {
    assertAgentId(input.creatorId);
    assertAgentId(input.assigneeId);
    assertAgentId(input.reviewerId);
    assertCodePointRange(input.title, 1, 500, 'task title');
    const body = input.body ?? '';
    assertCodePointRange(body, 0, 100_000, 'task body');
    const now = operationTime(this.#clock);
    try {
      return this.transaction('IMMEDIATE', () =>
        createTask(
          this.#db,
          now,
          {
            creatorId: input.creatorId,
            assigneeId: input.assigneeId,
            reviewerId: input.reviewerId,
            title: input.title,
            body,
          },
          this.#onStep,
        ),
      );
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /**
   * Assignee moves a `queued` Task to `in_progress`, granting a Lease. When
   * `worktree` is supplied (per-Worker Task worktrees enabled), its
   * path/branch/base ref are recorded in the same transaction; omission keeps
   * an already-recorded triple intact across a disabled-feature restart.
   */
  startTask(agentId: string, taskId: string, worktree?: TaskWorktreeInput): TaskRecord {
    assertAgentId(agentId);
    assertTaskId(taskId);
    const now = operationTime(this.#clock);
    try {
      return this.transaction('IMMEDIATE', () =>
        startTask(this.#db, now, agentId, taskId, worktree, this.#onStep),
      );
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /** Unexpired Lease owner moves `in_progress` to `submitted` with a Submission. */
  submitTask(agentId: string, taskId: string, summary: string): TaskRecord {
    assertAgentId(agentId);
    assertTaskId(taskId);
    assertCodePointRange(summary, 1, 100_000, 'submission summary');
    const now = operationTime(this.#clock);
    try {
      return this.transaction('IMMEDIATE', () =>
        submitTask(this.#db, now, agentId, taskId, summary, this.#onStep),
      );
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /** Reviewer moves `submitted` to `completed`, optionally recording a Review. */
  approveTask(reviewerId: string, taskId: string, summary: string | null = null): TaskRecord {
    assertAgentId(reviewerId);
    assertTaskId(taskId);
    if (summary !== null) assertCodePointRange(summary, 1, 100_000, 'review summary');
    const now = operationTime(this.#clock);
    try {
      return this.transaction('IMMEDIATE', () =>
        approveTask(this.#db, now, reviewerId, taskId, summary, this.#onStep),
      );
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /** Creator/reviewer returns a Submission or recovers an expired Lease to `queued`. */
  requeueTask(input: RequeueTaskCommand): TaskRecord {
    assertAgentId(input.actorId);
    assertTaskId(input.taskId);
    assertCodePointRange(input.reason, 1, 100_000, 'requeue reason');
    if (input.to !== undefined) assertAgentId(input.to);
    const now = operationTime(this.#clock);
    try {
      return this.transaction('IMMEDIATE', () =>
        requeueTask(
          this.#db,
          now,
          input.actorId,
          input.taskId,
          input.reason,
          input.to,
          this.#onStep,
        ),
      );
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /**
   * Creator/reviewer retires a `queued`/`in_progress`/`submitted` Task to the
   * terminal `abandoned` status; the plain `operator` Agent identity
   * (ADR-0012) may act as fallback once both the creator and reviewer are
   * archived.
   */
  abandonTask(input: AbandonTaskCommand): TaskRecord {
    assertAgentId(input.actorId);
    assertTaskId(input.taskId);
    assertCodePointRange(input.reason, 0, 100_000, 'abandon reason');
    const now = operationTime(this.#clock);
    try {
      return this.transaction('IMMEDIATE', () =>
        abandonTask(this.#db, now, input.actorId, input.taskId, input.reason, this.#onStep),
      );
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /**
   * Creator/reviewer clears a `completed` Task's worktree bookkeeping after
   * `task land` has already removed it on disk; sends the ADR-0014
   * Sign-off to the assignee as a structured `clear_safe` Message (ADR-0016).
   * Not a status transition: no Task Event is appended.
   */
  landTask(input: LandTaskCommand): TaskRecord {
    assertAgentId(input.actorId);
    assertTaskId(input.taskId);
    const now = operationTime(this.#clock);
    try {
      return this.transaction('IMMEDIATE', () =>
        landTask(this.#db, now, input.actorId, input.taskId, this.#onStep),
      );
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /** Read one Task without changing activity metadata. */
  getTask(id: string): TaskRecord | null {
    assertTaskId(id);
    const now = operationTime(this.#clock);
    try {
      return this.retry(() => selectTask(this.#db, now, id));
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /** List Tasks in `(created_at, id)` order with AND-combined filters. */
  listTasks(filter: TaskListFilter = {}): TaskRecord[] {
    this.assertLive();
    if (filter.assigneeId !== undefined) assertAgentId(filter.assigneeId);
    if (filter.reviewerId !== undefined) assertAgentId(filter.reviewerId);
    const now = operationTime(this.#clock);
    try {
      return this.retry(() => {
        // Filter Agents must exist (archived permitted), matching the Messaging
        // pending/history filter contract, so a typo is NOT_FOUND, not silent empty.
        if (filter.assigneeId !== undefined) assertAgentExists(this.#db, filter.assigneeId);
        if (filter.reviewerId !== undefined) assertAgentExists(this.#db, filter.reviewerId);
        return selectTasks(this.#db, now, filter);
      });
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /**
   * List currently-stale in_progress Tasks with their creator, for
   * the Relay's stale-lease nudge. Read-only: stamps no Agent activity.
   */
  listStaleLeaseTasks(): StaleLeaseTask[] {
    this.assertLive();
    const now = operationTime(this.#clock);
    try {
      return this.retry(() => selectStaleLeaseTasks(this.#db, now));
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /** Read a Task's immutable Events in revision order. */
  getTaskEvents(id: string): TaskEventRecord[] {
    assertTaskId(id);
    try {
      return this.retry(() => selectTaskEvents(this.#db, id));
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /**
   * Read a Task and its Events from one read snapshot so a concurrent transition
   * cannot tear the pair (a Task at revision N with Events through N+1). The
   * deferred transaction's snapshot is fixed at the first read.
   */
  getTaskWithEvents(id: string): { task: TaskRecord | null; events: TaskEventRecord[] } {
    this.assertLive();
    assertTaskId(id);
    const now = operationTime(this.#clock);
    try {
      return this.retry(() => {
        this.#db.exec('BEGIN DEFERRED');
        try {
          const task = selectTask(this.#db, now, id);
          this.#onStep?.('show:after-task');
          const events = task === null ? [] : selectTaskEvents(this.#db, id);
          this.#db.exec('COMMIT');
          return { task, events };
        } catch (err) {
          if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
          throw err;
        }
      });
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /** Read one Agent's dedicated review worktree row, or null if never created. */
  getReviewWorktree(agentId: string): ReviewWorktreeRecord | null {
    assertAgentId(agentId);
    try {
      return this.retry(() => selectReviewWorktree(this.#db, agentId));
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /**
   * Create an Agent's dedicated review worktree row on first use.
   * Idempotent: see {@link insertReviewWorktree}.
   */
  createReviewWorktree(input: CreateReviewWorktreeCommand): ReviewWorktreeRecord {
    assertAgentId(input.agentId);
    const now = operationTime(this.#clock);
    try {
      return this.transaction('IMMEDIATE', () =>
        insertReviewWorktree(this.#db, {
          agentId: input.agentId,
          path: input.path,
          baseRef: input.baseRef,
          now,
        }),
      );
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /**
   * Point an Agent's review worktree at a Task branch, or `null` to mark it
   * idle/restored to its resting base ref. Gated on
   * `expectedCurrentRef` matching the row's live value; returns `false`
   * (never throws) on a lost race so the caller decides how to handle it.
   */
  setReviewWorktreeCurrentRef(input: SetReviewWorktreeCurrentRefCommand): boolean {
    assertAgentId(input.agentId);
    const now = operationTime(this.#clock);
    try {
      return this.transaction('IMMEDIATE', () =>
        updateReviewWorktreeCurrentRef(this.#db, {
          agentId: input.agentId,
          currentRef: input.currentRef,
          expectedCurrentRef: input.expectedCurrentRef,
          now,
        }),
      );
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /**
   * Delete read Messages and completed Tasks older than the supplied retention
   * windows inside one `BEGIN IMMEDIATE` transaction. Cutoffs are derived from
   * the single operation clock so the counts are deterministic.
   */
  pruneState(input: { messagesBeforeSeconds: number; tasksBeforeSeconds: number }): {
    messagesDeleted: number;
    tasksDeleted: number;
  } {
    const now = operationTime(this.#clock);
    const messagesCutoff = now - input.messagesBeforeSeconds;
    const tasksCutoff = now - input.tasksBeforeSeconds;
    if (!Number.isSafeInteger(messagesCutoff) || !Number.isSafeInteger(tasksCutoff)) {
      throw new CrewError('INTEGRITY', 'retention cutoff left the safe-integer range');
    }
    try {
      return this.transaction('IMMEDIATE', () =>
        pruneState(this.#db, { messagesCutoff, tasksCutoff }),
      );
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /** Reclaim free pages. Runs outside any transaction (VACUUM cannot nest). */
  vacuum(): void {
    try {
      this.retry(() => vacuum(this.#db));
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /**
   * Read the monotonic poll cursors the Console server compares between polls
   * to detect Store changes (ADR-0012, FR-U22). Read-only: it consumes no
   * Inbox rows and stamps no Agent activity.
   */
  getChangeSignature(): ChangeSignature {
    this.assertLive();
    const now = operationTime(this.#clock);
    try {
      return this.retry(() => selectChangeSignature(this.#db, now));
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /** Count Agents whose status is `active`. */
  countActiveAgents(): number {
    try {
      return this.retry(() => countActiveAgents(this.#db));
    } catch (err) {
      mapUnexpectedSqlite(err);
    }
  }

  /**
   * Remove the State Store files while holding the write lock with zero active
   * Agents, so a concurrent join cannot commit a row the unlink would orphan: a
   * join that committed first is seen here (ACTIVE_AGENTS); a join still waiting
   * on the lock proceeds only after the files are gone and then fails its own
   * post-lock identity check (STALE_STORE). Returns the basenames removed.
   */
  cleanWhileIdle(unlink: () => readonly string[]): readonly string[] {
    try {
      return this.retry(() => {
        this.#db.exec('BEGIN IMMEDIATE');
        try {
          const active = countActiveAgents(this.#db);
          if (active > 0) {
            throw new CrewError(
              'ACTIVE_AGENTS',
              `refusing to remove the State Store while ${active} active agent(s) exist; archive them or pass --force`,
            );
          }
          const removed = unlink();
          // No COMMIT: nothing was written and the backing files are now gone.
          // The lock is held until this Store closes, so a contender waiting on
          // it proceeds only after the files vanish and fails its identity check.
          this.#safeRollback();
          return removed;
        } catch (err) {
          this.#safeRollback();
          throw err;
        }
      });
    } catch (err) {
      if (err instanceof CrewError) throw err;
      mapUnexpectedSqlite(err);
    }
  }

  /** Read-only evidence for hardened-open and doctor tests; never exposes SQL. */
  connectionSettings(): StoreConnectionSettings {
    return readConnectionSettings(this.#db);
  }

  /** Close the owned connection. Safe to call more than once. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }
}

/** Open the standard State Store below a validated Workspace root. */
export function openWorkspaceStore(
  root: string,
  clock: () => number,
  random: () => number = Math.random,
  onTransactionStep?: (label: string) => void,
): Store {
  ensureManagedDir(root, join(WORKSPACE_DIRNAME, 'state'));
  const databasePath = resolveManagedTarget(
    root,
    join(WORKSPACE_DIRNAME, 'state', STATE_DB_BASENAME),
  );
  return new Store(databasePath, {
    clock,
    random,
    ...(onTransactionStep !== undefined ? { onTransactionStep } : {}),
  });
}
