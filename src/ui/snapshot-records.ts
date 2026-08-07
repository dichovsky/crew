/**
 * The wire shapes of the Console snapshot, shared by the Node server that
 * produces them (`./snapshot.js`) and the browser bundle that consumes them
 * (`web/types.ts`). This module exists purely so both sides can name one
 * declaration: it is a leaf whose only import is the `ParticipantId`
 * vocabulary, itself a zero-import leaf. Nothing here reaches `../store/`, so
 * nothing here drags `node:sqlite` into the DOM-only `web/` program, which
 * compiles with `types: []` and so cannot resolve Node builtins.
 *
 * Keep it that way — an import of `../store/index.js` added here would break
 * `web/tsconfig.json` and force the duplicate declarations back.
 *
 * The Store's own vocabularies (Task status, Task Event type, Message kind,
 * Agent status/activity) are spelled out as literal unions rather than
 * referenced as `TaskRecord['status']` and friends, because those aliases live
 * in modules that do import `node:sqlite`. They are not left to *widen*
 * silently: the builders in `./snapshot.js` assign Store records straight into
 * these fields, so widening a Store vocabulary without widening its mirror here
 * is a compile error there. Narrowing is not caught — retiring a member from a
 * Store vocabulary leaves a stale, unreachable member here and a dead branch in
 * `web/` until someone prunes it by hand.
 */
import type { ParticipantId } from '../participants.js';

/** Mirror of the CLI `inbox_state` NDJSON record. */
export interface InboxStateSnapshotRecord {
  readonly type: 'inbox_state';
  readonly schema_version: 1;
  readonly agent_id: string;
  readonly unread_count: number;
  readonly max_unread_id: number | null;
}

/** Mirror of the CLI `agent` NDJSON record, carrying its pending summary. */
export interface AgentSnapshotRecord {
  readonly type: 'agent';
  readonly schema_version: 1;
  readonly id: string;
  readonly role: string;
  /**
   * The producer asserts this narrow type (`src/store/agents.ts` casts the raw
   * column on read), and the Store rejects an unknown id at the single write
   * boundary — but the column itself is plain `TEXT` with only a length CHECK,
   * and the browser parses this record from JSON without validating it. So a
   * Workspace written by a different crew version can put a string here that is
   * not a `ParticipantId`, and no type will have caught it.
   *
   * Browser code must therefore not index a total `Record<ParticipantId, …>`
   * with this field directly, however well it typechecks. Go through
   * `engineMeta()` in `web/view-model.ts`, which re-guards with
   * `isParticipantId` and falls back to a neutral badge.
   */
  readonly platform_id: ParticipantId | null;
  readonly status: 'active' | 'archived';
  readonly activity: 'recent' | 'idle' | 'stale' | 'archived';
  readonly joined_at: number;
  readonly last_seen: number;
  readonly archived_at: number | null;
  readonly stale_lease_count: number;
  readonly pending_summary: InboxStateSnapshotRecord;
}

/** Mirror of the CLI `task_event` NDJSON record. */
export interface TaskEventSnapshotRecord {
  readonly type: 'task_event';
  readonly schema_version: 1;
  readonly id: number;
  readonly task_id: string;
  readonly revision: number;
  readonly event_type: 'created' | 'started' | 'submitted' | 'approved' | 'requeued' | 'abandoned';
  readonly actor_id: string;
  readonly from_status: 'queued' | 'in_progress' | 'submitted' | 'completed' | 'abandoned' | null;
  readonly to_status: 'queued' | 'in_progress' | 'submitted' | 'completed' | 'abandoned';
  readonly detail: string;
  readonly created_at: number;
}

/** Mirror of the CLI `task` NDJSON record, carrying its bounded Event timeline. */
export interface TaskSnapshotRecord {
  readonly type: 'task';
  readonly schema_version: 1;
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly creator_id: string;
  readonly assignee_id: string;
  readonly reviewer_id: string;
  readonly status: 'queued' | 'in_progress' | 'submitted' | 'completed' | 'abandoned';
  readonly revision: number;
  readonly lease_owner_id: string | null;
  readonly lease_expires_at: number | null;
  readonly submission_summary: string | null;
  readonly submitted_at: number | null;
  readonly review_summary: string | null;
  readonly completed_at: number | null;
  readonly abandoned_at: number | null;
  readonly worktree_path: string | null;
  readonly worktree_branch: string | null;
  readonly worktree_base_ref: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly stale_lease: boolean;
  /** The most recent Events (server-bounded), oldest-to-newest. */
  readonly events: readonly TaskEventSnapshotRecord[];
}

/** Mirror of the CLI `message` NDJSON record. */
export interface MessageSnapshotRecord {
  readonly type: 'message';
  readonly schema_version: 1;
  readonly id: number;
  readonly sender_id: string;
  readonly recipient_id: string;
  readonly content: string;
  readonly kind:
    'note' | 'task_assigned' | 'task_submitted' | 'task_approved' | 'task_requeued' | 'clear_safe';
  readonly task_id: string | null;
  readonly reply_to: number | null;
  readonly created_at: number;
  readonly read_at: number | null;
}

/** One JSON-ready observation of the Workspace for the Console dashboard. */
export interface WorkspaceSnapshot {
  readonly agents: readonly AgentSnapshotRecord[];
  readonly tasks: readonly TaskSnapshotRecord[];
  readonly messages: readonly MessageSnapshotRecord[];
}
