/**
 * `crew prune` and `crew clean` (FR-K02/K05/K06). Handlers stay thin: validate
 * input, call the Store / read-only maintenance helpers, render the single
 * result record. All SQL lives in `src/store/maintenance.ts`; file removal is
 * confined to the State Store files under `.crew/state/`.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parseDuration } from './duration.js';
import { CrewError } from './errors.js';
import { resolveManagedTarget } from './fs-safe.js';
import { writeJsonLine, writeLine } from './format.js';
import type { Io } from './io.js';
import { DEFAULT_MESSAGE_RETENTION_SECONDS, DEFAULT_TASK_RETENTION_SECONDS } from './retention.js';
import { openWorkspaceStore, type Store } from './store/index.js';
import { resolveWorkspaceRoot, STATE_DB_FILES, WORKSPACE_DIRNAME } from './workspace.js';

interface PruneOptions {
  readonly messagesBefore?: string;
  readonly tasksBefore?: string;
  readonly vacuum: boolean;
  readonly json: boolean;
}

interface CleanOptions {
  readonly force: boolean;
  readonly json: boolean;
}

interface PruneResult {
  readonly messagesDeleted: number;
  readonly tasksDeleted: number;
  readonly vacuumed: boolean;
}

function writePruneResult(io: Io, result: PruneResult, json: boolean): void {
  if (json) {
    writeJsonLine(io, {
      type: 'prune_result',
      schema_version: 1,
      messages_deleted: result.messagesDeleted,
      tasks_deleted: result.tasksDeleted,
      vacuumed: result.vacuumed,
    });
    return;
  }
  writeLine(
    io,
    `Pruned ${result.messagesDeleted} message(s) and ${result.tasksDeleted} task(s)` +
      `${result.vacuumed ? '; reclaimed free space' : ''}.`,
  );
}

/** `crew prune`: delete old read Messages / completed or abandoned Tasks, optionally vacuum. */
export function runPrune(io: Io, options: PruneOptions): void {
  const messagesBeforeSeconds =
    options.messagesBefore !== undefined
      ? parseDuration(options.messagesBefore)
      : DEFAULT_MESSAGE_RETENTION_SECONDS;
  const tasksBeforeSeconds =
    options.tasksBefore !== undefined
      ? parseDuration(options.tasksBefore)
      : DEFAULT_TASK_RETENTION_SECONDS;

  const root = resolveWorkspaceRoot(io.cwd);
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    const counts = store.pruneState({ messagesBeforeSeconds, tasksBeforeSeconds });
    if (!options.vacuum) {
      writePruneResult(io, { ...counts, vacuumed: false }, options.json);
      return;
    }
    // The prune has committed. Any failure of the post-commit guard or VACUUM must
    // still report the committed counts (contract: prune always emits one result).
    try {
      const active = store.countActiveAgents();
      if (active > 0) {
        throw new CrewError(
          'ACTIVE_AGENTS',
          `refusing to vacuum while ${active} active agent(s) exist; archive them first`,
        );
      }
      store.vacuum();
    } catch (err) {
      writePruneResult(io, { ...counts, vacuumed: false }, options.json);
      throw err;
    }
    writePruneResult(io, { ...counts, vacuumed: true }, options.json);
  } finally {
    store.close();
  }
}

function writeCleanResult(
  io: Io,
  removed: readonly string[],
  forced: boolean,
  json: boolean,
): void {
  if (json) {
    writeJsonLine(io, { type: 'clean_result', schema_version: 1, removed, forced });
    return;
  }
  writeLine(io, removed.length === 0 ? 'Nothing to remove.' : `Removed ${removed.join(', ')}.`);
}

/** Unlink the State Store files, ignoring those already absent; returns basenames removed. */
function unlinkStateFiles(root: string): string[] {
  const removed: string[] = [];
  for (const name of STATE_DB_FILES) {
    const target = resolveManagedTarget(root, join(WORKSPACE_DIRNAME, 'state', name));
    try {
      unlinkSync(target);
      removed.push(name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return removed;
}

function hasStateStoreFiles(root: string): boolean {
  return STATE_DB_FILES.some((name) =>
    existsSync(resolveManagedTarget(root, join(WORKSPACE_DIRNAME, 'state', name))),
  );
}

/** `crew clean`: remove State Store files, guarded by the active-Agent count. */
export function runClean(io: Io, options: CleanOptions): void {
  const root = resolveWorkspaceRoot(io.cwd);

  // --force never opens the database: the recovery path for a corrupt/locked store.
  if (options.force) {
    writeCleanResult(io, unlinkStateFiles(root), true, options.json);
    return;
  }

  if (!hasStateStoreFiles(root)) {
    writeCleanResult(io, [], false, options.json);
    return;
  }

  // Hold the write lock across the idle check AND the unlink so a concurrent join
  // cannot slip a row between them; a pre-opened contender that proceeds after the
  // files vanish fails its own identity check (STALE_STORE). This path is also used
  // for sidecar-only cleanup: if WAL/SHM exist with no main db, opening the Store
  // materializes the guarded database path before the same idle-checked unlink so a
  // racing creator cannot be deleted outside the normal safety invariant. See
  // Store.cleanWhileIdle.
  let store: Store;
  try {
    store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  } catch {
    throw new CrewError(
      'ACTIVE_AGENTS',
      'cannot open the State Store to verify it is idle; pass --force to remove it anyway',
    );
  }
  try {
    writeCleanResult(
      io,
      store.cleanWhileIdle(() => unlinkStateFiles(root)),
      false,
      options.json,
    );
  } finally {
    store.close();
  }
}
