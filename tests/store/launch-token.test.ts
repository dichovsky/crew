/**
 * The `launch_token` column, the v1->v2 migration (and its
 * crash-mid-migration rollback), the create-only stamp, and the scoped
 * launch-teardown reap. The token is provenance read back only by the
 * reap — it is never part of `AgentRecord`, so a separate suite proves it never
 * renders.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewError } from '../../src/errors.js';
import { Store } from '../../src/store/index.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/store/schema.js';

const TOKEN = 'a'.repeat(64); // 256-bit hex shape (length within the 32-128 CHECK)
const TOKEN_B = 'b'.repeat(64);
const DROP_V6_OBSERVABLE_MUTATION_OBJECTS = `DROP TRIGGER trg_messages_observable_mutation_insert;
DROP TRIGGER trg_messages_observable_mutation_update;
DROP TRIGGER trg_messages_observable_mutation_delete;
DROP TRIGGER trg_tasks_observable_mutation_insert;
DROP TRIGGER trg_tasks_observable_mutation_update;
DROP TRIGGER trg_tasks_observable_mutation_delete;
DROP TRIGGER trg_task_events_observable_mutation_insert;
DROP TRIGGER trg_task_events_observable_mutation_update;
DROP TRIGGER trg_task_events_observable_mutation_delete;
DROP TABLE observable_mutations;`;

const made: string[] = [];
afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-token-'));
  made.push(dir);
  return join(dir, 'crew.db');
}

function rawToken(path: string, id: string): string | null {
  const db = new DatabaseSync(path);
  try {
    const row = db.prepare('SELECT launch_token FROM agents WHERE id = ?').get(id) as
      { launch_token: string | null } | undefined;
    return row?.launch_token ?? null;
  } finally {
    db.close();
  }
}

function rawVersion(path: string): number {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

function agentColumns(path: string): string[] {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map((c) => c.name);
  } finally {
    db.close();
  }
}

/** Build a current database, optionally seed a row, then DOWNGRADE it to a
 * genuine released schema v1: `tasks`/`task_events` back to their v2 shape
 * (the current Store constructor creates them at v3, but v1->v2 never
 * touched either table, so v1's shape is identical to v2's) via the same
 * drop/create/refill rebuild the forward migration uses, then drop the
 * `agents.launch_token` column/index, the v4-only `review_worktrees` table
 * and the v5-only `agent_mutations` cursor table/triggers (a fresh Store
 * creates the full current schema directly, but a genuine v1 database never
 * had them; v1 DID have `idx_task_events_task`, dropped in v5), rebuild
 * `messages` to its released pre-v6 shape, and reset `user_version`. */
function v1Fixture(path: string, seed?: { id: string; role: string }): void {
  const store = new Store(path, { clock: () => 0 });
  if (seed) store.joinAgent({ id: seed.id, role: seed.role });
  store.close();
  const downgrade = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  downgrade.exec(`BEGIN EXCLUSIVE;
${DROP_V6_OBSERVABLE_MUTATION_OBJECTS}
DROP TRIGGER trg_agents_mutation_insert;
DROP TRIGGER trg_agents_mutation_update;
DROP TRIGGER trg_agents_mutation_delete;
DROP TABLE agent_mutations;
CREATE TABLE tasks_downgrade AS SELECT ${TASK_COLUMNS_V2} FROM tasks;
CREATE TABLE task_events_downgrade AS SELECT ${EVENT_COLUMNS} FROM task_events;
DROP TABLE task_events;
DROP TABLE tasks;
DROP TABLE review_worktrees;
${V2_TASKS_SQL};
${V2_TASK_EVENTS_SQL};
INSERT INTO tasks (${TASK_COLUMNS_V2}) SELECT ${TASK_COLUMNS_V2} FROM tasks_downgrade;
INSERT INTO task_events (${EVENT_COLUMNS}) SELECT ${EVENT_COLUMNS} FROM task_events_downgrade;
DROP TABLE tasks_downgrade;
DROP TABLE task_events_downgrade;
${MESSAGES_DOWNGRADE_SQL};
CREATE INDEX idx_tasks_assignee_status ON tasks(assignee_id, status, updated_at);
CREATE INDEX idx_tasks_reviewer_status ON tasks(reviewer_id, status, updated_at);
CREATE INDEX idx_tasks_expired_lease ON tasks(lease_expires_at) WHERE status = 'in_progress';
CREATE INDEX idx_task_events_task ON task_events(task_id, revision);
COMMIT;`);
  downgrade.close();
  const db = new DatabaseSync(path);
  db.exec('DROP INDEX idx_agents_launch_token');
  db.exec('ALTER TABLE agents DROP COLUMN launch_token');
  db.exec('PRAGMA user_version = 1');
  db.close();
}

describe('schema v1 -> v2 migration', () => {
  it('migrates an existing v1 database, preserving rows and adding the column', () => {
    const path = dbPath();
    v1Fixture(path, { id: 'old', role: 'worker' });
    expect(rawVersion(path)).toBe(1);
    expect(agentColumns(path)).not.toContain('launch_token');

    // Opening through the Store runs v1->v2->v3->v4 (opening always walks
    // to CURRENT_SCHEMA_VERSION) and the full schema validation
    // (assertCurrentSchema) — a successful open is itself the proof.
    const store = new Store(path, { clock: () => 0 });
    try {
      expect(store.getAgent('old')?.role).toBe('worker'); // pre-existing row preserved
    } finally {
      store.close();
    }
    expect(rawVersion(path)).toBe(CURRENT_SCHEMA_VERSION);
    expect(agentColumns(path)).toContain('launch_token');
    expect(rawToken(path, 'old')).toBeNull(); // back-filled NULL
  });

  it('rolls the whole migration back when it is interrupted before commit', () => {
    const path = dbPath();
    v1Fixture(path, { id: 'old', role: 'worker' });

    // A fault at the migrate-before-commit seam stands in for a crash: the
    // exclusive transaction must roll back as a whole.
    expect(
      () =>
        new Store(path, {
          clock: () => 0,
          onTransactionStep: (label) => {
            if (label === 'migrate:before-commit') throw new Error('interrupted');
          },
        }),
    ).toThrow();

    // The database is untouched: still v1, no new column.
    expect(rawVersion(path)).toBe(1);
    expect(agentColumns(path)).not.toContain('launch_token');

    // A clean reopen still migrates successfully (the fixture was recoverable),
    // walking all the way to CURRENT_SCHEMA_VERSION.
    new Store(path, { clock: () => 0 }).close();
    expect(rawVersion(path)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('refuses to migrate a database mislabeled v1 whose agents table is malformed', () => {
    const path = dbPath();
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE agents (id TEXT PRIMARY KEY) STRICT; PRAGMA user_version = 1');
    db.close();
    let code: string | undefined;
    try {
      new Store(path, { clock: () => 0 });
    } catch (err) {
      code = err instanceof CrewError ? err.code : undefined;
    }
    expect(code).toBe('INTEGRITY');
    expect(rawVersion(path)).toBe(1); // not advanced
  });
});

/** The released v2 shapes of the two rebuilt tables (pre-`abandoned`). */
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

const TASK_COLUMNS_V2 =
  'id, title, body, creator_id, assignee_id, reviewer_id, status, revision, ' +
  'lease_owner_id, lease_expires_at, submission_summary, submitted_at, ' +
  'review_summary, completed_at, created_at, updated_at';
const EVENT_COLUMNS =
  'id, task_id, revision, event_type, actor_id, from_status, to_status, detail, created_at';
const MESSAGE_COLUMNS =
  'id, sender_id, recipient_id, content, kind, task_id, reply_to, created_at, read_at';

/** The released v1-v5 shape of `messages` (pre-`clear_safe`): unchanged from v1
 * through v5, so EVERY pre-v6 fixture rebuilds `messages` to this shape — the
 * v5->v6 validate compares the live table's full canonical SQL against it. */
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

/** Downgrade `messages` (created v6-shaped by the current Store) to released
 * v5 via the same drop/create/refill rebuild the forward migration uses;
 * spliced into every pre-v6 fixture's downgrade transaction. */
const MESSAGES_DOWNGRADE_SQL = `CREATE TABLE messages_downgrade AS SELECT ${MESSAGE_COLUMNS} FROM messages;
DROP TABLE messages;
${V5_MESSAGES_SQL};
INSERT INTO messages (${MESSAGE_COLUMNS}) SELECT ${MESSAGE_COLUMNS} FROM messages_downgrade;
DROP TABLE messages_downgrade;
CREATE INDEX idx_messages_unread ON messages(recipient_id, id) WHERE read_at IS NULL;
CREATE INDEX idx_messages_history ON messages(created_at, id);
CREATE INDEX idx_messages_task ON messages(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_messages_reply_to ON messages(reply_to) WHERE reply_to IS NOT NULL`;

/** Build a current database with Tasks in every pre-v3 status (plus their
 * notification messages), then DOWNGRADE tasks/task_events to genuine released
 * v2 via the same drop/create/refill rebuild the forward migration uses,
 * rebuild `messages` to its released pre-v6 shape, and drop the v4-only
 * `review_worktrees` table and the v5-only `agent_mutations` cursor
 * table/triggers (a genuine v2 database never had them). */
function v2Fixture(path: string): { taskIds: Record<string, string> } {
  const store = new Store(path, { clock: () => 10 });
  store.joinAgent({ id: 'manager', role: 'manager' });
  store.joinAgent({ id: 'worker', role: 'worker' });
  store.joinAgent({ id: 'inspector', role: 'inspector' });
  const make = (title: string) =>
    store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title,
    });
  const queued = make('stays queued');
  const inProgress = make('stays in progress');
  store.startTask('worker', inProgress.id);
  const submitted = make('stays submitted');
  store.startTask('worker', submitted.id);
  store.submitTask('worker', submitted.id, 'work done');
  const completed = make('stays completed');
  store.startTask('worker', completed.id);
  store.submitTask('worker', completed.id, 'work done');
  store.approveTask('inspector', completed.id, 'looks good');
  store.close();

  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  db.exec(`BEGIN EXCLUSIVE;
${DROP_V6_OBSERVABLE_MUTATION_OBJECTS}
DROP TRIGGER trg_agents_mutation_insert;
DROP TRIGGER trg_agents_mutation_update;
DROP TRIGGER trg_agents_mutation_delete;
DROP TABLE agent_mutations;
CREATE TABLE tasks_downgrade AS SELECT ${TASK_COLUMNS_V2} FROM tasks;
CREATE TABLE task_events_downgrade AS SELECT ${EVENT_COLUMNS} FROM task_events;
DROP TABLE task_events;
DROP TABLE tasks;
DROP TABLE review_worktrees;
${V2_TASKS_SQL};
${V2_TASK_EVENTS_SQL};
INSERT INTO tasks (${TASK_COLUMNS_V2}) SELECT ${TASK_COLUMNS_V2} FROM tasks_downgrade;
INSERT INTO task_events (${EVENT_COLUMNS}) SELECT ${EVENT_COLUMNS} FROM task_events_downgrade;
DROP TABLE tasks_downgrade;
DROP TABLE task_events_downgrade;
${MESSAGES_DOWNGRADE_SQL};
CREATE INDEX idx_tasks_assignee_status ON tasks(assignee_id, status, updated_at);
CREATE INDEX idx_tasks_reviewer_status ON tasks(reviewer_id, status, updated_at);
CREATE INDEX idx_tasks_expired_lease ON tasks(lease_expires_at) WHERE status = 'in_progress';
CREATE INDEX idx_task_events_task ON task_events(task_id, revision);
PRAGMA user_version = 2;
COMMIT;`);
  db.close();
  return {
    taskIds: {
      queued: queued.id,
      in_progress: inProgress.id,
      submitted: submitted.id,
      completed: completed.id,
    },
  };
}

function rawCount(path: string, sql: string): number {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare(sql).get() as { c: number }).c;
  } finally {
    db.close();
  }
}

function taskColumns(path: string): string[] {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
  } finally {
    db.close();
  }
}

describe('schema v2 -> v3 migration', () => {
  it('migrates a v2 database with rows in every status; data and messages survive', () => {
    const path = dbPath();
    const { taskIds } = v2Fixture(path);
    expect(rawVersion(path)).toBe(2);
    expect(taskColumns(path)).not.toContain('abandoned_at');
    const messagesBefore = rawCount(path, 'SELECT count(*) c FROM messages');
    const eventsBefore = rawCount(path, 'SELECT count(*) c FROM task_events');
    expect(messagesBefore).toBeGreaterThan(0); // task-linked notifications exist

    // Opening through the Store runs v2->v3->v4 AND assertCurrentSchema — a
    // successful open proves the migrated schema matches the released current
    // version.
    const store = new Store(path, { clock: () => 99 });
    try {
      const byId = new Map(store.listTasks().map((task) => [task.id, task]));
      expect(byId.size).toBe(4);
      expect(byId.get(taskIds['queued']!)?.status).toBe('queued');
      const inProgress = byId.get(taskIds['in_progress']!)!;
      expect(inProgress.status).toBe('in_progress');
      expect(inProgress.leaseOwnerId).toBe('worker'); // lease fields survive
      expect(inProgress.leaseExpiresAt).not.toBeNull();
      const submitted = byId.get(taskIds['submitted']!)!;
      expect(submitted.submissionSummary).toBe('work done');
      expect(submitted.submittedAt).not.toBeNull();
      const completed = byId.get(taskIds['completed']!)!;
      expect(completed.completedAt).not.toBeNull();
      expect(completed.reviewSummary).toBe('looks good');
      for (const task of byId.values()) expect(task.abandonedAt).toBeNull();
    } finally {
      store.close();
    }
    expect(rawVersion(path)).toBe(CURRENT_SCHEMA_VERSION);
    expect(taskColumns(path)).toContain('abandoned_at');
    // The rebuild ran with foreign keys off, so DROP TABLE tasks fired NO
    // ON DELETE cascade: every task-linked message row survived.
    expect(rawCount(path, 'SELECT count(*) c FROM messages')).toBe(messagesBefore);
    expect(rawCount(path, 'SELECT count(*) c FROM task_events')).toBe(eventsBefore);
  });

  it('the rebuilt CHECKs accept a valid abandoned row and reject invalid combos', () => {
    const path = dbPath();
    const { taskIds } = v2Fixture(path);
    new Store(path, { clock: () => 0 }).close(); // migrate

    const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
    try {
      const abandon = (id: string, extra: string, value: string | number | null) =>
        db
          .prepare(
            `UPDATE tasks SET status = 'abandoned', abandoned_at = 50,
               lease_owner_id = NULL, lease_expires_at = NULL, revision = revision + 1,
               updated_at = 50, ${extra} WHERE id = ?`,
          )
          .run(value, id);

      // Valid: abandoned from queued, lease NULL, abandoned_at set.
      abandon(taskIds['queued']!, 'title = ?', 'abandoned ok');
      // Valid: the matching task_events transition row.
      db.prepare(
        `INSERT INTO task_events
           (task_id, revision, event_type, actor_id, from_status, to_status, detail, created_at)
         VALUES (?, ?, 'abandoned', 'manager', 'queued', 'abandoned', 'dead', 50)`,
      ).run(taskIds['queued']!, 2);

      // Rejected: abandoned while still holding a lease.
      expect(() =>
        db
          .prepare(
            `UPDATE tasks SET status = 'abandoned', abandoned_at = 50, revision = revision + 1,
               updated_at = 50 WHERE id = ?`,
          )
          .run(taskIds['in_progress']!),
      ).toThrow(/CHECK/);
      // Rejected: status abandoned with abandoned_at NULL.
      expect(() =>
        db
          .prepare(
            `UPDATE tasks SET status = 'abandoned', abandoned_at = NULL,
               lease_owner_id = NULL, lease_expires_at = NULL, revision = revision + 1,
               updated_at = 50 WHERE id = ?`,
          )
          .run(taskIds['submitted']!),
      ).toThrow(/CHECK/);
      // Rejected: an abandoned transition FROM completed (terminal stays terminal).
      expect(() =>
        db
          .prepare(
            `INSERT INTO task_events
               (task_id, revision, event_type, actor_id, from_status, to_status, detail, created_at)
             VALUES (?, 99, 'abandoned', 'manager', 'completed', 'abandoned', '', 50)`,
          )
          .run(taskIds['completed']!),
      ).toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });

  it('rolls the whole v2->v3 rebuild back when interrupted before commit', () => {
    const path = dbPath();
    v2Fixture(path);
    expect(
      () =>
        new Store(path, {
          clock: () => 0,
          onTransactionStep: (label) => {
            if (label === 'migrate:before-commit') throw new Error('interrupted');
          },
        }),
    ).toThrow();

    // Untouched: still v2, no new column, all rows intact.
    expect(rawVersion(path)).toBe(2);
    expect(taskColumns(path)).not.toContain('abandoned_at');
    expect(rawCount(path, 'SELECT count(*) c FROM tasks')).toBe(4);

    // A clean reopen migrates successfully.
    new Store(path, { clock: () => 0 }).close();
    expect(rawVersion(path)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('refuses to migrate when an unexpected index is attached to tasks, without touching it', () => {
    const path = dbPath();
    v2Fixture(path);
    const db = new DatabaseSync(path);
    // A hand-added index the released v2 shape never had. DROP TABLE would
    // silently take this down with the rebuild if validate didn't catch it.
    db.exec('CREATE INDEX idx_tasks_custom ON tasks(title)');
    db.close();
    let code: string | undefined;
    try {
      new Store(path, { clock: () => 0 });
    } catch (err) {
      code = err instanceof CrewError ? err.code : undefined;
    }
    expect(code).toBe('INTEGRITY');
    expect(rawVersion(path)).toBe(2); // untouched
    const remaining = new DatabaseSync(path);
    expect(
      remaining.prepare("SELECT name FROM sqlite_schema WHERE name = 'idx_tasks_custom'").get(),
    ).toBeDefined();
    remaining.close();
  });

  it('refuses a database mislabeled v2 whose tasks table is malformed', () => {
    const path = dbPath();
    v1Fixture(path); // v1 agents shape is fine; force version 2 with a bogus tasks table
    const db = new DatabaseSync(path);
    db.exec('ALTER TABLE agents ADD COLUMN launch_token TEXT');
    db.exec('DROP TABLE tasks');
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY) STRICT');
    db.exec('PRAGMA user_version = 2');
    db.close();
    let code: string | undefined;
    try {
      new Store(path, { clock: () => 0 });
    } catch (err) {
      code = err instanceof CrewError ? err.code : undefined;
    }
    expect(code).toBe('INTEGRITY');
    expect(rawVersion(path)).toBe(2);
  });
});

/** The released v3 shape of `tasks` (pre-`worktree_path`/`worktree_branch`). */
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

const TASK_COLUMNS_V3 =
  'id, title, body, creator_id, assignee_id, reviewer_id, status, revision, ' +
  'lease_owner_id, lease_expires_at, submission_summary, submitted_at, ' +
  'review_summary, completed_at, abandoned_at, created_at, updated_at';

/** Build a current database with one Task, then DOWNGRADE `tasks` to genuine
 * released v3 (pre-worktree columns), rebuild `messages` to its released
 * pre-v6 shape, drop the v4-only `review_worktrees` table and the v5-only
 * `agent_mutations` cursor table/triggers (a genuine v3 database never had
 * them), and recreate `idx_task_events_task` (present in v1-v4, dropped in
 * v5), via the same drop/create/refill rebuild the forward migration uses. */
function v3Fixture(path: string): { taskId: string } {
  const store = new Store(path, { clock: () => 10 });
  store.joinAgent({ id: 'manager', role: 'manager' });
  store.joinAgent({ id: 'worker', role: 'worker' });
  store.joinAgent({ id: 'inspector', role: 'inspector' });
  const task = store.createTask({
    creatorId: 'manager',
    assigneeId: 'worker',
    reviewerId: 'inspector',
    title: 'stays queued',
  });
  store.close();

  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  db.exec(`BEGIN EXCLUSIVE;
${DROP_V6_OBSERVABLE_MUTATION_OBJECTS}
DROP TRIGGER trg_agents_mutation_insert;
DROP TRIGGER trg_agents_mutation_update;
DROP TRIGGER trg_agents_mutation_delete;
DROP TABLE agent_mutations;
CREATE TABLE tasks_downgrade AS SELECT ${TASK_COLUMNS_V3} FROM tasks;
DROP TABLE tasks;
DROP TABLE review_worktrees;
${V3_TASKS_SQL};
INSERT INTO tasks (${TASK_COLUMNS_V3}) SELECT ${TASK_COLUMNS_V3} FROM tasks_downgrade;
DROP TABLE tasks_downgrade;
${MESSAGES_DOWNGRADE_SQL};
CREATE INDEX idx_tasks_assignee_status ON tasks(assignee_id, status, updated_at);
CREATE INDEX idx_tasks_reviewer_status ON tasks(reviewer_id, status, updated_at);
CREATE INDEX idx_tasks_expired_lease ON tasks(lease_expires_at) WHERE status = 'in_progress';
CREATE INDEX idx_task_events_task ON task_events(task_id, revision);
PRAGMA user_version = 3;
COMMIT;`);
  db.close();
  return { taskId: task.id };
}

function tableNames(path: string): string[] {
  const db = new DatabaseSync(path);
  try {
    return (
      db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[]
    ).map((t) => t.name);
  } finally {
    db.close();
  }
}

describe('schema v3 -> v4 migration', () => {
  it('migrates a v3 database: worktree columns added NULL, review_worktrees created, row preserved', () => {
    const path = dbPath();
    const { taskId } = v3Fixture(path);
    expect(rawVersion(path)).toBe(3);
    expect(taskColumns(path)).not.toContain('worktree_path');
    expect(tableNames(path)).not.toContain('review_worktrees');

    const store = new Store(path, { clock: () => 99 });
    try {
      const task = store.listTasks().find((t) => t.id === taskId);
      expect(task?.status).toBe('queued');
    } finally {
      store.close();
    }
    expect(rawVersion(path)).toBe(CURRENT_SCHEMA_VERSION);
    expect(taskColumns(path)).toContain('worktree_path');
    expect(taskColumns(path)).toContain('worktree_branch');
    expect(tableNames(path)).toContain('review_worktrees');
  });

  it('refuses to migrate when an unexpected index is attached to tasks, without touching it', () => {
    const path = dbPath();
    v3Fixture(path);
    const db = new DatabaseSync(path);
    // A hand-added index the released v3 shape never had. DROP TABLE would
    // silently take this down with the rebuild if validate didn't catch it.
    db.exec('CREATE INDEX idx_tasks_custom ON tasks(title)');
    db.close();
    let code: string | undefined;
    try {
      new Store(path, { clock: () => 0 });
    } catch (err) {
      code = err instanceof CrewError ? err.code : undefined;
    }
    expect(code).toBe('INTEGRITY');
    expect(rawVersion(path)).toBe(3); // untouched
    const remaining = new DatabaseSync(path);
    expect(
      remaining.prepare("SELECT name FROM sqlite_schema WHERE name = 'idx_tasks_custom'").get(),
    ).toBeDefined();
    remaining.close();
  });

  it('refuses a database mislabeled v3 whose tasks table is malformed', () => {
    const path = dbPath();
    v3Fixture(path);
    const db = new DatabaseSync(path);
    db.exec('DROP TABLE tasks');
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY) STRICT');
    db.close();
    let code: string | undefined;
    try {
      new Store(path, { clock: () => 0 });
    } catch (err) {
      code = err instanceof CrewError ? err.code : undefined;
    }
    expect(code).toBe('INTEGRITY');
    expect(rawVersion(path)).toBe(3);
  });

  it('refuses to migrate when a stray review_worktrees table already exists', () => {
    const path = dbPath();
    v3Fixture(path);
    const db = new DatabaseSync(path);
    // A genuine v3 database never has this table (it is new in v4); a stray
    // leftover must not be silently adopted or overwritten by CREATE TABLE.
    db.exec(
      'CREATE TABLE review_worktrees (agent_id TEXT PRIMARY KEY, path TEXT NOT NULL, base_ref TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT',
    );
    db.close();
    let code: string | undefined;
    try {
      new Store(path, { clock: () => 0 });
    } catch (err) {
      code = err instanceof CrewError ? err.code : undefined;
    }
    expect(code).toBe('INTEGRITY');
    expect(rawVersion(path)).toBe(3);
  });
});

/** Build a current database with one queued Task, then DOWNGRADE it to genuine
 * released v4: drop the v5-only `agent_mutations` cursor table/triggers,
 * rebuild `messages` to its released pre-v6 shape, and recreate the redundant
 * `idx_task_events_task` a genuine v4 database carried (v5 drops it).
 * Every table shape is unchanged v4 -> v5. */
function v4Fixture(path: string): { taskId: string } {
  const store = new Store(path, { clock: () => 10 });
  store.joinAgent({ id: 'manager', role: 'manager' });
  store.joinAgent({ id: 'worker', role: 'worker' });
  store.joinAgent({ id: 'inspector', role: 'inspector' });
  const task = store.createTask({
    creatorId: 'manager',
    assigneeId: 'worker',
    reviewerId: 'inspector',
    title: 'stays queued',
  });
  store.close();

  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  db.exec(`BEGIN EXCLUSIVE;
${DROP_V6_OBSERVABLE_MUTATION_OBJECTS}
DROP TRIGGER trg_agents_mutation_insert;
DROP TRIGGER trg_agents_mutation_update;
DROP TRIGGER trg_agents_mutation_delete;
DROP TABLE agent_mutations;
${MESSAGES_DOWNGRADE_SQL};
CREATE INDEX idx_task_events_task ON task_events(task_id, revision);
PRAGMA user_version = 4;
COMMIT;`);
  db.close();
  return { taskId: task.id };
}

function schemaObjectNames(path: string, type: 'index' | 'table' | 'trigger'): string[] {
  const db = new DatabaseSync(path);
  try {
    return (
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all(type) as { name: string }[]
    ).map((row) => row.name);
  } finally {
    db.close();
  }
}

describe('schema v4 -> v5 migration (mutation cursor, index drop)', () => {
  it('migrates a v4 database: index dropped, cursor table/triggers created, rows preserved', () => {
    const path = dbPath();
    const { taskId } = v4Fixture(path);
    expect(rawVersion(path)).toBe(4);
    expect(schemaObjectNames(path, 'index')).toContain('idx_task_events_task');
    expect(tableNames(path)).not.toContain('agent_mutations');

    const store = new Store(path, { clock: () => 99 });
    try {
      const task = store.listTasks().find((t) => t.id === taskId);
      expect(task?.status).toBe('queued'); // pre-existing row preserved
      // The v5 cursor is live on a migrated database: an agent write bumps it.
      const before = store.getChangeSignature().agentMutationCursor;
      store.joinAgent({ id: 'late', role: 'worker' });
      expect(store.getChangeSignature().agentMutationCursor).toBeGreaterThan(before);
    } finally {
      store.close();
    }
    expect(rawVersion(path)).toBe(CURRENT_SCHEMA_VERSION);
    expect(schemaObjectNames(path, 'index')).not.toContain('idx_task_events_task');
    expect(tableNames(path)).toContain('agent_mutations');
    expect(schemaObjectNames(path, 'trigger')).toEqual([
      'trg_agents_mutation_delete',
      'trg_agents_mutation_insert',
      'trg_agents_mutation_update',
      'trg_messages_observable_mutation_delete',
      'trg_messages_observable_mutation_insert',
      'trg_messages_observable_mutation_update',
      'trg_task_events_observable_mutation_delete',
      'trg_task_events_observable_mutation_insert',
      'trg_task_events_observable_mutation_update',
      'trg_tasks_observable_mutation_delete',
      'trg_tasks_observable_mutation_insert',
      'trg_tasks_observable_mutation_update',
    ]);
  });

  it('the by-task_id and by-(task_id, revision) reads still use the UNIQUE auto-index', () => {
    const path = dbPath();
    v4Fixture(path);
    new Store(path, { clock: () => 0 }).close(); // migrate to v5

    const db = new DatabaseSync(path);
    try {
      const planFor = (sql: string): string =>
        JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all());
      // Both realistic task_events access patterns resolve to the implicit
      // UNIQUE(task_id, revision) auto-index — the dropped explicit index
      // added no distinct access path.
      expect(planFor('SELECT * FROM task_events WHERE task_id = ?')).toContain(
        'sqlite_autoindex_task_events_1',
      );
      expect(planFor('SELECT * FROM task_events WHERE task_id = ? AND revision = ?')).toContain(
        'sqlite_autoindex_task_events_1',
      );
    } finally {
      db.close();
    }
  });

  it('rolls the whole v4->v5 step back when interrupted before commit', () => {
    const path = dbPath();
    v4Fixture(path);
    expect(
      () =>
        new Store(path, {
          clock: () => 0,
          onTransactionStep: (label) => {
            if (label === 'migrate:before-commit') throw new Error('interrupted');
          },
        }),
    ).toThrow();

    // Untouched: still v4, index still present, no cursor objects.
    expect(rawVersion(path)).toBe(4);
    expect(schemaObjectNames(path, 'index')).toContain('idx_task_events_task');
    expect(tableNames(path)).not.toContain('agent_mutations');

    // A clean reopen migrates successfully.
    new Store(path, { clock: () => 0 }).close();
    expect(rawVersion(path)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('refuses to migrate when a stray agent_mutations table already exists, without touching it', () => {
    const path = dbPath();
    v4Fixture(path);
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE agent_mutations (id INTEGER PRIMARY KEY, cursor INTEGER) STRICT');
    db.close();
    let code: string | undefined;
    try {
      new Store(path, { clock: () => 0 });
    } catch (err) {
      code = err instanceof CrewError ? err.code : undefined;
    }
    expect(code).toBe('INTEGRITY');
    expect(rawVersion(path)).toBe(4); // untouched
    expect(tableNames(path)).toContain('agent_mutations'); // the stray survives for diagnosis
  });

  it('refuses a database mislabeled v4 whose idx_task_events_task is missing', () => {
    const path = dbPath();
    v4Fixture(path);
    const db = new DatabaseSync(path);
    db.exec('DROP INDEX idx_task_events_task');
    db.close();
    let code: string | undefined;
    try {
      new Store(path, { clock: () => 0 });
    } catch (err) {
      code = err instanceof CrewError ? err.code : undefined;
    }
    expect(code).toBe('INTEGRITY');
    expect(rawVersion(path)).toBe(4);
  });
});

/** Build a current database with a completed worktree Task (its lifecycle
 * notifications spanning every pre-v6 kind that Task path mints, one of them
 * read) plus a direct note, then DOWNGRADE `messages` to genuine released v5.
 * Only `messages` changes shape in v5 -> v6. */
function v5Fixture(path: string): { taskId: string } {
  const store = new Store(path, { clock: () => 10 });
  store.joinAgent({ id: 'manager', role: 'manager' });
  store.joinAgent({ id: 'worker', role: 'worker' });
  store.joinAgent({ id: 'inspector', role: 'inspector' });
  const task = store.createTask({
    creatorId: 'manager',
    assigneeId: 'worker',
    reviewerId: 'inspector',
    title: 'lands later',
  });
  store.startTask('worker', task.id, {
    path: '/data/crew/worktrees/abc/task-x',
    branch: 'crew/task-x',
    baseRef: 'main',
  });
  store.submitTask('worker', task.id, 'work done');
  store.approveTask('inspector', task.id, 'looks good');
  store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'hello' });
  store.receiveMessages('worker', 1); // one read row proves read_at survives the rebuild
  store.close();

  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  db.exec(`BEGIN EXCLUSIVE;
${DROP_V6_OBSERVABLE_MUTATION_OBJECTS}
${MESSAGES_DOWNGRADE_SQL};
PRAGMA user_version = 5;
COMMIT;`);
  db.close();
  return { taskId: task.id };
}

/** Build a genuine released v6 database by removing v7's cursor/triggers. */
function v6Fixture(path: string): void {
  v5Fixture(path);
  new Store(path, { clock: () => 0 }).close();
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  db.exec(`BEGIN EXCLUSIVE;
${DROP_V6_OBSERVABLE_MUTATION_OBJECTS}
PRAGMA user_version = 6;
COMMIT;`);
  db.close();
}

function rawMessages(path: string): { kind: string; read_at: number | null }[] {
  const db = new DatabaseSync(path);
  try {
    return db.prepare('SELECT kind, read_at FROM messages ORDER BY id').all() as unknown as {
      kind: string;
      read_at: number | null;
    }[];
  } finally {
    db.close();
  }
}

describe('schema v5 -> v6 migration (ADR-0016 clear_safe kind)', () => {
  it('migrates a v5 database: rows and read state preserved, clear_safe accepted', () => {
    const path = dbPath();
    const { taskId } = v5Fixture(path);
    expect(rawVersion(path)).toBe(5);
    const before = rawMessages(path);
    expect(before.length).toBeGreaterThan(0);
    expect(before.some((m) => m.read_at !== null)).toBe(true);

    const store = new Store(path, { clock: () => 99 });
    try {
      // Pre-existing rows survive the rebuild byte-for-byte (kind + read state).
      expect(rawMessages(path)).toEqual(before);
      // The extended CHECK is live: landing mints the new clear_safe kind.
      const landed = store.landTask({ actorId: 'inspector', taskId });
      expect(landed.worktreePath).toBeNull();
      const signOff = store
        .listPendingMessages({ agentId: 'worker' })
        .find((m) => m.kind === 'clear_safe');
      expect(signOff?.content).toBe(`Task ${taskId}: landed, safe to clear your context.`);
    } finally {
      store.close();
    }
    expect(rawVersion(path)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('rolls the whole v5->v6 rebuild back when interrupted before commit', () => {
    const path = dbPath();
    v5Fixture(path);
    expect(
      () =>
        new Store(path, {
          clock: () => 0,
          onTransactionStep: (label) => {
            if (label === 'migrate:before-commit') throw new Error('interrupted');
          },
        }),
    ).toThrow();

    // Untouched: still v5, no holding table left behind.
    expect(rawVersion(path)).toBe(5);
    expect(tableNames(path)).not.toContain('messages_migration_v6');

    // A clean reopen migrates successfully.
    new Store(path, { clock: () => 0 }).close();
    expect(rawVersion(path)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('refuses to migrate when an unexpected index is attached to messages, without touching it', () => {
    const path = dbPath();
    v5Fixture(path);
    const db = new DatabaseSync(path);
    db.exec('CREATE INDEX idx_messages_custom ON messages(sender_id)');
    db.close();
    let code: string | undefined;
    try {
      new Store(path, { clock: () => 0 });
    } catch (err) {
      code = err instanceof CrewError ? err.code : undefined;
    }
    expect(code).toBe('INTEGRITY');
    expect(rawVersion(path)).toBe(5); // untouched
    expect(schemaObjectNames(path, 'index')).toContain('idx_messages_custom');
  });

  it('refuses a database mislabeled v5 whose messages index set is incomplete', () => {
    const path = dbPath();
    v5Fixture(path);
    const db = new DatabaseSync(path);
    db.exec('DROP INDEX idx_messages_task');
    db.close();
    let code: string | undefined;
    try {
      new Store(path, { clock: () => 0 });
    } catch (err) {
      code = err instanceof CrewError ? err.code : undefined;
    }
    expect(code).toBe('INTEGRITY');
    expect(rawVersion(path)).toBe(5);
  });
});

describe('launch_token stamp (create-only)', () => {
  it('stamps a created Agent and every suffixed sibling, but never a resume', () => {
    const path = dbPath();
    const store = new Store(path, { clock: () => 0 });
    try {
      store.joinAgent({ id: 'worker', role: 'worker', launchToken: TOKEN });
      store.joinAgent({ id: 'worker', role: 'worker', launchToken: TOKEN }); // -> worker-2
      expect(rawToken(path, 'worker')).toBe(TOKEN);
      expect(rawToken(path, 'worker-2')).toBe(TOKEN);

      // resume must not stamp or overwrite the original token.
      store.leaveAgent('worker');
      store.joinAgent({ id: 'worker', resume: true, launchToken: TOKEN_B });
      expect(rawToken(path, 'worker')).toBe(TOKEN);

      // a plain join carries no token.
      store.joinAgent({ id: 'plain', role: 'worker' });
      expect(rawToken(path, 'plain')).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe('reapByLaunchToken (scoped launch-teardown reap)', () => {
  it('deletes only untouched, active rows carrying the given token, freeing their ids', () => {
    const path = dbPath();
    const store = new Store(path, { clock: () => 0 });
    try {
      // Untouched, token T -> reaped (deleted).
      store.joinAgent({ id: 'lone', role: 'worker', launchToken: TOKEN });
      // A Task gives mgr/worker/insp a footprint (table refs + a 'created' event).
      store.joinAgent({ id: 'mgr', role: 'manager', launchToken: TOKEN });
      store.joinAgent({ id: 'worker', role: 'worker', launchToken: TOKEN });
      store.joinAgent({ id: 'insp', role: 'inspector', launchToken: TOKEN });
      store.createTask({
        creatorId: 'mgr',
        assigneeId: 'worker',
        reviewerId: 'insp',
        title: 'Do the thing',
      });
      // A Message gives chatter a footprint.
      store.joinAgent({ id: 'chatter', role: 'worker', launchToken: TOKEN });
      store.sendMessages({ senderId: 'chatter', recipientId: 'mgr', content: 'hi' });
      // Foreign token, no token, and already-archived rows must be left alone.
      store.joinAgent({ id: 'foreign', role: 'worker', launchToken: TOKEN_B });
      store.joinAgent({ id: 'plain', role: 'worker' });
      store.joinAgent({ id: 'gone', role: 'worker', launchToken: TOKEN });
      store.leaveAgent('gone');

      const reaped = store.reapByLaunchToken(TOKEN);
      expect(reaped).toBe(1);

      // The untouched row is gone entirely (not archived), and the rest survive.
      const present = new Set(store.listAgents({ includeArchived: true }).map((a) => a.id));
      expect(present.has('lone')).toBe(false); // deleted
      expect(store.getAgent('lone')).toBeNull();
      for (const id of ['mgr', 'worker', 'insp', 'chatter', 'foreign', 'plain']) {
        expect(store.getAgent(id)?.status).toBe('active'); // touched/foreign/no-token survive
      }
      expect(store.getAgent('gone')?.status).toBe('archived'); // archived row untouched

      // The freed id is immediately reusable (relaunchability) — it allocates the
      // base id, not a suffix.
      expect(store.joinAgent({ id: 'lone', role: 'worker' }).id).toBe('lone');
    } finally {
      store.close();
    }
  });

  it('returns 0 when no untouched row matches the token (degrades to baseline)', () => {
    const path = dbPath();
    const store = new Store(path, { clock: () => 0 });
    try {
      store.joinAgent({ id: 'foreign', role: 'worker', launchToken: TOKEN_B });
      expect(store.reapByLaunchToken(TOKEN)).toBe(0);
      expect(store.getAgent('foreign')?.status).toBe('active');
    } finally {
      store.close();
    }
  });

  it('rejects a token outside the 32-128 length bound', () => {
    const path = dbPath();
    const store = new Store(path, { clock: () => 0 });
    try {
      expect(() => store.reapByLaunchToken('short')).toThrow(CrewError);
      expect(() => store.reapByLaunchToken('short')).toThrow(/32 to 128/);
    } finally {
      store.close();
    }
  });
});

describe('schema v6 -> v7 migration (observable mutation cursor)', () => {
  it('refuses a stray v7 object without changing the released v6 database', () => {
    const path = dbPath();
    v6Fixture(path);
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE observable_mutations (id INTEGER PRIMARY KEY) STRICT');
    db.close();

    let code: string | undefined;
    try {
      new Store(path, { clock: () => 0 });
    } catch (err) {
      code = err instanceof CrewError ? err.code : undefined;
    }

    expect(code).toBe('INTEGRITY');
    expect(rawVersion(path)).toBe(6);
  });
});
