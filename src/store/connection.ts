/**
 * Stateless helpers for the State Store: contention-retry jitter, SQLITE_BUSY
 * classification, the blocking wait, the operation clock guard, unexpected-error
 * mapping, input validators, and the connection-settings readback. The
 * {@link Store} owns the connection and its private state; these pure helpers
 * are factored out so the class stays focused on the transaction/retry
 * machinery.
 */
import type { DatabaseSync } from 'node:sqlite';
import { CrewError } from '../errors.js';

/** The per-attempt busy timeout applied to the connection and each retry. */
export const BUSY_TIMEOUT_MS = 5_000;
const RETRY_MIN_MS = 25;
const RETRY_SPAN_MS = 76;

/**
 * The bounded contention-retry wait (25-100 ms) as a pure function of an
 * injected randomness source, so a seeded run replays identical waits.
 * Exported for unit testing; production draws `random` from {@link Io.random}.
 */
export function backoffMs(random: () => number): number {
  return RETRY_MIN_MS + Math.floor(random() * RETRY_SPAN_MS);
}

interface SqliteError extends Error {
  readonly errcode?: number;
}

/** True for SQLITE_BUSY (5) / SQLITE_LOCKED (6) — the retryable contention codes. */
export function isBusy(err: unknown): boolean {
  return (
    err instanceof Error &&
    ((err as SqliteError).errcode === 5 || (err as SqliteError).errcode === 6)
  );
}

/** Block the current thread for `milliseconds` (the Store is synchronous). */
export function sleep(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, milliseconds);
}

/** Read the single operation clock, asserting a safe epoch-second integer. */
export function operationTime(clock: () => number): number {
  const now = Math.floor(clock());
  if (!Number.isSafeInteger(now)) {
    throw new CrewError('INTEGRITY', 'operation clock did not return a safe epoch-second integer');
  }
  return now;
}

/** Rethrow a CrewError unchanged; wrap any other throwable as `INTEGRITY`. */
export function mapUnexpectedSqlite(err: unknown): never {
  if (err instanceof CrewError) throw err;
  const message = err instanceof Error ? err.message : String(err);
  throw new CrewError('INTEGRITY', `State Store operation failed: ${message}`);
}

/** Assert `limit` is an integer in `[1, maximum]`. */
export function assertLimit(limit: number, maximum: number, name = 'limit'): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new CrewError('USAGE', `${name} must be an integer between 1 and ${maximum}`);
  }
}

/** Assert message content is 1..100000 Unicode code points. */
export function assertMessageContent(content: string): void {
  const length = Array.from(content).length;
  if (length < 1 || length > 100_000) {
    throw new CrewError(
      'USAGE',
      'message content must be between 1 and 100000 Unicode code points',
    );
  }
}

/** Assert a string's Unicode-code-point length is within `[min, max]`. */
export function assertCodePointRange(value: string, min: number, max: number, name: string): void {
  const length = Array.from(value).length;
  if (length < min || length > max) {
    throw new CrewError('USAGE', `${name} must be between ${min} and ${max} Unicode code points`);
  }
}

/** Read-only evidence for hardened-open and doctor tests; never exposes SQL. */
export interface StoreConnectionSettings {
  readonly busyTimeout: number;
  readonly foreignKeys: boolean;
  readonly trustedSchema: boolean;
  readonly cellSizeCheck: boolean;
  readonly journalMode: string;
  readonly synchronous: number;
  readonly defensive: true;
  readonly extensionLoading: false;
}

/** Read the hardened connection pragmas as a structured, SQL-free record. */
export function readConnectionSettings(db: DatabaseSync): StoreConnectionSettings {
  const numberPragma = (name: string): number => {
    const row = db.prepare(`PRAGMA ${name}`).get();
    return Number(row === undefined ? 0 : Object.values(row)[0]);
  };
  const textPragma = (name: string): string => {
    const row = db.prepare(`PRAGMA ${name}`).get();
    return String(row === undefined ? '' : Object.values(row)[0]);
  };
  return {
    busyTimeout: numberPragma('busy_timeout'),
    foreignKeys: numberPragma('foreign_keys') === 1,
    trustedSchema: numberPragma('trusted_schema') === 1,
    cellSizeCheck: numberPragma('cell_size_check') === 1,
    journalMode: textPragma('journal_mode'),
    synchronous: numberPragma('synchronous'),
    defensive: true,
    extensionLoading: false,
  };
}
