/**
 * Read-only monotonic poll cursors for the Console server's change detection
 * (ADR-0012, FR-U22). One SELECT computes simple MAX(...) reads over the
 * observable tables, so the cursors come from a single statement snapshot; the
 * query consumes nothing and stamps no Agent activity.
 *
 * `maxAgentArchivedAt` observes the leave/archive transition: `leaveAgent`
 * stamps `archived_at` but deliberately preserves `last_seen`, so without this
 * cursor an Agent leaving (via `crew leave` or `crew team stop`) would change
 * the snapshot's roster status without moving the signature, and the SSE poller
 * would never push the change.
 *
 * `staleLeaseCount` is the one time-dependent cursor: a Lease crosses
 * its expiry passively — no row is written when the clock ticks past
 * `lease_expires_at` — so without counting currently-stale Leases against the
 * caller-supplied `now`, that transition would never move the signature and
 * the SSE poller would never notice it. `now` always comes from the injected
 * clock seam (never a live SQL time function), matching every other
 * "now"-dependent Store read.
 *
 * `agentMutationCursor` closes the remaining agent-row blind spots:
 * the MAX/COUNT aggregates above cannot observe a launch-teardown reap that
 * DELETEs a non-maximal row, or a same-clock-second `last_seen` re-stamp
 * (join/receive at `now == MAX(last_seen)`). Schema-v5 triggers bump the
 * single-row `agent_mutations` counter on every `agents` INSERT, UPDATE, and
 * DELETE, so any agent-row transition moves the signature.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface ChangeSignature {
  readonly maxMessageId: number;
  readonly maxTaskEventId: number;
  readonly maxTaskUpdatedAt: number;
  readonly maxAgentLastSeen: number;
  readonly maxAgentArchivedAt: number;
  readonly staleLeaseCount: number;
  readonly agentMutationCursor: number;
  readonly observableMutationCursor: number;
}

interface ChangeSignatureRow {
  readonly maxMessageId: number | null;
  readonly maxTaskEventId: number | null;
  readonly maxTaskUpdatedAt: number | null;
  readonly maxAgentLastSeen: number | null;
  readonly maxAgentArchivedAt: number | null;
  readonly staleLeaseCount: number | null;
  readonly agentMutationCursor: number | null;
  readonly observableMutationCursor: number | null;
}

/** Read the current change-signature cursors; empty tables read as 0. */
export function selectChangeSignature(db: DatabaseSync, now: number): ChangeSignature {
  const row = db
    .prepare(
      `SELECT
         (SELECT MAX(id) FROM messages) AS maxMessageId,
         (SELECT MAX(id) FROM task_events) AS maxTaskEventId,
         (SELECT MAX(updated_at) FROM tasks) AS maxTaskUpdatedAt,
         (SELECT MAX(last_seen) FROM agents) AS maxAgentLastSeen,
         (SELECT MAX(archived_at) FROM agents) AS maxAgentArchivedAt,
         (SELECT COUNT(*) FROM tasks
            WHERE status = 'in_progress' AND lease_expires_at IS NOT NULL
              AND lease_expires_at <= ?) AS staleLeaseCount,
         (SELECT cursor FROM agent_mutations WHERE id = 1) AS agentMutationCursor,
         (SELECT cursor FROM observable_mutations WHERE id = 1) AS observableMutationCursor`,
    )
    .get(now) as unknown as ChangeSignatureRow;
  return {
    maxMessageId: Number(row.maxMessageId ?? 0),
    maxTaskEventId: Number(row.maxTaskEventId ?? 0),
    maxTaskUpdatedAt: Number(row.maxTaskUpdatedAt ?? 0),
    maxAgentLastSeen: Number(row.maxAgentLastSeen ?? 0),
    maxAgentArchivedAt: Number(row.maxAgentArchivedAt ?? 0),
    staleLeaseCount: Number(row.staleLeaseCount ?? 0),
    agentMutationCursor: Number(row.agentMutationCursor ?? 0),
    observableMutationCursor: Number(row.observableMutationCursor ?? 0),
  };
}
