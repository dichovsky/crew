/**
 * Agent persistence: row mapping, existence/active guards, and the id-allocation
 * / archive / resume / scoped-reap operations. The transaction-bodied functions
 * (`…Tx`) assume the caller (the {@link Store}) has already opened the
 * `BEGIN IMMEDIATE` transaction and validated their inputs; they run the SQL and
 * return domain records. Guards and reads are also used by the Messaging and
 * Task operations to reject a typo'd or archived Agent before a write.
 */
import type { DatabaseSync } from 'node:sqlite';
import { CrewError } from '../errors.js';
import type { ParticipantId } from '../participants.js';

export type AgentStatus = 'active' | 'archived';
export type AgentActivity = 'recent' | 'idle' | 'stale' | 'archived';

export interface AgentRecord {
  readonly id: string;
  readonly role: string;
  readonly platformId: ParticipantId | null;
  readonly status: AgentStatus;
  readonly activity: AgentActivity;
  readonly joinedAt: number;
  readonly lastSeen: number;
  readonly archivedAt: number | null;
  readonly staleLeaseCount: number;
}

export interface JoinAgentInput {
  readonly id: string;
  readonly role?: string;
  /** Omission is significant for resume: preserve the stored platform. */
  readonly platformId?: ParticipantId;
  readonly resume?: boolean;
  /**
   * Provenance stamp for a live-launch teardown reap. Set only on the
   * create-new path from the launcher's `CREW_LAUNCH_TOKEN`; never on resume.
   * Never rendered — it is read back only by {@link Store.reapByLaunchToken}.
   */
  readonly launchToken?: string;
}

interface AgentRow {
  readonly id: string;
  readonly role: string;
  readonly platform_id: string | null;
  readonly status: AgentStatus;
  readonly joined_at: number;
  readonly last_seen: number;
  readonly archived_at: number | null;
  readonly stale_lease_count: number;
}

interface AgentStateRow {
  readonly status: AgentStatus;
}

// A single row read that also counts the Agent's expired in-progress Leases, so
// callers see stale-lease pressure without a second query.
const ROW_SELECT = `SELECT a.*,
    (SELECT count(*) FROM tasks t
     WHERE t.lease_owner_id = a.id
       AND t.status = 'in_progress'
       AND t.lease_expires_at <= ?) AS stale_lease_count
   FROM agents a`;

function activityFor(status: AgentStatus, lastSeen: number, now: number): AgentActivity {
  if (status === 'archived') return 'archived';
  const age = now - lastSeen;
  if (age < 5 * 60) return 'recent';
  if (age < 30 * 60) return 'idle';
  return 'stale';
}

function mapRow(row: AgentRow, now: number): AgentRecord {
  return {
    id: row.id,
    role: row.role,
    platformId: row.platform_id as ParticipantId | null,
    status: row.status,
    activity: activityFor(row.status, row.last_seen, now),
    joinedAt: row.joined_at,
    lastSeen: row.last_seen,
    archivedAt: row.archived_at,
    staleLeaseCount: row.stale_lease_count,
  };
}

function rowFor(db: DatabaseSync, id: string, now: number): AgentRow | null {
  const row = db.prepare(`${ROW_SELECT} WHERE a.id = ?`).get(now, id) as unknown as
    AgentRow | undefined;
  return row ?? null;
}

/** Read one exact Agent record without changing activity metadata, or null. */
export function getAgentRecord(db: DatabaseSync, id: string, now: number): AgentRecord | null {
  const row = rowFor(db, id, now);
  return row === null ? null : mapRow(row, now);
}

/** Assert an Agent exists (archived permitted), returning its status row. */
export function assertAgentExists(db: DatabaseSync, id: string): AgentStateRow {
  const row = db.prepare('SELECT status FROM agents WHERE id = ?').get(id) as unknown as
    AgentStateRow | undefined;
  if (row === undefined) throw new CrewError('NOT_FOUND', `no agent named "${id}"`);
  return row;
}

/** Assert an Agent exists and is not archived. */
export function assertActiveAgent(db: DatabaseSync, id: string): void {
  const agent = assertAgentExists(db, id);
  if (agent.status === 'archived') {
    throw new CrewError('AGENT_INACTIVE', `agent "${id}" is archived`);
  }
}

/**
 * Allocate a new id (base then `-2`…`-99`) or reactivate one exact archived id.
 * Runs inside the caller's `IMMEDIATE` transaction; `input` is pre-validated.
 */
export function joinAgentTx(db: DatabaseSync, input: JoinAgentInput, now: number): AgentRecord {
  if (input.resume === true) {
    const existing = rowFor(db, input.id, now);
    if (existing === null) {
      throw new CrewError('NOT_FOUND', `no agent named "${input.id}" to resume`);
    }
    if (existing.status === 'active') {
      throw new CrewError('ALREADY_EXISTS', `agent "${input.id}" is already active`);
    }
    if (input.role !== undefined && input.role !== existing.role) {
      throw new CrewError(
        'ALREADY_EXISTS',
        `agent "${input.id}" has stored role "${existing.role}", not "${input.role}"`,
      );
    }
    if (input.platformId === undefined) {
      db.prepare(
        "UPDATE agents SET status = 'active', archived_at = NULL, last_seen = ? WHERE id = ?",
      ).run(now, input.id);
    } else {
      db.prepare(
        "UPDATE agents SET status = 'active', archived_at = NULL, last_seen = ?, platform_id = ? WHERE id = ?",
      ).run(now, input.platformId, input.id);
    }
    return mapRow(rowFor(db, input.id, now)!, now);
  }

  const role = input.role ?? input.id;
  const insert = db.prepare(
    `INSERT INTO agents
       (id, role, platform_id, joined_at, last_seen, status, archived_at, launch_token)
     VALUES (?, ?, ?, ?, ?, 'active', NULL, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  const launchToken = input.launchToken ?? null;
  let attempted = 0;
  for (let suffix = 1; suffix <= 99; suffix++) {
    const candidate = suffix === 1 ? input.id : `${input.id}-${suffix}`;
    if (candidate.length > 64) continue;
    attempted++;
    const result = insert.run(candidate, role, input.platformId ?? null, now, now, launchToken);
    if (result.changes === 1) return mapRow(rowFor(db, candidate, now)!, now);
  }
  // When only the base id could be attempted (every numbered suffix overflows
  // the 64-char id limit), say so rather than implying `-2`…`-99` were tried.
  throw new CrewError(
    'ALREADY_EXISTS',
    attempted <= 1
      ? `agent id "${input.id}" is reserved and no numbered suffix fits the 64-character limit`
      : `all ids for "${input.id}" through "${input.id}-99" are reserved`,
  );
}

/** Archive one active Agent while preserving its last_seen timestamp. */
export function leaveAgentTx(db: DatabaseSync, id: string, now: number): AgentRecord {
  const existing = rowFor(db, id, now);
  if (existing === null) throw new CrewError('NOT_FOUND', `no agent named "${id}"`);
  if (existing.status === 'archived') {
    throw new CrewError('AGENT_INACTIVE', `agent "${id}" is already archived`);
  }
  db.prepare("UPDATE agents SET status = 'archived', archived_at = ? WHERE id = ?").run(now, id);
  return mapRow(rowFor(db, id, now)!, now);
}

/**
 * Remove every untouched Agent stamped with this launch's token (the
 * launch-teardown scoped reap). "Untouched" means the row has no
 * footprint: no Task reference (creator/assignee/reviewer/lease owner), no
 * attributed Task Event, and no Message sent or received — so it has no
 * referential history and `DELETE` leaves no orphan. The row is DELETED rather
 * than archived because an archived row still reserves its id and would block
 * the launch preflight (`preexistingAgentIds` counts archived rows); removing
 * the pristine join row frees the id so the same team is immediately
 * relaunchable. Touched rows, and rows carrying a different token or none, are
 * left intact for doctor/retry. Returns the number of rows removed. Runs inside
 * the caller's `IMMEDIATE` transaction.
 */
export function reapByLaunchTokenTx(db: DatabaseSync, launchToken: string): number {
  const result = db
    .prepare(
      `DELETE FROM agents
        WHERE launch_token = ?
          AND status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM task_events te WHERE te.actor_id = agents.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM tasks t
             WHERE t.creator_id = agents.id OR t.assignee_id = agents.id
                OR t.reviewer_id = agents.id OR t.lease_owner_id = agents.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM messages m
             WHERE m.sender_id = agents.id OR m.recipient_id = agents.id
          )`,
    )
    .run(launchToken);
  return Number(result.changes);
}

/** List Agent records in id order, active-only unless includeArchived is true. */
export function listAgentRecords(
  db: DatabaseSync,
  includeArchived: boolean,
  now: number,
): AgentRecord[] {
  const where = includeArchived ? '' : "WHERE a.status = 'active'";
  const rows = db.prepare(`${ROW_SELECT} ${where} ORDER BY a.id`).all(now) as unknown as AgentRow[];
  return rows.map((row) => mapRow(row, now));
}
