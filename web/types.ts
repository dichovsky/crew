/**
 * Local type definitions for the Console API.
 * TODO: unify with src/ui/snapshot when module resolution allows.
 */

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
  readonly platform_id: string | null;
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

/** Mirror of the `session` record from GET /api/sessions (Operations view). */
export interface SessionSnapshotRecord {
  readonly type: 'session';
  readonly schema_version: 1;
  readonly session_name: string;
  readonly pane_count: number;
  readonly agent_count: number;
  /** Launch time in epoch seconds. */
  readonly started_at: number;
}

/** Mirror of the resumable-session record from GET /api/resumable-sessions. */
export interface ResumableSessionSnapshotRecord {
  readonly type: 'resumable_session';
  readonly schema_version: 1;
  readonly session_name: string;
  readonly team: string;
  readonly stopped_at: number;
  readonly agents_archived: number;
}
