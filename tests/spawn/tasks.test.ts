import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { initWorkspace } from '../../src/init.js';
import { Store } from '../../src/store/index.js';
import { CURRENT_SCHEMA_VERSION } from '../../src/store/schema.js';
import { captureIo } from '../helpers/io.js';
import {
  dumpStressFailure,
  SEEDED_RANDOM_SNIPPET,
  stressIterations,
  stressTimeoutMs,
} from '../helpers/stress.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runModule = pathToFileURL(join(root, 'dist', 'src', 'run.js')).href;
const storeModule = pathToFileURL(join(root, 'dist', 'src', 'store', 'index.js')).href;

const ITERATIONS = stressIterations();
const STRESS_TIMEOUT = stressTimeoutMs();

/** A contender that runs one crew command through `run` behind a start barrier. */
const childScript = `
  import { existsSync, writeFileSync } from 'node:fs';
  import { setTimeout as delay } from 'node:timers/promises';
  const [cwd, barrier, ready, clockValue, argvJson] = process.argv.slice(1);${SEEDED_RANDOM_SNIPPET}
  const { run } = await import(${JSON.stringify(runModule)});
  writeFileSync(ready, 'ready');
  while (!existsSync(barrier)) await delay(5);
  let stdout = '';
  let stderr = '';
  const status = await run(JSON.parse(argvJson), {
    cwd, env: {}, stdin: process.stdin,
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    clock: () => Number(clockValue),
    random,
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = status;
`;

/** A process that crashes deterministically after the submit UPDATE, before commit. */
const crashScript = `
  const [dbPath, taskId] = process.argv.slice(1);
  const { Store } = await import(${JSON.stringify(storeModule)});
  const store = new Store(dbPath, {
    clock: () => 100,
    onTransactionStep: (label) => { if (label === 'submit:after-update') process.exit(137); },
  });
  store.submitTask('worker', taskId, 'crashed mid-transaction');
  store.close();
`;

/**
 * The test-only fault build: drive a real `crew task submit` through `run()`
 * and crash after the submit UPDATE, before commit, via the optional Io fault
 * seam (`onTransactionStep`). Exercises the same command path the shipped binary
 * uses — production never sets the seam. Also supplies a seeded `random`.
 */
const faultRunScript = `
  const [cwd, argvJson] = process.argv.slice(1);
  const { run } = await import(${JSON.stringify(runModule)});
  const status = await run(JSON.parse(argvJson), {
    cwd, env: {}, stdin: process.stdin,
    stdout: () => {}, stderr: () => {},
    clock: () => 100,
    random: () => 0.5,
    onTransactionStep: (label) => { if (label === 'submit:after-update') process.exit(137); },
  });
  process.exitCode = status;
`;

/**
 * Drive a real `crew` command through `run()` whose Store open triggers the
 * v1->v2 migration, and crash via the Io fault seam after the DDL/version write
 * but before COMMIT. Proves the exclusive migration transaction rolls back on a
 * process crash (FR-I14); production never sets the seam.
 */
const migrationFaultScript = `
  const [cwd, argvJson] = process.argv.slice(1);
  const { run } = await import(${JSON.stringify(runModule)});
  await run(JSON.parse(argvJson), {
    cwd, env: {}, stdin: process.stdin,
    stdout: () => {}, stderr: () => {},
    clock: () => 0, random: () => 0.5,
    onTransactionStep: (label) => { if (label === 'migrate:before-commit') process.exit(137); },
  });
`;

const made: string[] = [];

function workspace(): { cwd: string; store: Store; dbPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-spawn-task-'));
  made.push(cwd);
  initWorkspace(captureIo({ cwd }).io, { withGuides: false, json: false });
  const dbPath = join(cwd, '.crew', 'state', 'crew.db');
  const store = new Store(dbPath, { clock: () => 0 });
  store.joinAgent({ id: 'manager', role: 'manager' });
  store.joinAgent({ id: 'worker', role: 'worker' });
  store.joinAgent({ id: 'inspector', role: 'inspector' });
  return { cwd, store, dbPath };
}

function child(
  cwd: string,
  barrier: string,
  ready: string,
  clock: number,
  argv: readonly string[],
) {
  return execa(
    'node',
    [
      '--no-warnings',
      '--input-type=module',
      '--eval',
      childScript,
      cwd,
      barrier,
      ready,
      String(clock),
      JSON.stringify(argv),
    ],
    { reject: false, cwd: root },
  );
}

async function waitUntilReady(paths: readonly string[]): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (!paths.every((path) => existsSync(path))) {
    if (Date.now() >= deadline) throw new Error('child readiness barrier timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Release N barrier-synchronized contenders and return their results. */
async function race(
  cwd: string,
  iteration: number,
  clock: number,
  argvs: ReadonlyArray<readonly string[]>,
): Promise<Array<{ exitCode: number | undefined; stderr: string }>> {
  const barrier = join(cwd, `barrier-${iteration}`);
  const readies = argvs.map((_, index) => join(cwd, `ready-${iteration}-${index}`));
  const contenders = argvs.map((argv, index) => child(cwd, barrier, readies[index]!, clock, argv));
  await waitUntilReady(readies);
  writeFileSync(barrier, 'go');
  const results = await Promise.all(contenders);
  return results.map((result) => ({
    exitCode: result.exitCode ?? undefined,
    stderr: result.stderr,
  }));
}

function assertExactlyOneWinner(
  results: ReadonlyArray<{ exitCode: number | undefined; stderr: string }>,
): void {
  const winners = results.filter((result) => result.exitCode === 0);
  const losers = results.filter((result) => result.exitCode === 1);
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(results.length - 1);
  for (const loser of losers) {
    expect(JSON.parse(loser.stderr)).toMatchObject({ error: { code: 'TASK_CONFLICT' } });
  }
}

function assertHealthy(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  expect(db.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  db.close();
}

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' });
}, 120_000);

afterEach((ctx) => {
  dumpStressFailure(ctx, { made }); // retain seed + failing DB copy on failure
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true, maxRetries: 5 });
});

describe('forced Task transition contention (FR-E15/E18, FR-I12-I14)', () => {
  it(
    'admits exactly one of many concurrent starts',
    async () => {
      const { cwd, store, dbPath } = workspace();
      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        const id = store.createTask({
          creatorId: 'manager',
          assigneeId: 'worker',
          reviewerId: 'inspector',
          title: 'race',
        }).id;
        const results = await race(cwd, iteration, 100, [
          ['task', 'start', 'worker', id, '--json'],
          ['task', 'start', 'worker', id, '--json'],
          ['task', 'start', 'worker', id, '--json'],
          ['task', 'start', 'worker', id, '--json'],
        ]);
        assertExactlyOneWinner(results);
        expect(store.getTask(id)).toMatchObject({ status: 'in_progress', revision: 1 });
        const events = store.getTaskEvents(id);
        expect(events.filter((event) => event.eventType === 'started')).toHaveLength(1);
        expect(events).toHaveLength(2);
      }
      store.close();
      assertHealthy(dbPath);
    },
    STRESS_TIMEOUT,
  );

  it(
    'commits exactly one of many concurrent submits',
    async () => {
      const { cwd, store, dbPath } = workspace();
      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        const id = store.createTask({
          creatorId: 'manager',
          assigneeId: 'worker',
          reviewerId: 'inspector',
          title: 'race',
        }).id;
        store.startTask('worker', id); // lease_expires_at = 900
        const results = await race(cwd, iteration, 100, [
          ['task', 'submit', 'worker', id, '--summary', 'a', '--json'],
          ['task', 'submit', 'worker', id, '--summary', 'b', '--json'],
          ['task', 'submit', 'worker', id, '--summary', 'c', '--json'],
        ]);
        assertExactlyOneWinner(results);
        expect(store.getTask(id)).toMatchObject({ status: 'submitted', revision: 2 });
        const events = store.getTaskEvents(id);
        expect(events.filter((event) => event.eventType === 'submitted')).toHaveLength(1);
        expect(events).toHaveLength(3);
      }
      store.close();
      assertHealthy(dbPath);
    },
    STRESS_TIMEOUT,
  );

  it(
    'allows exactly one transition when approve races requeue from submitted',
    async () => {
      const { cwd, store, dbPath } = workspace();
      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        const id = store.createTask({
          creatorId: 'manager',
          assigneeId: 'worker',
          reviewerId: 'inspector',
          title: 'race',
        }).id;
        store.startTask('worker', id);
        store.submitTask('worker', id, 'ready for review'); // revision 2
        const results = await race(cwd, iteration, 100, [
          ['task', 'approve', 'inspector', id, '--json'],
          ['task', 'requeue', 'manager', id, '--reason', 'redo', '--json'],
        ]);
        assertExactlyOneWinner(results);
        const after = store.getTask(id);
        expect(after?.revision).toBe(3);
        expect(['completed', 'queued']).toContain(after?.status);
        const events = store.getTaskEvents(id);
        expect(events).toHaveLength(4);
        expect(events.filter((event) => event.revision === 3)).toHaveLength(1);
      }
      store.close();
      assertHealthy(dbPath);
    },
    STRESS_TIMEOUT,
  );

  it(
    'lets exactly one of creator/reviewer recover an expired Lease',
    async () => {
      const { cwd, store, dbPath } = workspace();
      for (let iteration = 0; iteration < ITERATIONS; iteration++) {
        const id = store.createTask({
          creatorId: 'manager',
          assigneeId: 'worker',
          reviewerId: 'inspector',
          title: 'race',
        }).id;
        store.startTask('worker', id); // lease_expires_at = 900
        const results = await race(cwd, iteration, 1_000, [
          ['task', 'requeue', 'manager', id, '--reason', 'recover-a', '--json'],
          ['task', 'requeue', 'inspector', id, '--reason', 'recover-b', '--json'],
        ]);
        assertExactlyOneWinner(results);
        expect(store.getTask(id)).toMatchObject({ status: 'queued', revision: 2 });
        const events = store.getTaskEvents(id);
        expect(events.filter((event) => event.eventType === 'requeued')).toHaveLength(1);
        expect(events).toHaveLength(3);
      }
      store.close();
      assertHealthy(dbPath);
    },
    STRESS_TIMEOUT,
  );

  it(
    'exposes all-or-none state after a crash between the submit UPDATE and commit',
    async () => {
      const rounds = Math.min(ITERATIONS, 3);
      const { store, dbPath } = workspace();
      store.close(); // agents are joined; each round opens its own connection
      for (let iteration = 0; iteration < rounds; iteration++) {
        const setup = new Store(dbPath, { clock: () => 0 });
        const id = setup.createTask({
          creatorId: 'manager',
          assigneeId: 'worker',
          reviewerId: 'inspector',
          title: 'crash',
        }).id;
        setup.startTask('worker', id); // in_progress, revision 1, lease unexpired at clock 100
        setup.close();

        const crashed = await execa(
          'node',
          ['--no-warnings', '--input-type=module', '--eval', crashScript, dbPath, id],
          { reject: false, cwd: root },
        );
        expect(crashed.exitCode).toBe(137);

        // The submit never committed: the Task is still in_progress with no submitted Event.
        const reopened = new Store(dbPath, { clock: () => 100 });
        expect(reopened.getTask(id)).toMatchObject({
          status: 'in_progress',
          revision: 1,
          submissionSummary: null,
        });
        expect(reopened.getTaskEvents(id).map((event) => event.eventType)).toEqual([
          'created',
          'started',
        ]);
        expect(
          reopened
            .listPendingMessages({ agentId: 'inspector' })
            .some((m) => m.kind === 'task_submitted'),
        ).toBe(false);
        reopened.close();
      }
      assertHealthy(dbPath);
    },
    STRESS_TIMEOUT,
  );

  it(
    'exposes all-or-none state after a crash through the run() submit path (Io fault seam)',
    async () => {
      const rounds = Math.min(ITERATIONS, 3);
      const { cwd, store, dbPath } = workspace();
      store.close(); // agents are joined; each round opens its own connection
      for (let iteration = 0; iteration < rounds; iteration++) {
        const setup = new Store(dbPath, { clock: () => 0 });
        const id = setup.createTask({
          creatorId: 'manager',
          assigneeId: 'worker',
          reviewerId: 'inspector',
          title: 'crash-run',
        }).id;
        setup.startTask('worker', id); // in_progress, revision 1
        setup.close();

        // Crash mid-submit through the real CLI dispatch, not a direct Store call.
        const crashed = await execa(
          'node',
          [
            '--no-warnings',
            '--input-type=module',
            '--eval',
            faultRunScript,
            cwd,
            JSON.stringify([
              'task',
              'submit',
              'worker',
              id,
              '--summary',
              'crashed via run()',
              '--json',
            ]),
          ],
          { reject: false, cwd: root },
        );
        expect(crashed.exitCode).toBe(137);

        // The submit never committed: still in_progress, no submitted Event, no notification.
        const reopened = new Store(dbPath, { clock: () => 100 });
        expect(reopened.getTask(id)).toMatchObject({
          status: 'in_progress',
          revision: 1,
          submissionSummary: null,
        });
        expect(reopened.getTaskEvents(id).map((event) => event.eventType)).toEqual([
          'created',
          'started',
        ]);
        expect(
          reopened
            .listPendingMessages({ agentId: 'inspector' })
            .some((m) => m.kind === 'task_submitted'),
        ).toBe(false);
        reopened.close();
      }
      assertHealthy(dbPath);
    },
    STRESS_TIMEOUT,
  );
});

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
const EVENT_COLUMNS_V2 =
  'id, task_id, revision, event_type, actor_id, from_status, to_status, detail, created_at';
const MESSAGE_COLUMNS_V5 =
  'id, sender_id, recipient_id, content, kind, task_id, reply_to, created_at, read_at';

/** The released v1-v5 shape of `messages` (pre-`clear_safe`, rebuilt in v6). */
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

/** DOWNGRADE `tasks`/`task_events` on an already-built current database back to
 * their genuine released v2 shape (v1's shape is identical to v2's — v1->v2
 * never touched either table), via the same drop/create/refill rebuild the
 * forward migration uses. The current Store constructor creates both tables
 * at v3, so a fixture that only downgrades `agents` leaves a hybrid,
 * non-genuine "v1" database once a v2->v3 migration exists. */
function downgradeTasksToV2(dbPath: string): void {
  const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
  db.exec(`BEGIN EXCLUSIVE;
DROP TRIGGER trg_agents_mutation_insert;
DROP TRIGGER trg_agents_mutation_update;
DROP TRIGGER trg_agents_mutation_delete;
DROP TABLE agent_mutations;
DROP TRIGGER trg_messages_observable_mutation_insert;
DROP TRIGGER trg_messages_observable_mutation_update;
DROP TRIGGER trg_messages_observable_mutation_delete;
DROP TRIGGER trg_tasks_observable_mutation_insert;
DROP TRIGGER trg_tasks_observable_mutation_update;
DROP TRIGGER trg_tasks_observable_mutation_delete;
DROP TRIGGER trg_task_events_observable_mutation_insert;
DROP TRIGGER trg_task_events_observable_mutation_update;
DROP TRIGGER trg_task_events_observable_mutation_delete;
DROP TABLE observable_mutations;
CREATE TABLE tasks_downgrade AS SELECT ${TASK_COLUMNS_V2} FROM tasks;
CREATE TABLE task_events_downgrade AS SELECT ${EVENT_COLUMNS_V2} FROM task_events;
DROP TABLE task_events;
DROP TABLE tasks;
DROP TABLE review_worktrees;
${V2_TASKS_SQL};
${V2_TASK_EVENTS_SQL};
INSERT INTO tasks (${TASK_COLUMNS_V2}) SELECT ${TASK_COLUMNS_V2} FROM tasks_downgrade;
INSERT INTO task_events (${EVENT_COLUMNS_V2}) SELECT ${EVENT_COLUMNS_V2} FROM task_events_downgrade;
DROP TABLE tasks_downgrade;
DROP TABLE task_events_downgrade;
CREATE TABLE messages_downgrade AS SELECT ${MESSAGE_COLUMNS_V5} FROM messages;
DROP TABLE messages;
${V5_MESSAGES_SQL};
INSERT INTO messages (${MESSAGE_COLUMNS_V5}) SELECT ${MESSAGE_COLUMNS_V5} FROM messages_downgrade;
DROP TABLE messages_downgrade;
CREATE INDEX idx_messages_unread ON messages(recipient_id, id) WHERE read_at IS NULL;
CREATE INDEX idx_messages_history ON messages(created_at, id);
CREATE INDEX idx_messages_task ON messages(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_messages_reply_to ON messages(reply_to) WHERE reply_to IS NOT NULL;
CREATE INDEX idx_tasks_assignee_status ON tasks(assignee_id, status, updated_at);
CREATE INDEX idx_tasks_reviewer_status ON tasks(reviewer_id, status, updated_at);
CREATE INDEX idx_tasks_expired_lease ON tasks(lease_expires_at) WHERE status = 'in_progress';
CREATE INDEX idx_task_events_task ON task_events(task_id, revision);
COMMIT;`);
  db.close();
}

describe('schema migration crash recovery (FR-I14)', () => {
  it(
    'rolls a crashed v1->v2 migration back to v1, then a clean reopen completes it',
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'crew-spawn-mig-'));
      made.push(cwd);
      initWorkspace(captureIo({ cwd }).io, { withGuides: false, json: false });
      const dbPath = join(cwd, '.crew', 'state', 'crew.db');

      // Build a current store, seed a row, then DOWNGRADE the file to released v1.
      const seed = new Store(dbPath, { clock: () => 0 });
      seed.joinAgent({ id: 'old', role: 'worker' });
      seed.close();
      downgradeTasksToV2(dbPath);
      const down = new DatabaseSync(dbPath);
      down.exec('DROP INDEX idx_agents_launch_token');
      down.exec('ALTER TABLE agents DROP COLUMN launch_token');
      down.exec('PRAGMA user_version = 1');
      down.close();

      // A real `crew agents` opens the Store -> runs the migration -> crashes pre-commit.
      const crashed = await execa(
        'node',
        [
          '--no-warnings',
          '--input-type=module',
          '--eval',
          migrationFaultScript,
          cwd,
          JSON.stringify(['agents', '--json']),
        ],
        { reject: false, cwd: root },
      );
      expect(crashed.exitCode).toBe(137);

      // Atomic rollback: still v1, no partial column, original row intact, healthy.
      const after = new DatabaseSync(dbPath);
      expect(
        (after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      ).toBe(1);
      expect(
        (after.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map((c) => c.name),
      ).not.toContain('launch_token');
      after.close();
      assertHealthy(dbPath);

      // A clean reopen completes the migration to CURRENT_SCHEMA_VERSION and
      // preserves the row.
      const reopened = new Store(dbPath, { clock: () => 0 });
      expect(reopened.getAgent('old')?.role).toBe('worker');
      reopened.close();
      const final = new DatabaseSync(dbPath);
      expect(
        (final.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      ).toBe(CURRENT_SCHEMA_VERSION);
      final.close();
    },
    STRESS_TIMEOUT,
  );

  it(
    'admits many concurrent openers of a v1 database (the losing migrators no-op, none error)',
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'crew-spawn-migrace-'));
      made.push(cwd);
      initWorkspace(captureIo({ cwd }).io, { withGuides: false, json: false });
      const dbPath = join(cwd, '.crew', 'state', 'crew.db');

      // A v1 fixture with one row, built by downgrading a current store.
      const seed = new Store(dbPath, { clock: () => 0 });
      seed.joinAgent({ id: 'old', role: 'worker' });
      seed.close();
      downgradeTasksToV2(dbPath);
      const down = new DatabaseSync(dbPath);
      down.exec('DROP INDEX idx_agents_launch_token');
      down.exec('ALTER TABLE agents DROP COLUMN launch_token');
      down.exec('PRAGMA user_version = 1');
      down.close();

      // Many `crew agents` processes open the v1 store at once behind a barrier;
      // exactly one wins the migration lock, the rest find it already done and
      // proceed — every opener must exit 0 (no spurious INTEGRITY/CONTENTION).
      const openers = Array.from({ length: 5 }, () => ['agents', '--json'] as const);
      const results = await race(cwd, 0, 0, openers);
      expect(results.map((r) => r.exitCode)).toEqual(openers.map(() => 0));

      // Migrated to CURRENT_SCHEMA_VERSION exactly once, the original row
      // preserved, integrity intact.
      const after = new DatabaseSync(dbPath);
      expect(
        (after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      ).toBe(CURRENT_SCHEMA_VERSION);
      expect(
        (after.prepare("SELECT count(*) AS n FROM agents WHERE id = 'old'").get() as { n: number })
          .n,
      ).toBe(1);
      after.close();
      assertHealthy(dbPath);
    },
    STRESS_TIMEOUT,
  );
});
