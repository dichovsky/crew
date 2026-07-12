/** Current-schema definition and structural/integrity validation for the State Store. */
import type { DatabaseSync } from 'node:sqlite';
import { CrewError } from '../errors.js';

export const CURRENT_SCHEMA_VERSION = 7;

export const TABLE_SQL = {
  agents: `CREATE TABLE agents (
  id            TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  role          TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 64),
  platform_id   TEXT CHECK (platform_id IS NULL OR length(platform_id) BETWEEN 1 AND 64),
  joined_at     INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  archived_at   INTEGER,
  launch_token  TEXT CHECK (launch_token IS NULL OR length(launch_token) BETWEEN 32 AND 128),
  CHECK (last_seen >= joined_at),
  CHECK (
    (status = 'active' AND archived_at IS NULL) OR
    (status = 'archived' AND archived_at IS NOT NULL AND archived_at >= joined_at)
  )
) STRICT`,
  tasks: `CREATE TABLE tasks (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  body                TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 100000),
  creator_id          TEXT NOT NULL REFERENCES agents(id),
  assignee_id         TEXT NOT NULL REFERENCES agents(id),
  reviewer_id         TEXT NOT NULL REFERENCES agents(id),
  status              TEXT NOT NULL CHECK (
    status IN ('queued', 'in_progress', 'submitted', 'completed', 'abandoned')
  ),
  revision            INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  lease_owner_id      TEXT REFERENCES agents(id),
  lease_expires_at    INTEGER,
  submission_summary  TEXT CHECK (
    submission_summary IS NULL OR length(submission_summary) BETWEEN 1 AND 100000
  ),
  submitted_at        INTEGER,
  review_summary      TEXT CHECK (review_summary IS NULL OR length(review_summary) <= 100000),
  completed_at        INTEGER,
  abandoned_at        INTEGER,
  worktree_path       TEXT CHECK (worktree_path IS NULL OR length(worktree_path) BETWEEN 1 AND 4096),
  worktree_branch     TEXT CHECK (worktree_branch IS NULL OR length(worktree_branch) BETWEEN 1 AND 255),
  worktree_base_ref   TEXT CHECK (worktree_base_ref IS NULL OR length(worktree_base_ref) BETWEEN 1 AND 255),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (updated_at >= created_at),
  -- worktree_path/worktree_branch/worktree_base_ref vary independently of
  -- status (created at start, still present through submitted/completed,
  -- cleared only by a later land/abandon action) so they are NOT part of the
  -- per-status CHECK matrix below; this is the only invariant they carry: all
  -- three set together or all three NULL. worktree_base_ref is the resolved
  -- ref this Task's branch was created from (e.g. a concrete branch name, not
  -- the literal "HEAD"), persisted because the land-time "has this actually
  -- merged" check must compare against a fixed ancestor, not whatever HEAD
  -- happens to mean evaluated from a different working directory later.
  CHECK ((worktree_path IS NULL) = (worktree_branch IS NULL)
    AND (worktree_path IS NULL) = (worktree_base_ref IS NULL)),
  CHECK (
    (status = 'queued' AND lease_owner_id IS NULL AND lease_expires_at IS NULL
      AND submission_summary IS NULL AND submitted_at IS NULL
      AND review_summary IS NULL AND completed_at IS NULL AND abandoned_at IS NULL) OR
    (status = 'in_progress' AND lease_owner_id IS NOT NULL AND lease_expires_at IS NOT NULL
      AND submission_summary IS NULL AND submitted_at IS NULL
      AND review_summary IS NULL AND completed_at IS NULL AND abandoned_at IS NULL) OR
    (status = 'submitted' AND lease_owner_id IS NULL AND lease_expires_at IS NULL
      AND submission_summary IS NOT NULL AND submitted_at IS NOT NULL
      AND review_summary IS NULL AND completed_at IS NULL AND abandoned_at IS NULL) OR
    (status = 'completed' AND lease_owner_id IS NULL AND lease_expires_at IS NULL
      AND submission_summary IS NOT NULL AND submitted_at IS NOT NULL
      AND completed_at IS NOT NULL AND abandoned_at IS NULL) OR
    (status = 'abandoned' AND lease_owner_id IS NULL AND lease_expires_at IS NULL
      AND review_summary IS NULL AND completed_at IS NULL AND abandoned_at IS NOT NULL)
  )
) STRICT`,
  messages: `CREATE TABLE messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id     TEXT NOT NULL REFERENCES agents(id),
  recipient_id  TEXT NOT NULL REFERENCES agents(id),
  content       TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 100000),
  kind          TEXT NOT NULL DEFAULT 'note' CHECK (
    kind IN ('note', 'task_assigned', 'task_submitted', 'task_approved', 'task_requeued',
             'clear_safe')
  ),
  task_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  reply_to      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  read_at       INTEGER,
  CHECK ((kind = 'note') OR task_id IS NOT NULL),
  CHECK (read_at IS NULL OR read_at >= created_at)
) STRICT`,
  task_events: `CREATE TABLE task_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL CHECK (revision >= 0),
  event_type    TEXT NOT NULL CHECK (
    event_type IN ('created', 'started', 'submitted', 'approved', 'requeued', 'abandoned')
  ),
  actor_id      TEXT NOT NULL REFERENCES agents(id),
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '' CHECK (length(detail) <= 100000),
  created_at    INTEGER NOT NULL,
  UNIQUE (task_id, revision),
  CHECK (from_status IS NULL OR from_status IN ('queued', 'in_progress', 'submitted', 'completed', 'abandoned')),
  CHECK (to_status IN ('queued', 'in_progress', 'submitted', 'completed', 'abandoned')),
  CHECK (
    (event_type = 'created' AND revision = 0 AND from_status IS NULL AND to_status = 'queued') OR
    (event_type = 'started' AND revision > 0 AND from_status = 'queued' AND to_status = 'in_progress') OR
    (event_type = 'submitted' AND revision > 0 AND from_status = 'in_progress' AND to_status = 'submitted') OR
    (event_type = 'approved' AND revision > 0 AND from_status = 'submitted' AND to_status = 'completed') OR
    (event_type = 'requeued' AND revision > 0 AND from_status IN ('in_progress', 'submitted') AND to_status = 'queued') OR
    (event_type = 'abandoned' AND revision > 0 AND from_status IN ('queued', 'in_progress', 'submitted') AND to_status = 'abandoned')
  )
) STRICT`,
  review_worktrees: `CREATE TABLE review_worktrees (
  agent_id      TEXT PRIMARY KEY REFERENCES agents(id),
  path          TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 4096),
  base_ref      TEXT NOT NULL CHECK (length(base_ref) BETWEEN 1 AND 255),
  current_ref   TEXT CHECK (current_ref IS NULL OR length(current_ref) BETWEEN 1 AND 255),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  CHECK (updated_at >= created_at)
) STRICT`,
  agent_mutations: `CREATE TABLE agent_mutations (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  cursor  INTEGER NOT NULL CHECK (cursor >= 1)
) STRICT`,
  observable_mutations: `CREATE TABLE observable_mutations (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  cursor  INTEGER NOT NULL CHECK (cursor >= 1)
) STRICT`,
} as const;

export const INDEX_SQL = {
  idx_messages_unread:
    'CREATE INDEX idx_messages_unread ON messages(recipient_id, id) WHERE read_at IS NULL',
  idx_messages_history: 'CREATE INDEX idx_messages_history ON messages(created_at, id)',
  idx_messages_task:
    'CREATE INDEX idx_messages_task ON messages(task_id) WHERE task_id IS NOT NULL',
  idx_messages_reply_to:
    'CREATE INDEX idx_messages_reply_to ON messages(reply_to) WHERE reply_to IS NOT NULL',
  idx_tasks_assignee_status:
    'CREATE INDEX idx_tasks_assignee_status ON tasks(assignee_id, status, updated_at)',
  idx_tasks_reviewer_status:
    'CREATE INDEX idx_tasks_reviewer_status ON tasks(reviewer_id, status, updated_at)',
  idx_tasks_expired_lease:
    "CREATE INDEX idx_tasks_expired_lease ON tasks(lease_expires_at) WHERE status = 'in_progress'",
  idx_agents_launch_token:
    'CREATE INDEX idx_agents_launch_token ON agents(launch_token) WHERE launch_token IS NOT NULL',
} as const;

/**
 * The single-row `agent_mutations` monotonic cursor: any INSERT,
 * UPDATE, or DELETE on `agents` bumps it, so agent-row transitions that move
 * no MAX/COUNT aggregate — a launch-teardown reap deleting a non-maximal row,
 * or a same-clock-second `last_seen` re-stamp — still move the Console change
 * signature. Triggers (not per-call-site code) enforce this in the database
 * itself, matching the schema's DB-enforced-invariant philosophy: no future
 * agent-write path can forget to bump the cursor.
 */
export const TRIGGER_SQL = {
  trg_agents_mutation_insert: `CREATE TRIGGER trg_agents_mutation_insert AFTER INSERT ON agents
BEGIN
  INSERT INTO agent_mutations (id, cursor) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET cursor = cursor + 1;
END`,
  trg_agents_mutation_update: `CREATE TRIGGER trg_agents_mutation_update AFTER UPDATE ON agents
BEGIN
  INSERT INTO agent_mutations (id, cursor) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET cursor = cursor + 1;
END`,
  trg_agents_mutation_delete: `CREATE TRIGGER trg_agents_mutation_delete AFTER DELETE ON agents
BEGIN
  INSERT INTO agent_mutations (id, cursor) VALUES (1, 1)
    ON CONFLICT (id) DO UPDATE SET cursor = cursor + 1;
END`,
  trg_messages_observable_mutation_insert: `CREATE TRIGGER trg_messages_observable_mutation_insert AFTER INSERT ON messages
BEGIN
  INSERT INTO observable_mutations (id, cursor) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET cursor = cursor + 1;
END`,
  trg_messages_observable_mutation_update: `CREATE TRIGGER trg_messages_observable_mutation_update AFTER UPDATE ON messages
BEGIN
  INSERT INTO observable_mutations (id, cursor) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET cursor = cursor + 1;
END`,
  trg_messages_observable_mutation_delete: `CREATE TRIGGER trg_messages_observable_mutation_delete AFTER DELETE ON messages
BEGIN
  INSERT INTO observable_mutations (id, cursor) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET cursor = cursor + 1;
END`,
  trg_tasks_observable_mutation_insert: `CREATE TRIGGER trg_tasks_observable_mutation_insert AFTER INSERT ON tasks
BEGIN
  INSERT INTO observable_mutations (id, cursor) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET cursor = cursor + 1;
END`,
  trg_tasks_observable_mutation_update: `CREATE TRIGGER trg_tasks_observable_mutation_update AFTER UPDATE ON tasks
BEGIN
  INSERT INTO observable_mutations (id, cursor) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET cursor = cursor + 1;
END`,
  trg_tasks_observable_mutation_delete: `CREATE TRIGGER trg_tasks_observable_mutation_delete AFTER DELETE ON tasks
BEGIN
  INSERT INTO observable_mutations (id, cursor) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET cursor = cursor + 1;
END`,
  trg_task_events_observable_mutation_insert: `CREATE TRIGGER trg_task_events_observable_mutation_insert AFTER INSERT ON task_events
BEGIN
  INSERT INTO observable_mutations (id, cursor) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET cursor = cursor + 1;
END`,
  trg_task_events_observable_mutation_update: `CREATE TRIGGER trg_task_events_observable_mutation_update AFTER UPDATE ON task_events
BEGIN
  INSERT INTO observable_mutations (id, cursor) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET cursor = cursor + 1;
END`,
  trg_task_events_observable_mutation_delete: `CREATE TRIGGER trg_task_events_observable_mutation_delete AFTER DELETE ON task_events
BEGIN
  INSERT INTO observable_mutations (id, cursor) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET cursor = cursor + 1;
END`,
} as const;

const OBSERVABLE_MUTATION_TRIGGER_NAMES = [
  'trg_messages_observable_mutation_insert',
  'trg_messages_observable_mutation_update',
  'trg_messages_observable_mutation_delete',
  'trg_tasks_observable_mutation_insert',
  'trg_tasks_observable_mutation_update',
  'trg_tasks_observable_mutation_delete',
  'trg_task_events_observable_mutation_insert',
  'trg_task_events_observable_mutation_update',
  'trg_task_events_observable_mutation_delete',
] as const satisfies readonly (keyof typeof TRIGGER_SQL)[];

const OBSERVABLE_MUTATION_SCHEMA_OBJECT_NAMES = [
  'observable_mutations',
  ...OBSERVABLE_MUTATION_TRIGGER_NAMES,
] as const;

/**
 * The released v1-v4 shape of `idx_task_events_task`, dropped in v5:
 * it duplicated the implicit `UNIQUE (task_id, revision)` auto-index column
 * for column, adding write amplification with no distinct access path. Frozen
 * here for the v2->v3 rebuild (which must recreate the index exactly as
 * released) and the v4->v5 validate/drop.
 */
export const V4_IDX_TASK_EVENTS_TASK_SQL =
  'CREATE INDEX idx_task_events_task ON task_events(task_id, revision)';

/** Complete schema body, excluding the transaction-owned user_version update. */
export const SCHEMA_SQL = [
  ...Object.values(TABLE_SQL),
  ...Object.values(INDEX_SQL),
  ...Object.values(TRIGGER_SQL),
].join(';\n\n');

/** One ordered upgrade between already released, non-zero schema versions. */
export interface SchemaMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly validate: (db: DatabaseSync) => void;
  readonly apply: (db: DatabaseSync) => void;
}

interface ScalarRow {
  readonly value: number;
}

interface SchemaStateRow {
  readonly version: number;
  readonly empty: number;
}

interface SchemaRow {
  readonly type: string;
  readonly name: string;
  readonly sql: string | null;
}

/** Read the connection's current schema version. */
export function schemaVersion(db: DatabaseSync): number {
  const row = db
    .prepare('SELECT user_version AS value FROM pragma_user_version')
    .get() as unknown as ScalarRow | undefined;
  return row?.value ?? 0;
}

/** Read version and schema emptiness from one SQLite statement/snapshot. */
export function schemaState(db: DatabaseSync): { version: number; empty: boolean } {
  const row = db
    .prepare(
      `SELECT
         (SELECT user_version FROM pragma_user_version) AS version,
         NOT EXISTS (
           SELECT 1 FROM sqlite_schema
           WHERE name NOT LIKE 'sqlite_%'
             AND type IN ('table', 'index', 'view', 'trigger')
         ) AS empty`,
    )
    .get() as unknown as SchemaStateRow;
  return { version: row.version, empty: row.empty === 1 };
}

/** True only when version 0 has no application-defined schema objects. */
export function isEmptyVersionZero(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      "SELECT count(*) AS value FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'view', 'trigger')",
    )
    .get() as unknown as ScalarRow;
  return row.value === 0;
}

export function canonicalSql(sql: string): string {
  let result = '';
  let quoteEnd: "'" | '"' | '`' | ']' | null = null;
  let pendingSpace = false;

  for (let index = 0; index < sql.length; index++) {
    const char = sql[index]!;
    if (quoteEnd !== null) {
      result += char;
      if (char === quoteEnd) {
        // SQL escapes quote characters by doubling them.
        if (quoteEnd !== ']' && sql[index + 1] === quoteEnd) {
          result += sql[++index]!;
        } else {
          quoteEnd = null;
        }
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`' || char === '[') {
      if (pendingSpace && result !== '' && !result.endsWith('(') && !result.endsWith(',')) {
        result += ' ';
      }
      pendingSpace = false;
      quoteEnd = char === '[' ? ']' : char;
      result += char;
      continue;
    }
    if (/\s/.test(char)) {
      pendingSpace = true;
      continue;
    }
    if (char === ';' && sql.slice(index + 1).trim() === '') break;
    if (char === '(' || char === ')' || char === ',') {
      result = result.trimEnd() + char;
      pendingSpace = false;
      continue;
    }
    if (pendingSpace && result !== '' && !result.endsWith('(') && !result.endsWith(',')) {
      result += ' ';
    }
    pendingSpace = false;
    result += char.toLowerCase();
  }
  return result.trim();
}

function integrity(message: string, details?: Record<string, unknown>): never {
  throw new CrewError('INTEGRITY', message, details);
}

/** Fail if quick-check or foreign-key diagnostics report any finding. */
export function assertDatabaseChecks(db: DatabaseSync): void {
  const quick = db.prepare('PRAGMA quick_check').all() as Record<string, unknown>[];
  const quickFindings = quick
    .map((row) => String(Object.values(row)[0]))
    .filter((value) => value !== 'ok');
  if (quickFindings.length > 0) {
    integrity('State Store quick check failed', { findings: quickFindings });
  }

  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length > 0) {
    integrity('State Store foreign-key check failed', { count: foreignKeys.length });
  }
}

/**
 * Transactional runner reserved for future released-schema upgrades. Version 0
 * is deliberately not accepted here: Store initialization owns that separate
 * empty-database policy. The caller acquires/retries contention before entry.
 */
export function runMigrations(
  db: DatabaseSync,
  currentVersion: number,
  targetVersion: number,
  migrations: readonly SchemaMigration[],
  onBeforeCommit?: () => void,
): void {
  if (
    !Number.isSafeInteger(currentVersion) ||
    !Number.isSafeInteger(targetVersion) ||
    currentVersion < 1 ||
    targetVersion <= currentVersion
  ) {
    throw new CrewError('UNSUPPORTED_SCHEMA', 'invalid released-schema migration range');
  }

  // SQLite's documented table-rebuild procedure requires foreign-key
  // ENFORCEMENT off around the migration transaction (the pragma is a silent
  // no-op inside one): with it on, DROP TABLE runs an implicit DELETE that
  // FIRES ON DELETE actions — rebuilding `tasks` would cascade-delete every
  // task-linked `messages` row (verified empirically). Integrity is still
  // proven before COMMIT: assertDatabaseChecks runs PRAGMA foreign_key_check,
  // which is independent of enforcement.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    runMigrationsWithForeignKeysOff(db, currentVersion, targetVersion, migrations, onBeforeCommit);
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function runMigrationsWithForeignKeysOff(
  db: DatabaseSync,
  currentVersion: number,
  targetVersion: number,
  migrations: readonly SchemaMigration[],
  onBeforeCommit?: () => void,
): void {
  db.exec('BEGIN EXCLUSIVE');
  try {
    const actualVersion = schemaVersion(db);
    if (actualVersion === targetVersion) {
      // A concurrent opener already completed this migration under the lock; this
      // is a no-op, not an error (mirrors the v0-init race guard in the Store).
      db.exec('COMMIT');
      return;
    }
    if (actualVersion !== currentVersion) {
      throw new CrewError(
        'INTEGRITY',
        `migration expected schema version ${currentVersion}, found ${actualVersion}`,
      );
    }
    let version = currentVersion;
    while (version < targetVersion) {
      const step = migrations.find(
        (migration) => migration.fromVersion === version && migration.toVersion === version + 1,
      );
      if (step === undefined) {
        throw new CrewError(
          'UNSUPPORTED_SCHEMA',
          `no migration from schema version ${version} to ${version + 1}`,
        );
      }
      step.validate(db);
      step.apply(db);
      version = step.toVersion;
    }
    assertDatabaseChecks(db);
    db.exec(`PRAGMA user_version = ${targetVersion}`);
    // Test-only fault seam: a spawned process that terminates here (after the
    // DDL and version write, before COMMIT) proves the whole migration rolls
    // back — the reopened database stays at the prior version with no partial
    // objects. Undefined in production (a no-op).
    onBeforeCommit?.();
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Ordered released-schema upgrades. v1 -> v2 adds the nullable `launch_token`
 * column (provenance for the launch-teardown scoped reap) and its
 * partial index — an additive step, so its validate confirms column identity
 * via `PRAGMA table_info`, never by comparing raw error text. v2 -> v3
 * rebuilds `tasks` and `task_events` for the `abandoned` terminal status
 * — a DESTRUCTIVE step (DROP + re-CREATE), so its validate compares
 * the FULL canonical SQL of the live tables/indexes (the same
 * `canonicalSql`-normalized technique `findSchemaDrift` uses for the current
 * schema) rather than only column names, so drift in a CHECK, foreign key,
 * STRICT marker, or index cannot silently ride through the rebuild. v3 -> v4
 * rebuilds `tasks` again to add the `worktree_path`/`worktree_branch` pairing
 * (their own standalone CHECK, independent of the per-status matrix) and adds
 * the brand-new `review_worktrees` table (additive, no rebuild needed) — see
 * that migration's own comment below for why a rebuild (not `ALTER TABLE ADD
 * COLUMN`) is required here. v4 -> v5 adds the `agent_mutations` cursor table
 * and its three `agents` triggers and drops the redundant
 * `idx_task_events_task` index — no table rebuild, so its validate
 * compares only the objects it touches. v5 -> v6 rebuilds `messages` to extend
 * its `kind` CHECK with `clear_safe` (ADR-0016 — the structured
 * Sign-off the land/abandon transitions mint), the same full-canonical-SQL
 * validate rigor as the other destructive rebuilds. v6 -> v7 adds the
 * `observable_mutations` cursor plus its nine Message/Task/Event triggers so
 * Console SSE observes mutations that MAX/COUNT cursors cannot detect.
 */

/** The released v2 shape of `tasks` (pre-`abandoned`), for the v2->v3 validate step only. */
const V2_TASKS_SQL = `CREATE TABLE tasks (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  body                TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 100000),
  creator_id          TEXT NOT NULL REFERENCES agents(id),
  assignee_id         TEXT NOT NULL REFERENCES agents(id),
  reviewer_id         TEXT NOT NULL REFERENCES agents(id),
  status              TEXT NOT NULL CHECK (
    status IN ('queued', 'in_progress', 'submitted', 'completed')
  ),
  revision            INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  lease_owner_id      TEXT REFERENCES agents(id),
  lease_expires_at    INTEGER,
  submission_summary  TEXT CHECK (
    submission_summary IS NULL OR length(submission_summary) BETWEEN 1 AND 100000
  ),
  submitted_at        INTEGER,
  review_summary      TEXT CHECK (review_summary IS NULL OR length(review_summary) <= 100000),
  completed_at        INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK (
    (status = 'queued' AND lease_owner_id IS NULL AND lease_expires_at IS NULL
      AND submission_summary IS NULL AND submitted_at IS NULL
      AND review_summary IS NULL AND completed_at IS NULL) OR
    (status = 'in_progress' AND lease_owner_id IS NOT NULL AND lease_expires_at IS NOT NULL
      AND submission_summary IS NULL AND submitted_at IS NULL
      AND review_summary IS NULL AND completed_at IS NULL) OR
    (status = 'submitted' AND lease_owner_id IS NULL AND lease_expires_at IS NULL
      AND submission_summary IS NOT NULL AND submitted_at IS NOT NULL
      AND review_summary IS NULL AND completed_at IS NULL) OR
    (status = 'completed' AND lease_owner_id IS NULL AND lease_expires_at IS NULL
      AND submission_summary IS NOT NULL AND submitted_at IS NOT NULL
      AND completed_at IS NOT NULL)
  )
) STRICT`;

/** The released v2 shape of `task_events` (pre-`abandoned`), for the v2->v3 validate step only. */
const V2_TASK_EVENTS_SQL = `CREATE TABLE task_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL CHECK (revision >= 0),
  event_type    TEXT NOT NULL CHECK (
    event_type IN ('created', 'started', 'submitted', 'approved', 'requeued')
  ),
  actor_id      TEXT NOT NULL REFERENCES agents(id),
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '' CHECK (length(detail) <= 100000),
  created_at    INTEGER NOT NULL,
  UNIQUE (task_id, revision),
  CHECK (from_status IS NULL OR from_status IN ('queued', 'in_progress', 'submitted', 'completed')),
  CHECK (to_status IN ('queued', 'in_progress', 'submitted', 'completed')),
  CHECK (
    (event_type = 'created' AND revision = 0 AND from_status IS NULL AND to_status = 'queued') OR
    (event_type = 'started' AND revision > 0 AND from_status = 'queued' AND to_status = 'in_progress') OR
    (event_type = 'submitted' AND revision > 0 AND from_status = 'in_progress' AND to_status = 'submitted') OR
    (event_type = 'approved' AND revision > 0 AND from_status = 'submitted' AND to_status = 'completed') OR
    (event_type = 'requeued' AND revision > 0 AND from_status IN ('in_progress', 'submitted') AND to_status = 'queued')
  )
) STRICT`;

/** The released v3 shape of `tasks` (pre-`worktree_path`/`worktree_branch`), for the v3->v4 validate step only. */
const V3_TASKS_SQL = `CREATE TABLE tasks (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  body                TEXT NOT NULL DEFAULT '' CHECK (length(body) <= 100000),
  creator_id          TEXT NOT NULL REFERENCES agents(id),
  assignee_id         TEXT NOT NULL REFERENCES agents(id),
  reviewer_id         TEXT NOT NULL REFERENCES agents(id),
  status              TEXT NOT NULL CHECK (
    status IN ('queued', 'in_progress', 'submitted', 'completed', 'abandoned')
  ),
  revision            INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  lease_owner_id      TEXT REFERENCES agents(id),
  lease_expires_at    INTEGER,
  submission_summary  TEXT CHECK (
    submission_summary IS NULL OR length(submission_summary) BETWEEN 1 AND 100000
  ),
  submitted_at        INTEGER,
  review_summary      TEXT CHECK (review_summary IS NULL OR length(review_summary) <= 100000),
  completed_at        INTEGER,
  abandoned_at        INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (updated_at >= created_at),
  CHECK (
    (status = 'queued' AND lease_owner_id IS NULL AND lease_expires_at IS NULL
      AND submission_summary IS NULL AND submitted_at IS NULL
      AND review_summary IS NULL AND completed_at IS NULL AND abandoned_at IS NULL) OR
    (status = 'in_progress' AND lease_owner_id IS NOT NULL AND lease_expires_at IS NOT NULL
      AND submission_summary IS NULL AND submitted_at IS NULL
      AND review_summary IS NULL AND completed_at IS NULL AND abandoned_at IS NULL) OR
    (status = 'submitted' AND lease_owner_id IS NULL AND lease_expires_at IS NULL
      AND submission_summary IS NOT NULL AND submitted_at IS NOT NULL
      AND review_summary IS NULL AND completed_at IS NULL AND abandoned_at IS NULL) OR
    (status = 'completed' AND lease_owner_id IS NULL AND lease_expires_at IS NULL
      AND submission_summary IS NOT NULL AND submitted_at IS NOT NULL
      AND completed_at IS NOT NULL AND abandoned_at IS NULL) OR
    (status = 'abandoned' AND lease_owner_id IS NULL AND lease_expires_at IS NULL
      AND review_summary IS NULL AND completed_at IS NULL AND abandoned_at IS NOT NULL)
  )
) STRICT`;

/** The released v1-v5 shape of `messages` (pre-`clear_safe`), for the v5->v6 validate step only. */
const V5_MESSAGES_SQL = `CREATE TABLE messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id     TEXT NOT NULL REFERENCES agents(id),
  recipient_id  TEXT NOT NULL REFERENCES agents(id),
  content       TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 100000),
  kind          TEXT NOT NULL DEFAULT 'note' CHECK (
    kind IN ('note', 'task_assigned', 'task_submitted', 'task_approved', 'task_requeued')
  ),
  task_id       TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  reply_to      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  read_at       INTEGER,
  CHECK ((kind = 'note') OR task_id IS NOT NULL),
  CHECK (read_at IS NULL OR read_at >= created_at)
) STRICT`;

export const MIGRATIONS: readonly SchemaMigration[] = [
  {
    fromVersion: 1,
    toVersion: 2,
    validate: (db) => {
      const columns = (
        db.prepare('PRAGMA table_info(agents)').all() as unknown as { name: string }[]
      ).map((column) => column.name);
      const expected = [
        'id',
        'role',
        'platform_id',
        'joined_at',
        'last_seen',
        'status',
        'archived_at',
      ];
      const matches =
        columns.length === expected.length &&
        expected.every((name, index) => columns[index] === name);
      if (!matches) {
        throw new CrewError(
          'INTEGRITY',
          'cannot migrate to schema v2: the agents table does not match released schema v1',
        );
      }
    },
    apply: (db) => {
      db.exec(
        'ALTER TABLE agents ADD COLUMN launch_token TEXT ' +
          'CHECK (launch_token IS NULL OR length(launch_token) BETWEEN 32 AND 128)',
      );
      db.exec(INDEX_SQL.idx_agents_launch_token);
    },
  },
  {
    // v2 -> v3: `tasks` gains `abandoned_at` and both `tasks` and
    // `task_events` gain the `abandoned` terminal status in their CHECK
    // constraints. SQLite cannot ALTER a CHECK, so both STRICT tables are
    // fully rebuilt: copy rows to holding tables, DROP, re-CREATE under the
    // FINAL name with the verbatim v3 SQL (never ALTER..RENAME — a rename
    // stores a quoted table name in sqlite_schema, which assertCurrentSchema's
    // canonical comparison would flag as drift forever), refill, and recreate
    // the dropped indexes. Runs with foreign keys off (see runMigrations).
    fromVersion: 2,
    toVersion: 3,
    validate: (db) => {
      // The DROP-and-rebuild below is destructive to anything the live table
      // doesn't share with the canonical v2 shape (a weakened CHECK, a missing
      // foreign key, a lost STRICT marker) AND to anything attached to either
      // table that isn't one of the four known indexes (an extra hand-added
      // index, or a trigger) — DROP TABLE takes its indexes/triggers down with
      // it, silently, with no post-migration trace to catch. So this queries
      // by `tbl_name` (every object belonging to `tasks`/`task_events`, of any
      // type), not by a fixed name list, and rejects on anything beyond the
      // exact expected set — not just a mismatch within it. Table shape itself
      // is compared against the FULL v2 SQL text — the same canonical
      // comparison findSchemaDrift/assertCurrentSchema use for the live
      // schema, just aimed at the pre-migration (v2) shape instead.
      const rows = db
        .prepare(
          'SELECT type, name, sql FROM sqlite_schema ' +
            "WHERE tbl_name IN ('tasks', 'task_events') AND type IN ('table', 'index', 'trigger') " +
            // Implicit autoindexes for the PRIMARY KEY/UNIQUE constraints already
            // declared in the table SQL text above are not separate objects a
            // DBA could have added — they are derived, unnamed by the author,
            // and already covered by the table-shape comparison.
            "AND name NOT LIKE 'sqlite_%'",
        )
        .all() as unknown as SchemaRow[];
      const actual = new Map(rows.map((row) => [`${row.type}:${row.name}`, row.sql]));
      const expected: ReadonlyArray<readonly [string, string]> = [
        ['table:tasks', V2_TASKS_SQL],
        ['table:task_events', V2_TASK_EVENTS_SQL],
        ['index:idx_tasks_assignee_status', INDEX_SQL.idx_tasks_assignee_status],
        ['index:idx_tasks_reviewer_status', INDEX_SQL.idx_tasks_reviewer_status],
        ['index:idx_tasks_expired_lease', INDEX_SQL.idx_tasks_expired_lease],
        ['index:idx_task_events_task', V4_IDX_TASK_EVENTS_TASK_SQL],
      ];
      for (const [key, sql] of expected) {
        const live = actual.get(key);
        if (live === null || live === undefined || canonicalSql(live) !== canonicalSql(sql)) {
          throw new CrewError(
            'INTEGRITY',
            `cannot migrate to schema v3: "${key}" does not match released schema v2`,
          );
        }
      }
      const expectedKeys = new Set(expected.map(([key]) => key));
      const extras = [...actual.keys()].filter((key) => !expectedKeys.has(key));
      if (extras.length > 0) {
        throw new CrewError(
          'INTEGRITY',
          `cannot migrate to schema v3: unexpected schema objects on tasks/task_events: ${extras.join(', ')}`,
        );
      }
      const strict = db.prepare('PRAGMA table_list').all() as unknown as {
        name: string;
        strict: number;
      }[];
      for (const table of ['tasks', 'task_events']) {
        if (strict.find((row) => row.name === table)?.strict !== 1) {
          throw new CrewError(
            'INTEGRITY',
            `cannot migrate to schema v3: "${table}" is not a STRICT table`,
          );
        }
      }
    },
    apply: (db) => {
      const V2_TASK_COLUMNS =
        'id, title, body, creator_id, assignee_id, reviewer_id, status, revision, ' +
        'lease_owner_id, lease_expires_at, submission_summary, submitted_at, ' +
        'review_summary, completed_at, created_at, updated_at';
      const EVENT_COLUMNS =
        'id, task_id, revision, event_type, actor_id, from_status, to_status, detail, created_at';
      db.exec(`CREATE TABLE tasks_migration_v3 AS SELECT ${V2_TASK_COLUMNS} FROM tasks`);
      db.exec(`CREATE TABLE task_events_migration_v3 AS SELECT ${EVENT_COLUMNS} FROM task_events`);
      db.exec('DROP TABLE task_events');
      db.exec('DROP TABLE tasks');
      // Recreate the FROZEN released v3 shape here, never the live `TABLE_SQL.tasks`
      // — that constant now holds v4 (see the v3->v4 step below), so using it here
      // would create v4's columns two steps early and fail that step's own validate.
      // `task_events` is untouched from v3 through the current schema, so the live
      // constant is still correct for it.
      db.exec(V3_TASKS_SQL);
      db.exec(TABLE_SQL.task_events);
      // abandoned_at is omitted from the column list, so every migrated row
      // gets NULL — consistent with the invariant CHECK for every v2 status.
      db.exec(
        `INSERT INTO tasks (${V2_TASK_COLUMNS}) SELECT ${V2_TASK_COLUMNS} FROM tasks_migration_v3`,
      );
      db.exec(
        `INSERT INTO task_events (${EVENT_COLUMNS}) ` +
          `SELECT ${EVENT_COLUMNS} FROM task_events_migration_v3`,
      );
      db.exec('DROP TABLE tasks_migration_v3');
      db.exec('DROP TABLE task_events_migration_v3');
      db.exec(INDEX_SQL.idx_tasks_assignee_status);
      db.exec(INDEX_SQL.idx_tasks_reviewer_status);
      db.exec(INDEX_SQL.idx_tasks_expired_lease);
      db.exec(V4_IDX_TASK_EVENTS_TASK_SQL);
    },
  },
  {
    // v3 -> v4: `tasks` gains the nullable `worktree_path`/`worktree_branch`/
    // `worktree_base_ref` triple (the on-disk worktree an assignee is working
    // in, independent of Task status) plus its own standalone pairing CHECK. SQLite's
    // `ALTER TABLE ADD COLUMN` forbids a CHECK that references another
    // column, so — same as v2 -> v3 — `tasks` is rebuilt: copy rows to a
    // holding table, DROP, re-CREATE under the FINAL name with the verbatim
    // (current) v4 SQL, refill, and recreate its indexes. `task_events` is
    // untouched by this step. The new `review_worktrees` table (one reusable
    // review worktree per Agent) is created fresh — additive, no rebuild
    // needed, so its validate only needs to confirm it does not already
    // exist. Runs with foreign keys off (see runMigrations).
    fromVersion: 3,
    toVersion: 4,
    validate: (db) => {
      // Same rigor as v2 -> v3's validate: query by `tbl_name` (every object
      // belonging to `tasks`, of any type) rather than a fixed name list, and
      // reject on anything beyond the exact expected set, so a hand-added
      // index/trigger or a weakened CHECK cannot silently ride through the
      // rebuild below.
      const rows = db
        .prepare(
          'SELECT type, name, sql FROM sqlite_schema ' +
            "WHERE tbl_name = 'tasks' AND type IN ('table', 'index', 'trigger') " +
            "AND name NOT LIKE 'sqlite_%'",
        )
        .all() as unknown as SchemaRow[];
      const actual = new Map(rows.map((row) => [`${row.type}:${row.name}`, row.sql]));
      const expected: ReadonlyArray<readonly [string, string]> = [
        ['table:tasks', V3_TASKS_SQL],
        ['index:idx_tasks_assignee_status', INDEX_SQL.idx_tasks_assignee_status],
        ['index:idx_tasks_reviewer_status', INDEX_SQL.idx_tasks_reviewer_status],
        ['index:idx_tasks_expired_lease', INDEX_SQL.idx_tasks_expired_lease],
      ];
      for (const [key, sql] of expected) {
        const live = actual.get(key);
        if (live === null || live === undefined || canonicalSql(live) !== canonicalSql(sql)) {
          throw new CrewError(
            'INTEGRITY',
            `cannot migrate to schema v4: "${key}" does not match released schema v3`,
          );
        }
      }
      const expectedKeys = new Set(expected.map(([key]) => key));
      const extras = [...actual.keys()].filter((key) => !expectedKeys.has(key));
      if (extras.length > 0) {
        throw new CrewError(
          'INTEGRITY',
          `cannot migrate to schema v4: unexpected schema objects on tasks: ${extras.join(', ')}`,
        );
      }
      const strict = db.prepare('PRAGMA table_list').all() as unknown as {
        name: string;
        strict: number;
      }[];
      if (strict.find((row) => row.name === 'tasks')?.strict !== 1) {
        throw new CrewError(
          'INTEGRITY',
          'cannot migrate to schema v4: "tasks" is not a STRICT table',
        );
      }
      const existingReviewWorktrees = db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'review_worktrees'")
        .get();
      if (existingReviewWorktrees !== undefined) {
        throw new CrewError(
          'INTEGRITY',
          'cannot migrate to schema v4: "review_worktrees" already exists',
        );
      }
    },
    apply: (db) => {
      const V3_TASK_COLUMNS =
        'id, title, body, creator_id, assignee_id, reviewer_id, status, revision, ' +
        'lease_owner_id, lease_expires_at, submission_summary, submitted_at, ' +
        'review_summary, completed_at, abandoned_at, created_at, updated_at';
      db.exec(`CREATE TABLE tasks_migration_v4 AS SELECT ${V3_TASK_COLUMNS} FROM tasks`);
      db.exec('DROP TABLE tasks');
      db.exec(TABLE_SQL.tasks);
      // worktree_path/worktree_branch/worktree_base_ref are omitted from the
      // column list, so every migrated row gets NULL — consistent with the
      // pairing CHECK.
      db.exec(
        `INSERT INTO tasks (${V3_TASK_COLUMNS}) SELECT ${V3_TASK_COLUMNS} FROM tasks_migration_v4`,
      );
      db.exec('DROP TABLE tasks_migration_v4');
      db.exec(INDEX_SQL.idx_tasks_assignee_status);
      db.exec(INDEX_SQL.idx_tasks_reviewer_status);
      db.exec(INDEX_SQL.idx_tasks_expired_lease);
      db.exec(TABLE_SQL.review_worktrees);
    },
  },
  {
    // v4 -> v5: adds the single-row `agent_mutations` monotonic-cursor table
    // and the three `agents` triggers that bump it on INSERT/UPDATE/DELETE
    // (agent-row transitions the MAX/COUNT change-signature cursors
    // cannot observe), and drops `idx_task_events_task` (it
    // duplicated the implicit `UNIQUE (task_id, revision)` auto-index, so
    // every Task transition maintained two identical b-trees). No table is
    // rebuilt: the only destructive act is the DROP INDEX, and the validate
    // proves the live index is exactly the released redundant shape before
    // dropping it.
    fromVersion: 4,
    toVersion: 5,
    validate: (db) => {
      const index = db
        .prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?")
        .get('idx_task_events_task') as unknown as { sql: string | null } | undefined;
      if (
        index === undefined ||
        index.sql === null ||
        canonicalSql(index.sql) !== canonicalSql(V4_IDX_TASK_EVENTS_TASK_SQL)
      ) {
        throw new CrewError(
          'INTEGRITY',
          'cannot migrate to schema v5: "index:idx_task_events_task" does not match released schema v4',
        );
      }
      // The v5 objects are brand-new; a stray leftover under any of their
      // names must not be silently adopted or overwritten.
      const strays = db
        .prepare('SELECT name FROM sqlite_schema WHERE name IN (?, ?, ?, ?) ORDER BY name')
        .all(
          'agent_mutations',
          'trg_agents_mutation_insert',
          'trg_agents_mutation_update',
          'trg_agents_mutation_delete',
        ) as unknown as { name: string }[];
      if (strays.length > 0) {
        throw new CrewError(
          'INTEGRITY',
          `cannot migrate to schema v5: unexpected schema objects already exist: ${strays
            .map((row) => row.name)
            .join(', ')}`,
        );
      }
    },
    apply: (db) => {
      db.exec('DROP INDEX idx_task_events_task');
      db.exec(TABLE_SQL.agent_mutations);
      db.exec(TRIGGER_SQL.trg_agents_mutation_insert);
      db.exec(TRIGGER_SQL.trg_agents_mutation_update);
      db.exec(TRIGGER_SQL.trg_agents_mutation_delete);
    },
  },
  {
    // v5 -> v6 (ADR-0016): `messages.kind` gains the structured
    // `clear_safe` Sign-off value in its CHECK constraint. SQLite cannot ALTER
    // a CHECK, so — same as the v2->v3 and v3->v4 rebuilds — `messages` is
    // fully rebuilt: copy rows to a holding table, DROP, re-CREATE under the
    // FINAL name with the current (v6) SQL, refill with explicit ids (which
    // also restores the AUTOINCREMENT high-water mark to max(id)), and
    // recreate the four dropped indexes. Runs with foreign keys off (see
    // runMigrations).
    fromVersion: 5,
    toVersion: 6,
    validate: (db) => {
      // Same rigor as the earlier destructive rebuilds: query by `tbl_name`
      // (every object belonging to `messages`, of any type) rather than a
      // fixed name list, and reject on anything beyond the exact expected
      // set, so a hand-added index/trigger or a weakened CHECK cannot
      // silently ride through the rebuild below.
      const rows = db
        .prepare(
          'SELECT type, name, sql FROM sqlite_schema ' +
            "WHERE tbl_name = 'messages' AND type IN ('table', 'index', 'trigger') " +
            "AND name NOT LIKE 'sqlite_%'",
        )
        .all() as unknown as SchemaRow[];
      const actual = new Map(rows.map((row) => [`${row.type}:${row.name}`, row.sql]));
      const expected: ReadonlyArray<readonly [string, string]> = [
        ['table:messages', V5_MESSAGES_SQL],
        ['index:idx_messages_unread', INDEX_SQL.idx_messages_unread],
        ['index:idx_messages_history', INDEX_SQL.idx_messages_history],
        ['index:idx_messages_task', INDEX_SQL.idx_messages_task],
        ['index:idx_messages_reply_to', INDEX_SQL.idx_messages_reply_to],
      ];
      for (const [key, sql] of expected) {
        const live = actual.get(key);
        if (live === null || live === undefined || canonicalSql(live) !== canonicalSql(sql)) {
          throw new CrewError(
            'INTEGRITY',
            `cannot migrate to schema v6: "${key}" does not match released schema v5`,
          );
        }
      }
      const expectedKeys = new Set(expected.map(([key]) => key));
      const extras = [...actual.keys()].filter((key) => !expectedKeys.has(key));
      if (extras.length > 0) {
        throw new CrewError(
          'INTEGRITY',
          `cannot migrate to schema v6: unexpected schema objects on messages: ${extras.join(', ')}`,
        );
      }
      const strict = db.prepare('PRAGMA table_list').all() as unknown as {
        name: string;
        strict: number;
      }[];
      if (strict.find((row) => row.name === 'messages')?.strict !== 1) {
        throw new CrewError(
          'INTEGRITY',
          'cannot migrate to schema v6: "messages" is not a STRICT table',
        );
      }
    },
    apply: (db) => {
      const V5_MESSAGE_COLUMNS =
        'id, sender_id, recipient_id, content, kind, task_id, reply_to, created_at, read_at';
      db.exec(`CREATE TABLE messages_migration_v6 AS SELECT ${V5_MESSAGE_COLUMNS} FROM messages`);
      db.exec('DROP TABLE messages');
      db.exec(TABLE_SQL.messages);
      db.exec(
        `INSERT INTO messages (${V5_MESSAGE_COLUMNS}) ` +
          `SELECT ${V5_MESSAGE_COLUMNS} FROM messages_migration_v6`,
      );
      db.exec('DROP TABLE messages_migration_v6');
      db.exec(INDEX_SQL.idx_messages_unread);
      db.exec(INDEX_SQL.idx_messages_history);
      db.exec(INDEX_SQL.idx_messages_task);
      db.exec(INDEX_SQL.idx_messages_reply_to);
    },
  },
  {
    // v6 -> v7: this cursor makes every Message/Task/Event deletion observable
    // to the Console, including a prune below an existing MAX(id).
    fromVersion: 6,
    toVersion: 7,
    validate: (db) => {
      const strays = db
        .prepare(
          `SELECT name FROM sqlite_schema WHERE name IN (${OBSERVABLE_MUTATION_SCHEMA_OBJECT_NAMES.map(() => '?').join(', ')}) ORDER BY name`,
        )
        .all(...OBSERVABLE_MUTATION_SCHEMA_OBJECT_NAMES) as unknown as { name: string }[];
      if (strays.length > 0) {
        throw new CrewError(
          'INTEGRITY',
          `cannot migrate to schema v7: unexpected schema objects already exist: ${strays
            .map((row) => row.name)
            .join(', ')}`,
        );
      }
    },
    apply: (db) => {
      db.exec(TABLE_SQL.observable_mutations);
      for (const name of OBSERVABLE_MUTATION_TRIGGER_NAMES) {
        db.exec(TRIGGER_SQL[name]);
      }
    },
  },
];

/**
 * Compare a database's structure against the exact current-schema objects and
 * return the first divergence as a human reason, or `null` when it matches. This
 * is the non-throwing core behind {@link assertCurrentSchema}; `doctor` uses it to
 * report a `SCHEMA_DRIFT` finding without aborting. Integrity (quick/foreign-key)
 * checks are intentionally not run here — they are reported separately.
 */
export function findSchemaDrift(db: DatabaseSync): string | null {
  const version = schemaVersion(db);
  if (version !== CURRENT_SCHEMA_VERSION) {
    return `expected version ${CURRENT_SCHEMA_VERSION}, found ${version}`;
  }

  const rows = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'view', 'trigger') ORDER BY type, name",
    )
    .all() as unknown as SchemaRow[];
  const actual = new Map(rows.map((row) => [`${row.type}:${row.name}`, row]));
  const expectedKeys = new Set<string>();

  for (const [name, sql] of Object.entries(TABLE_SQL)) {
    const key = `table:${name}`;
    expectedKeys.add(key);
    const row = actual.get(key);
    if (
      row?.sql === null ||
      row?.sql === undefined ||
      canonicalSql(row.sql) !== canonicalSql(sql)
    ) {
      return `table "${name}" does not match schema v${CURRENT_SCHEMA_VERSION}`;
    }
  }
  for (const [name, sql] of Object.entries(INDEX_SQL)) {
    const key = `index:${name}`;
    expectedKeys.add(key);
    const row = actual.get(key);
    if (
      row?.sql === null ||
      row?.sql === undefined ||
      canonicalSql(row.sql) !== canonicalSql(sql)
    ) {
      return `index "${name}" does not match schema v${CURRENT_SCHEMA_VERSION}`;
    }
  }
  for (const [name, sql] of Object.entries(TRIGGER_SQL)) {
    const key = `trigger:${name}`;
    expectedKeys.add(key);
    const row = actual.get(key);
    if (
      row?.sql === null ||
      row?.sql === undefined ||
      canonicalSql(row.sql) !== canonicalSql(sql)
    ) {
      return `trigger "${name}" does not match schema v${CURRENT_SCHEMA_VERSION}`;
    }
  }

  const extras = [...actual.keys()].filter((key) => !expectedKeys.has(key));
  if (extras.length > 0) {
    return `unexpected schema objects: ${extras.join(', ')}`;
  }

  const tableList = db.prepare('PRAGMA table_list').all() as unknown as {
    name: string;
    strict: number;
  }[];
  for (const name of Object.keys(TABLE_SQL)) {
    if (tableList.find((row) => row.name === name)?.strict !== 1) {
      return `table "${name}" is not STRICT`;
    }
  }

  return null;
}

/**
 * Validate a database against the exact current-schema objects. This catches a
 * database labeled with the current version whose tables, indexes, constraints,
 * or STRICT markers do not match the released contract.
 */
export function assertCurrentSchema(db: DatabaseSync): void {
  const reason = findSchemaDrift(db);
  if (reason !== null) {
    integrity(`State Store schema is malformed: ${reason}`);
  }
  assertDatabaseChecks(db);
}
