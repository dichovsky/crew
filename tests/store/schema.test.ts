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

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertCurrentSchema,
  canonicalSql,
  CURRENT_SCHEMA_VERSION,
  INDEX_SQL,
  runMigrations,
  SCHEMA_SQL,
  TABLE_SQL,
  TRIGGER_SQL,
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

describe('schema v1', () => {
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
      ...Object.keys(TABLE_SQL)
        .sort()
        .map((name) => ({ type: 'table', name })),
      ...Object.keys(TRIGGER_SQL)
        .sort()
        .map((name) => ({ type: 'trigger', name })),
    ]);
    const strict = db
      .prepare("SELECT name, strict FROM pragma_table_list WHERE schema = 'main'")
      .all() as { name: string; strict: number }[];
    for (const name of Object.keys(TABLE_SQL)) {
      expect(strict.find((row) => row.name === name)?.strict).toBe(1);
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
    db.exec('PRAGMA user_version = 8');
    db.close();
    expect(codeOf(() => new StoreClass(path))).toBe('UNSUPPORTED_SCHEMA');
    const check = new DatabaseSync(path);
    expect(
      (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(8);
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
                return { value: 8, version: 8 };
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
