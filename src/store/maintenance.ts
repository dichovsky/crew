/**
 * Maintenance SQL for `doctor`, `prune`, and `clean`. This is the only
 * maintenance consumer of `node:sqlite`; handlers receive raw facts and counts
 * and own all rendering and the finding code -> severity vocabulary.
 *
 * `doctor` opens a separate read-only diagnostic connection so diagnosing a
 * broken store never initializes, migrates, or writes WAL. `prune` runs inside
 * the owning Store's `BEGIN IMMEDIATE` transaction; `vacuum` runs outside any
 * transaction.
 */
import { DatabaseSync } from 'node:sqlite';
import { CURRENT_SCHEMA_VERSION, findSchemaDrift, schemaState } from './schema.js';

/** Raw State Store diagnostic facts. Severity/finding mapping lives in `doctor`. */
export interface StoreFacts {
  readonly schemaVersion: number;
  readonly newer: boolean;
  readonly nonEmptyV0: boolean;
  readonly quickCheckOk: boolean;
  readonly foreignKeyOk: boolean;
  readonly schemaDriftReason: string | null;
  readonly staleLeases: readonly string[];
  readonly archivedOwners: readonly { taskId: string; agentId: string }[];
}

export interface PruneCutoffs {
  /** Read Messages created strictly before this epoch second are removed. */
  readonly messagesCutoff: number;
  /**
   * Completed Tasks (by `completed_at`) or Abandoned Tasks (by
   * `abandoned_at`) strictly before this epoch second are eligible.
   */
  readonly tasksCutoff: number;
}

export interface PruneCounts {
  readonly messagesDeleted: number;
  readonly tasksDeleted: number;
}

/** Open a read-only, extension-denied diagnostic connection (no schema writes). */
function openDiagnostic(databasePath: string): DatabaseSync {
  return new DatabaseSync(databasePath, {
    readOnly: true,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  });
}

function quickCheckOk(db: DatabaseSync): boolean {
  const rows = db.prepare('PRAGMA quick_check').all() as Record<string, unknown>[];
  return rows.every((row) => String(Object.values(row)[0]) === 'ok');
}

function foreignKeyOk(db: DatabaseSync): boolean {
  return db.prepare('PRAGMA foreign_key_check').all().length === 0;
}

function selectStaleLeases(db: DatabaseSync, now: number): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM tasks
        WHERE status = 'in_progress' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
        ORDER BY id`,
    )
    .all(now) as unknown as { id: string }[];
  return rows.map((row) => row.id);
}

function selectArchivedOwners(db: DatabaseSync): { taskId: string; agentId: string }[] {
  // An archived assignee or reviewer of a non-terminal Task blocks progress;
  // distinct (task, agent) pairs are reported across both roles. `abandoned`
  // is terminal like `completed` and excluded: the abandon
  // operator-fallback path REQUIRES both creator and reviewer archived, so a
  // successful abandonment would otherwise immediately produce a spurious
  // finding on an already-closed Task.
  const rows = db
    .prepare(
      `SELECT task_id AS taskId, agent_id AS agentId FROM (
         SELECT t.id AS task_id, t.assignee_id AS agent_id
           FROM tasks t JOIN agents a ON a.id = t.assignee_id
          WHERE t.status NOT IN ('completed', 'abandoned') AND a.status = 'archived'
         UNION
         SELECT t.id AS task_id, t.reviewer_id AS agent_id
           FROM tasks t JOIN agents a ON a.id = t.reviewer_id
          WHERE t.status NOT IN ('completed', 'abandoned') AND a.status = 'archived'
       )
       ORDER BY taskId, agentId`,
    )
    .all() as unknown as { taskId: string; agentId: string }[];
  return rows.map((row) => ({ taskId: row.taskId, agentId: row.agentId }));
}

/** Collect diagnostic facts from an already-open read-only connection. */
function collectStoreFacts(db: DatabaseSync, now: number): StoreFacts {
  const state = schemaState(db);
  const version = state.version;
  const newer = version > CURRENT_SCHEMA_VERSION;
  const nonEmptyV0 = version === 0 && !state.empty;
  const quick = quickCheckOk(db);
  const foreign = foreignKeyOk(db);

  // Structure and content checks only make sense for an exact v1 schema. A newer
  // or non-empty v0 store is reported via newer/nonEmptyV0; its tables may not
  // exist, so the per-row queries are skipped.
  let schemaDriftReason: string | null = null;
  let staleLeases: string[] = [];
  let archivedOwners: { taskId: string; agentId: string }[] = [];
  if (version === CURRENT_SCHEMA_VERSION) {
    schemaDriftReason = findSchemaDrift(db);
    if (schemaDriftReason === null) {
      staleLeases = selectStaleLeases(db, now);
      archivedOwners = selectArchivedOwners(db);
    }
  }

  return {
    schemaVersion: version,
    newer,
    nonEmptyV0,
    quickCheckOk: quick,
    foreignKeyOk: foreign,
    schemaDriftReason,
    staleLeases,
    archivedOwners,
  };
}

/** Open the State Store read-only, collect diagnostic facts, and close. */
export function diagnoseStore(databasePath: string, now: number): StoreFacts {
  const db = openDiagnostic(databasePath);
  try {
    return collectStoreFacts(db, now);
  } finally {
    db.close();
  }
}

/** Count active Agents through a read-only connection (clean's idle guard). */
export function readActiveAgentCount(databasePath: string): number {
  const db = openDiagnostic(databasePath);
  try {
    return countActiveAgents(db);
  } finally {
    db.close();
  }
}

/**
 * The eligible-retirable-Task subquery: a `completed` Task past its own
 * `completed_at` cutoff, OR an `abandoned` Task past its own
 * `abandoned_at` cutoff. TWO placeholders — every caller binds the SAME
 * cutoff value twice, once per status branch.
 */
const ELIGIBLE_TASKS = `SELECT id FROM tasks
   WHERE ((status = 'completed' AND completed_at < ?) OR (status = 'abandoned' AND abandoned_at < ?))
     AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.task_id = tasks.id AND m.read_at IS NULL)`;

/**
 * Delete the retention set in explicit referential order inside the caller's
 * transaction, so `changes()` excludes cascades and the returned counts are
 * exact. Steps: (1) Task Events of eligible Tasks, (2) Messages linked to
 * eligible Tasks, (3) the eligible Task rows, (4) remaining old read Messages.
 * `messagesDeleted` folds steps 2 and 4; `tasksDeleted` is step 3.
 */
export function pruneState(db: DatabaseSync, cutoffs: PruneCutoffs): PruneCounts {
  const { messagesCutoff, tasksCutoff } = cutoffs;

  db.prepare(`DELETE FROM task_events WHERE task_id IN (${ELIGIBLE_TASKS})`).run(
    tasksCutoff,
    tasksCutoff,
  );
  const linkedMessages = db
    .prepare(`DELETE FROM messages WHERE task_id IN (${ELIGIBLE_TASKS})`)
    .run(tasksCutoff, tasksCutoff).changes;
  const tasksDeleted = db
    .prepare(
      `DELETE FROM tasks
         WHERE ((status = 'completed' AND completed_at < ?) OR (status = 'abandoned' AND abandoned_at < ?))
           AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.task_id = tasks.id AND m.read_at IS NULL)`,
    )
    .run(tasksCutoff, tasksCutoff).changes;
  const oldMessages = db
    .prepare('DELETE FROM messages WHERE read_at IS NOT NULL AND created_at < ?')
    .run(messagesCutoff).changes;

  return {
    messagesDeleted: Number(linkedMessages) + Number(oldMessages),
    tasksDeleted: Number(tasksDeleted),
  };
}

/** Reclaim free pages. Must run outside any transaction. */
export function vacuum(db: DatabaseSync): void {
  db.exec('VACUUM');
}

/** Count Agents whose status is `active`. */
export function countActiveAgents(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT count(*) AS value FROM agents WHERE status = 'active'")
    .get() as unknown as { value: number };
  return Number(row.value);
}
