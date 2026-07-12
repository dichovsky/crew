/**
 * Internal review-Worktree SQL and row mapping. The public domain
 * operations live on Store. A `review_worktrees` row is a Reviewer's ONE
 * reusable, dedicated worktree: `current_ref` NULL means it currently sits on
 * `base_ref` (idle/"restored"); non-NULL means it is checked out to that
 * Task's branch for an in-progress review.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface ReviewWorktreeRecord {
  readonly agentId: string;
  readonly path: string;
  readonly baseRef: string;
  readonly currentRef: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface ReviewWorktreeRow {
  readonly agent_id: string;
  readonly path: string;
  readonly base_ref: string;
  readonly current_ref: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

function mapReviewWorktree(row: ReviewWorktreeRow): ReviewWorktreeRecord {
  return {
    agentId: row.agent_id,
    path: row.path,
    baseRef: row.base_ref,
    currentRef: row.current_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Read one Agent's dedicated review worktree row, or null if never created. */
export function selectReviewWorktree(
  db: DatabaseSync,
  agentId: string,
): ReviewWorktreeRecord | null {
  const row = db
    .prepare('SELECT * FROM review_worktrees WHERE agent_id = ?')
    .get(agentId) as unknown as ReviewWorktreeRow | undefined;
  return row === undefined ? null : mapReviewWorktree(row);
}

/**
 * Create an Agent's dedicated review worktree row on first use. Idempotent: a
 * concurrent creator racing on the same `agent_id` (its worktree already
 * resolved to the same deterministic path via `resolveWorktree`'s own
 * create-or-reuse semantics) loses the INSERT harmlessly via `ON CONFLICT ...
 * DO NOTHING`; either way the caller reads back whichever row won. The
 * re-read is asserted present (matches `agents.ts`'s `joinAgentTx` idiom): the
 * INSERT above, or a concurrent one racing on the same `agent_id`, just
 * committed inside this same write transaction, so a row is always there.
 */
export function insertReviewWorktree(
  db: DatabaseSync,
  input: { agentId: string; path: string; baseRef: string; now: number },
): ReviewWorktreeRecord {
  db.prepare(
    `INSERT INTO review_worktrees (agent_id, path, base_ref, current_ref, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?)
     ON CONFLICT(agent_id) DO NOTHING`,
  ).run(input.agentId, input.path, input.baseRef, input.now, input.now);
  return selectReviewWorktree(db, input.agentId)!;
}

/**
 * Point an Agent's review worktree at `currentRef` (the Task branch it now
 * holds), or `null` to mark it idle/restored to its resting `base_ref`. Gated
 * on `expectedCurrentRef` matching the row's live value (the same
 * optimistic-concurrency discipline every Task transition in this codebase
 * uses) so two overlapping calls for the same Agent — e.g. a `task review`
 * for one Task racing an approve/requeue-triggered restore for another —
 * cannot silently overwrite each other's effect; the caller decides how to
 * handle a lost race (`changes === 0`). Returns whether the write applied.
 */
export function updateReviewWorktreeCurrentRef(
  db: DatabaseSync,
  input: {
    agentId: string;
    currentRef: string | null;
    expectedCurrentRef: string | null;
    now: number;
  },
): boolean {
  const result = db
    .prepare(
      'UPDATE review_worktrees SET current_ref = ?, updated_at = ? ' +
        'WHERE agent_id = ? AND current_ref IS ?',
    )
    .run(input.currentRef, input.now, input.agentId, input.expectedCurrentRef);
  return result.changes === 1;
}
