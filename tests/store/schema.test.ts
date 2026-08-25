/* eslint-disable */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('node:sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:sqlite')>();
  class MockDatabaseSync extends actual.DatabaseSync {
    constructor(...args: any[]) {
      super(...(args as [any, any]));
      const originalPrepare = this.prepare;
      this.prepare = (sql: string) => {
        const stmt = originalPrepare.call(this, sql);
        const hook = (globalThis as any).mockPrepareHook;
        if (hook) {
          return hook(sql, stmt);
        }
        return stmt;
      };
    }
  }
  return {
    ...actual,
    DatabaseSync: MockDatabaseSync,
  };
});

import { constants, DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertCurrentSchema,
  canonicalSql,
  CURRENT_SCHEMA_VERSION,
  findSchemaDrift,
  FTS_SHADOW_TABLE_NAMES,
  INDEX_SQL,
  runMigrations,
  SCHEMA_SQL,
  TABLE_SQL,
  TRIGGER_SQL,
  VIRTUAL_TABLE_SQL,
} from '../../src/store/schema.js';

let StoreClass: any;

beforeAll(async () => {
  vi.resetModules();
  const storeModule = await import('../../src/store/index.js');
  StoreClass = storeModule.Store;
});

const made: string[] = [];

function databasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-schema-'));
  made.push(dir);
  return join(dir, 'crew.db');
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err: any) {
    if (err && typeof err === 'object' && 'code' in err) {
      return err.code;
    }
  }
  return undefined;
}

afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('current schema', () => {
  it('creates the exact tables/indexes, STRICT markers, and version', () => {
    const path = databasePath();
    const store = new StoreClass(path, { clock: () => 0 });
    expect(store.connectionSettings()).toEqual({
      busyTimeout: 5000,
      foreignKeys: true,
      trustedSchema: false,
      cellSizeCheck: true,
      journalMode: 'wal',
      synchronous: 1,
      defensive: true,
      extensionLoading: false,
    });
    store.close();

    const db = new DatabaseSync(path);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    const objects = db
      .prepare(
        "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all();
    expect(objects).toEqual([
      ...Object.keys(INDEX_SQL)
        .sort()
        .map((name) => ({ type: 'index', name })),
      ...[...Object.keys(TABLE_SQL), ...Object.keys(VIRTUAL_TABLE_SQL), ...FTS_SHADOW_TABLE_NAMES]
        .sort()
        .map((name) => ({ type: 'table', name })),
      ...Object.keys(TRIGGER_SQL)
        .sort()
        .map((name) => ({ type: 'trigger', name })),
    ]);
    const strict = db
      .prepare("SELECT name, type, strict FROM pragma_table_list WHERE schema = 'main'")
      .all() as { name: string; type: string; strict: number }[];
    for (const name of Object.keys(TABLE_SQL)) {
      expect(strict.find((row) => row.name === name)).toMatchObject({ type: 'table', strict: 1 });
    }
    for (const name of Object.keys(VIRTUAL_TABLE_SQL)) {
      expect(strict.find((row) => row.name === name)).toMatchObject({ type: 'virtual', strict: 0 });
    }
    for (const name of FTS_SHADOW_TABLE_NAMES) {
      expect(strict.find((row) => row.name === name)).toMatchObject({ type: 'shadow', strict: 0 });
    }
    expect(db.prepare('PRAGMA quick_check').all()).toEqual([{ quick_check: 'ok' }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe(
      'wal',
    );
    db.close();
  });

  it('reopens a current database without changing its schema', () => {
    const path = databasePath();
    new StoreClass(path).close();
    const before = readFileSync(path);
    new StoreClass(path).close();
    const db = new DatabaseSync(path);
    expect((db.prepare('SELECT count(*) AS n FROM agents').get() as { n: number }).n).toBe(0);
    db.close();
    expect(readFileSync(path).subarray(0, 100)).toEqual(before.subarray(0, 100));
  });

  it('initializes only an empty version-0 database', () => {
    const path = databasePath();
    new DatabaseSync(path).close();
    new StoreClass(path).close();
    const db = new DatabaseSync(path);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      CURRENT_SCHEMA_VERSION,
    );
    db.close();
  });

  it('refuses a non-empty version-0 database without changing its objects or version', () => {
    const path = databasePath();
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE legacy (value TEXT)');
    db.close();

    expect(codeOf(() => new StoreClass(path))).toBe('UNSUPPORTED_SCHEMA');
    const check = new DatabaseSync(path);
    expect(
      (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(0);
    expect(
      check
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'legacy'")
        .get(),
    ).toEqual({ name: 'legacy' });
    check.close();
  });

  it('refuses a newer schema without mutation', () => {
    const path = databasePath();
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
    db.close();
    expect(codeOf(() => new StoreClass(path))).toBe('UNSUPPORTED_SCHEMA');
    const check = new DatabaseSync(path);
    expect(
      (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(CURRENT_SCHEMA_VERSION + 1);
    expect(check.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual([]);
    check.close();
  });

  it('reports a database labeled v1 with a malformed schema as INTEGRITY', () => {
    const path = databasePath();
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE agents (id TEXT PRIMARY KEY) STRICT; PRAGMA user_version = 1');
    db.close();
    expect(codeOf(() => new StoreClass(path))).toBe('INTEGRITY');
  });

  it('preserves quoted literal case when validating the current schema', () => {
    const path = databasePath();
    const db = new DatabaseSync(path);
    db.exec(`${SCHEMA_SQL.replace("'active', 'archived'", "'ACTIVE', 'archived'")};
      PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
    db.close();
    expect(codeOf(() => new StoreClass(path))).toBe('INTEGRITY');
  });

  it('maps database-constructor failures to INTEGRITY', () => {
    const pathBelowMissingDirectory = join(databasePath(), 'crew.db');
    expect(codeOf(() => new StoreClass(pathBelowMissingDirectory))).toBe('INTEGRITY');
  });

  it('diagnoses missing indexes, unexpected objects, and foreign-key findings', () => {
    const missingIndex = databasePath();
    new StoreClass(missingIndex).close();
    const first = new DatabaseSync(missingIndex);
    first.exec('DROP INDEX idx_messages_unread');
    first.close();
    expect(codeOf(() => new StoreClass(missingIndex))).toBe('INTEGRITY');

    const extraObject = databasePath();
    new StoreClass(extraObject).close();
    const second = new DatabaseSync(extraObject);
    second.exec('CREATE VIEW unexpected AS SELECT id FROM agents');
    second.close();
    expect(codeOf(() => new StoreClass(extraObject))).toBe('INTEGRITY');

    const brokenForeignKey = databasePath();
    new StoreClass(brokenForeignKey).close();
    const third = new DatabaseSync(brokenForeignKey);
    third.exec('PRAGMA foreign_keys = OFF');
    third.exec("INSERT INTO agents VALUES ('sender', 'worker', NULL, 0, 0, 'active', NULL, NULL)");
    third.exec(
      "INSERT INTO messages (sender_id, recipient_id, content, created_at) VALUES ('sender', 'missing', 'note', 0)",
    );
    third.close();
    expect(codeOf(() => new StoreClass(brokenForeignKey))).toBe('INTEGRITY');
  });

  it('rolls back DDL and version when a future released-schema migration fails', () => {
    const path = databasePath();
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE released_v1 (value TEXT); PRAGMA user_version = 1');
    expect(() =>
      runMigrations(db, 1, 2, [
        {
          fromVersion: 1,
          toVersion: 2,
          validate: () => {},
          apply: (connection) => {
            connection.exec('CREATE TABLE partial_v2 (value TEXT)');
            throw new Error('injected migration failure');
          },
        },
      ]),
    ).toThrow('injected migration failure');
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      1,
    );
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'partial_v2'").get(),
    ).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'released_v1'").get()).toEqual({
      name: 'released_v1',
    });
    db.close();
  });

  it('runs an ordered future migration and rejects invalid or missing ranges', () => {
    const path = databasePath();
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE released_v1 (value TEXT); PRAGMA user_version = 1');
    runMigrations(db, 1, 2, [
      {
        fromVersion: 1,
        toVersion: 2,
        validate: (connection) => {
          expect(
            connection.prepare("SELECT name FROM sqlite_schema WHERE name = 'released_v1'").get(),
          ).toEqual({ name: 'released_v1' });
        },
        apply: (connection) => connection.exec('CREATE TABLE released_v2 (value TEXT)'),
      },
    ]);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      2,
    );
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'released_v2'").get()).toEqual({
      name: 'released_v2',
    });
    expect(codeOf(() => runMigrations(db, 0, 1, []))).toBe('UNSUPPORTED_SCHEMA');
    expect(codeOf(() => runMigrations(db, 2, 3, []))).toBe('UNSUPPORTED_SCHEMA');
    // The database is already at the target version: a second runner (the
    // concurrent-migration race — another opener finished first) is a safe no-op,
    // not an error, and leaves the version untouched.
    expect(() => runMigrations(db, 1, 2, [])).not.toThrow();
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      2,
    );
    db.close();
  });

  it('assertCurrentSchema fails if version is incorrect', () => {
    const path = databasePath();
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 3');
    expect(codeOf(() => assertCurrentSchema(db))).toBe('INTEGRITY');
    db.close();
  });

  it('assertCurrentSchema fails if table is not STRICT', () => {
    const path = databasePath();
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE agents (id TEXT PRIMARY KEY); PRAGMA user_version = 1');
    expect(codeOf(() => assertCurrentSchema(db))).toBe('INTEGRITY');
    db.close();
  });

  it('assertDatabaseChecks fails if quick_check or foreign_key fails', () => {
    const path = databasePath();
    // Initialize standard schema first
    const store = new StoreClass(path);
    store.close();

    const db = new DatabaseSync(path);
    // Disable foreign keys temporarily to insert a row violating foreign key constraints
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      `INSERT INTO tasks (id, creator_id, assignee_id, reviewer_id, title, status, created_at, updated_at) 
       VALUES ('task-1', 'non-existent', 'non-existent', 'non-existent', 'title', 'queued', 0, 0)`,
    ).run();
    db.exec('PRAGMA foreign_keys = ON');

    // assertCurrentSchema (which calls assertDatabaseChecks) should now fail with INTEGRITY
    expect(codeOf(() => assertCurrentSchema(db))).toBe('INTEGRITY');
    db.close();
  });

  it('canonicalSql parses sql with escaped quotes correctly', () => {
    expect(canonicalSql("SELECT 'o''brien'")).toBe("select 'o''brien'");
    expect(canonicalSql('SELECT [abc]')).toBe('select [abc]');
  });

  it('canonicalSql drops a trailing semicolon but keeps an interior one', () => {
    expect(canonicalSql('CREATE TABLE t (a TEXT);')).toBe(canonicalSql('create table t (a text)'));
    // A ';' that is NOT the statement terminator stays part of the canonical form.
    expect(canonicalSql("SELECT ';x' ; SELECT 2")).toBe("select ';x' ; select 2");
  });

  it('covers concurrent initialization race conditions (newer version & non-empty)', () => {
    const path = databasePath();
    let interceptMode: 'newer' | 'non-empty' | null = null;
    let pragmaCallCount = 0;

    (globalThis as any).mockPrepareHook = (sql: string, stmt: any) => {
      const boundGet = stmt.get.bind(stmt);
      if (sql.toLowerCase().includes('user_version')) {
        Object.defineProperty(stmt, 'get', {
          value: function (...args: any[]) {
            if (interceptMode === 'newer') {
              pragmaCallCount++;
              if (pragmaCallCount >= 1) {
                return {
                  value: CURRENT_SCHEMA_VERSION + 1,
                  version: CURRENT_SCHEMA_VERSION + 1,
                };
              }
            }
            return boundGet(...args);
          },
          configurable: true,
          writable: true,
        });
      } else if (sql.toLowerCase().includes('sqlite_schema') && sql.includes('count(*)')) {
        Object.defineProperty(stmt, 'get', {
          value: function (...args: any[]) {
            if (interceptMode === 'non-empty') {
              return { value: 1 };
            }
            return boundGet(...args);
          },
          configurable: true,
          writable: true,
        });
      }
      return stmt;
    };

    try {
      interceptMode = 'newer';
      pragmaCallCount = 0;
      expect(codeOf(() => new StoreClass(path))).toBe('UNSUPPORTED_SCHEMA');
    } finally {
      (globalThis as any).mockPrepareHook = null;
    }

    // Reset database to empty version 0
    rmSync(path, { force: true });

    try {
      interceptMode = 'non-empty';
      (globalThis as any).mockPrepareHook = (sql: string, stmt: any) => {
        const boundGet = stmt.get.bind(stmt);
        if (sql.toLowerCase().includes('sqlite_schema') && sql.includes('count(*)')) {
          Object.defineProperty(stmt, 'get', {
            value: function (...args: any[]) {
              if (interceptMode === 'non-empty') {
                return { value: 1 };
              }
              return boundGet(...args);
            },
            configurable: true,
            writable: true,
          });
        }
        return stmt;
      };
      expect(codeOf(() => new StoreClass(path))).toBe('UNSUPPORTED_SCHEMA');
    } finally {
      (globalThis as any).mockPrepareHook = null;
    }
  });
});

type SearchIndex = keyof typeof VIRTUAL_TABLE_SQL;

function matchRowids(db: DatabaseSync, index: SearchIndex, query: string): number[] {
  return (
    db.prepare(`SELECT rowid FROM ${index} WHERE ${index} MATCH ? ORDER BY rowid`).all(query) as {
      rowid: number;
    }[]
  ).map((row) => row.rowid);
}

function seedSearchFixture(db: DatabaseSync): { messageId: number; eventId: number } {
  db.exec(`
    INSERT INTO agents (id, role, joined_at, last_seen, status)
      VALUES ('manager', 'manager', 0, 0, 'active'),
             ('worker', 'worker', 0, 0, 'active'),
             ('inspector', 'inspector', 0, 0, 'active');
    INSERT INTO tasks
      (id, title, creator_id, assignee_id, reviewer_id, status, created_at, updated_at)
      VALUES ('search-task', 'Search fixture', 'manager', 'worker', 'inspector', 'queued', 0, 0);
  `);
  const message = db
    .prepare(
      `INSERT INTO messages (sender_id, recipient_id, content, task_id, created_at)
       VALUES ('manager', 'worker', 'messagealpha', 'search-task', 0)`,
    )
    .run();
  const event = db
    .prepare(
      `INSERT INTO task_events
         (task_id, revision, event_type, actor_id, from_status, to_status, detail, created_at)
       VALUES ('search-task', 0, 'created', 'manager', NULL, 'queued', 'eventalpha', 0)`,
    )
    .run();
  return { messageId: Number(message.lastInsertRowid), eventId: Number(event.lastInsertRowid) };
}

/** Turn a current fixture into the exact pre-FTS schema without touching shadows directly. */
function downgradeCurrentToV7(db: DatabaseSync): void {
  const ftsTriggers = Object.keys(TRIGGER_SQL).filter((name) => name.includes('_fts_'));
  db.exec('BEGIN EXCLUSIVE');
  try {
    for (const name of ftsTriggers) db.exec(`DROP TRIGGER ${name}`);
    for (const name of Object.keys(VIRTUAL_TABLE_SQL)) db.exec(`DROP TABLE ${name}`);
    db.exec('PRAGMA user_version = 7');
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

describe('schema v8 FTS5 indexes', () => {
  it('migrates v7 transactionally and backfills both existing corpora', () => {
    const path = databasePath();
    new StoreClass(path).close();
    const before = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    seedSearchFixture(before);
    downgradeCurrentToV7(before);
    expect(
      before.prepare("SELECT name FROM sqlite_schema WHERE name = 'messages_fts'").get(),
    ).toBeUndefined();
    before.close();

    new StoreClass(path).close();
    const migrated = new DatabaseSync(path);
    expect(
      (migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(CURRENT_SCHEMA_VERSION);
    expect(matchRowids(migrated, 'messages_fts', 'messagealpha')).toEqual([1]);
    expect(matchRowids(migrated, 'task_events_fts', 'eventalpha')).toEqual([1]);
    migrated.close();
  });

  it('rolls virtual tables, shadows, triggers, backfill, and stamp back together', () => {
    const path = databasePath();
    new StoreClass(path).close();
    const before = new DatabaseSync(path);
    seedSearchFixture(before);
    downgradeCurrentToV7(before);
    before.close();

    expect(
      () =>
        new StoreClass(path, {
          onTransactionStep: (label: string) => {
            if (label === 'migrate:before-commit') throw new Error('interrupted');
          },
        }),
    ).toThrow('interrupted');

    const rolledBack = new DatabaseSync(path);
    expect(
      (rolledBack.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(7);
    expect(
      rolledBack.prepare("SELECT name FROM sqlite_schema WHERE name = 'messages_fts'").get(),
    ).toBeUndefined();
    rolledBack.close();

    new StoreClass(path).close();
    const recovered = new DatabaseSync(path);
    expect(matchRowids(recovered, 'messages_fts', 'messagealpha')).toEqual([1]);
    expect(matchRowids(recovered, 'task_events_fts', 'eventalpha')).toEqual([1]);
    recovered.close();
  });

  it.each(['messages_fts', 'task_events_fts_config'])(
    'refuses a v7 collision at reserved name %s without changing the database',
    (name) => {
      const path = databasePath();
      new StoreClass(path).close();
      const db = new DatabaseSync(path);
      downgradeCurrentToV7(db);
      db.exec(`CREATE TABLE ${name} (value TEXT) STRICT`);
      db.close();

      expect(codeOf(() => new StoreClass(path))).toBe('INTEGRITY');
      const unchanged = new DatabaseSync(path);
      expect(
        (unchanged.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      ).toBe(7);
      expect(unchanged.prepare('SELECT name FROM sqlite_schema WHERE name = ?').get(name)).toEqual({
        name,
      });
      unchanged.close();
    },
  );

  it('synchronizes insert, indexed-text update, rowid update, and delete for both indexes', () => {
    const path = databasePath();
    new StoreClass(path).close();
    const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    const { messageId, eventId } = seedSearchFixture(db);

    expect(matchRowids(db, 'messages_fts', 'messagealpha')).toEqual([messageId]);
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('messagebeta', messageId);
    expect(matchRowids(db, 'messages_fts', 'messagealpha')).toEqual([]);
    expect(matchRowids(db, 'messages_fts', 'messagebeta')).toEqual([messageId]);
    db.prepare('UPDATE messages SET id = ? WHERE id = ?').run(101, messageId);
    expect(matchRowids(db, 'messages_fts', 'messagebeta')).toEqual([101]);
    db.prepare('DELETE FROM messages WHERE id = ?').run(101);
    expect(matchRowids(db, 'messages_fts', 'messagebeta')).toEqual([]);

    expect(matchRowids(db, 'task_events_fts', 'eventalpha')).toEqual([eventId]);
    db.prepare('UPDATE task_events SET detail = ? WHERE id = ?').run('eventbeta', eventId);
    expect(matchRowids(db, 'task_events_fts', 'eventalpha')).toEqual([]);
    expect(matchRowids(db, 'task_events_fts', 'eventbeta')).toEqual([eventId]);
    db.prepare('UPDATE task_events SET id = ? WHERE id = ?').run(202, eventId);
    expect(matchRowids(db, 'task_events_fts', 'eventbeta')).toEqual([202]);
    db.prepare('DELETE FROM task_events WHERE id = ?').run(202);
    expect(matchRowids(db, 'task_events_fts', 'eventbeta')).toEqual([]);
    db.close();
  });

  it('does not invoke either FTS update trigger for unrelated-column updates', () => {
    const path = databasePath();
    new StoreClass(path).close();
    const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    const { messageId, eventId } = seedSearchFixture(db);

    db.setAuthorizer((_action, _arg1, _arg2, _database, trigger) =>
      trigger === 'trg_messages_fts_update' || trigger === 'trg_task_events_fts_update'
        ? constants.SQLITE_DENY
        : constants.SQLITE_OK,
    );
    expect(() =>
      db.prepare('UPDATE messages SET read_at = 1 WHERE id = ?').run(messageId),
    ).not.toThrow();
    expect(() =>
      db.prepare('UPDATE task_events SET created_at = 1 WHERE id = ?').run(eventId),
    ).not.toThrow();
    db.setAuthorizer(null);

    expect(matchRowids(db, 'messages_fts', 'messagealpha')).toEqual([messageId]);
    expect(matchRowids(db, 'task_events_fts', 'eventalpha')).toEqual([eventId]);
    db.close();
  });

  it('removes both index entries when deleting a Task cascades to its content', () => {
    const path = databasePath();
    new StoreClass(path).close();
    const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    seedSearchFixture(db);
    expect(matchRowids(db, 'messages_fts', 'messagealpha')).toEqual([1]);
    expect(matchRowids(db, 'task_events_fts', 'eventalpha')).toEqual([1]);

    db.prepare("DELETE FROM tasks WHERE id = 'search-task'").run();
    expect(matchRowids(db, 'messages_fts', 'messagealpha')).toEqual([]);
    expect(matchRowids(db, 'task_events_fts', 'eventalpha')).toEqual([]);
    db.close();
  });

  it('pins virtual SQL and rejects extra, missing, and wrong-type shadow objects', () => {
    const alteredPath = databasePath();
    const altered = new DatabaseSync(alteredPath);
    altered.exec(
      `${SCHEMA_SQL.replace(
        "tokenize = 'unicode61 remove_diacritics 2'",
        "tokenize = 'porter'",
      )}; PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`,
    );
    expect(findSchemaDrift(altered)).toContain('virtual table "messages_fts" does not match');
    altered.close();

    const extraPath = databasePath();
    new StoreClass(extraPath).close();
    const extra = new DatabaseSync(extraPath);
    extra.exec('CREATE TABLE unexpected_fts_data (value TEXT) STRICT');
    expect(findSchemaDrift(extra)).toContain('unexpected schema objects');
    extra.close();

    const missingPath = databasePath();
    new StoreClass(missingPath).close();
    const missing = new DatabaseSync(missingPath);
    (globalThis as any).mockPrepareHook = (sql: string, stmt: any) => {
      if (!sql.includes('sqlite_schema') || !sql.includes('ORDER BY type, name')) return stmt;
      const originalAll = stmt.all.bind(stmt);
      Object.defineProperty(stmt, 'all', {
        value: (...args: any[]) =>
          originalAll(...args).filter((row: any) => row.name !== 'messages_fts_config'),
      });
      return stmt;
    };
    try {
      expect(findSchemaDrift(missing)).toContain('shadow table "messages_fts_config" is missing');
    } finally {
      (globalThis as any).mockPrepareHook = null;
      missing.close();
    }

    const wrongTypePath = databasePath();
    new StoreClass(wrongTypePath).close();
    const wrongType = new DatabaseSync(wrongTypePath);
    (globalThis as any).mockPrepareHook = (sql: string, stmt: any) => {
      if (!sql.includes('pragma_table_list')) return stmt;
      const originalAll = stmt.all.bind(stmt);
      Object.defineProperty(stmt, 'all', {
        value: (...args: any[]) =>
          originalAll(...args).map((row: any) =>
            row.name === 'messages_fts_data' ? { ...row, type: 'table' } : row,
          ),
      });
      return stmt;
    };
    try {
      expect(findSchemaDrift(wrongType)).toContain(
        'shadow table "messages_fts_data" has unexpected table-list type "table"',
      );
    } finally {
      (globalThis as any).mockPrepareHook = null;
      wrongType.close();
    }
  });
});

describe('data-model.md normative stamp', () => {
  it('the normative DDL block stamps user_version equal to CURRENT_SCHEMA_VERSION', () => {
    // Root cause guarded here: an N -> N+1 schema bump once revised the doc's header and
    // DDL but left the trailing PRAGMA stamp behind. This gate makes the
    // contract document's sole stamp track the implementation forever.
    const doc = readFileSync(
      fileURLToPath(new URL('../../docs/design/data-model.md', import.meta.url)),
      'utf8',
    );
    const stamps = [...doc.matchAll(/PRAGMA user_version = (\d+);/g)].map((m) => Number(m[1]));
    expect(stamps).toEqual([CURRENT_SCHEMA_VERSION]);
    expect(doc).toContain(`## Schema version ${CURRENT_SCHEMA_VERSION} (current)`);
  });
});

describe('schema constraints', () => {
  it('rejects impossible Agent state and foreign-key fixtures', () => {
    const path = databasePath();
    new StoreClass(path).close();
    const db = new DatabaseSync(path);
    db.exec('PRAGMA foreign_keys = ON');
    expect(() =>
      db
        .prepare("INSERT INTO agents VALUES ('bad', 'worker', NULL, 10, 9, 'active', NULL, NULL)")
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO agents VALUES ('bad', 'worker', NULL, 10, 10, 'archived', NULL, NULL)",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO messages (sender_id, recipient_id, content, created_at) VALUES ('x', 'y', 'z', 0)",
        )
        .run(),
    ).toThrow();
    db.close();
  });
});
