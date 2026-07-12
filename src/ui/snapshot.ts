/**
 * Read-only Console snapshot builder (ADR-0012). Builds one JSON-ready view of
 * the Workspace — the full Agent roster with per-Agent content-free pending
 * summaries, every Task with its bounded Event timeline, and a bounded newest
 * window of Message history — over existing Store domain reads only (FR-U11). It never consumes Inbox rows
 * (FR-U12): the {@link SnapshotStore} parameter type admits exactly the four
 * reads the builder needs, so a consuming call such as `receiveMessages` is a
 * compile error here, not a code-review catch.
 *
 * The emitted records reuse the `--json` CLI NDJSON shapes (`agent`, `task`,
 * `message`, `inbox_state`, all `schema_version: 1`) so the future dashboard
 * and the CLI agree on one vocabulary; parity is pinned by unit test against
 * the live CLI output.
 */
import type {
  AgentRecord,
  InboxState,
  MessageRecord,
  TaskEventRecord,
  TaskRecord,
} from '../store/index.js';

/** Newest-window Message history bound applied when the caller gives none. */
export const DEFAULT_HISTORY_LIMIT = 100;
/** Most recent Task Events carried per Task (revision order preserved). */
export const TASK_EVENT_LIMIT = 50;

/**
 * The exact Store read surface the builder may touch. The full Store satisfies
 * this structurally; narrowing the parameter is the FR-U11/FR-U12 boundary.
 */
export interface SnapshotStore {
  listAgents(options: { includeArchived?: boolean }): AgentRecord[];
  getPendingSummary(agentId: string): InboxState;
  listTasks(): TaskRecord[];
  getTaskWithEvents(id: string): { task: TaskRecord | null; events: TaskEventRecord[] };
  listMessageHistory(input: { limit: number }): MessageRecord[];
}

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
  readonly platform_id: AgentRecord['platformId'];
  readonly status: AgentRecord['status'];
  readonly activity: AgentRecord['activity'];
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
  readonly event_type: TaskEventRecord['eventType'];
  readonly actor_id: string;
  readonly from_status: TaskEventRecord['fromStatus'];
  readonly to_status: TaskEventRecord['toStatus'];
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
  readonly status: TaskRecord['status'];
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
  /** The most recent {@link TASK_EVENT_LIMIT} Events, oldest-to-newest. */
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
  readonly kind: MessageRecord['kind'];
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

export interface SnapshotOptions {
  /** Newest Messages to include, oldest-to-newest (Store enforces 1..1000). */
  readonly historyLimit?: number;
}

function agentSnapshot(agent: AgentRecord, pending: InboxState): AgentSnapshotRecord {
  return {
    type: 'agent',
    schema_version: 1,
    id: agent.id,
    role: agent.role,
    platform_id: agent.platformId,
    status: agent.status,
    activity: agent.activity,
    joined_at: agent.joinedAt,
    last_seen: agent.lastSeen,
    archived_at: agent.archivedAt,
    stale_lease_count: agent.staleLeaseCount,
    pending_summary: {
      type: 'inbox_state',
      schema_version: 1,
      agent_id: pending.agentId,
      unread_count: pending.unreadCount,
      max_unread_id: pending.maxUnreadId,
    },
  };
}

function taskEventSnapshot(event: TaskEventRecord): TaskEventSnapshotRecord {
  return {
    type: 'task_event',
    schema_version: 1,
    id: event.id,
    task_id: event.taskId,
    revision: event.revision,
    event_type: event.eventType,
    actor_id: event.actorId,
    from_status: event.fromStatus,
    to_status: event.toStatus,
    detail: event.detail,
    created_at: event.createdAt,
  };
}

function taskSnapshot(task: TaskRecord, events: readonly TaskEventRecord[]): TaskSnapshotRecord {
  return {
    type: 'task',
    schema_version: 1,
    id: task.id,
    title: task.title,
    body: task.body,
    creator_id: task.creatorId,
    assignee_id: task.assigneeId,
    reviewer_id: task.reviewerId,
    status: task.status,
    revision: task.revision,
    lease_owner_id: task.leaseOwnerId,
    lease_expires_at: task.leaseExpiresAt,
    submission_summary: task.submissionSummary,
    submitted_at: task.submittedAt,
    review_summary: task.reviewSummary,
    completed_at: task.completedAt,
    abandoned_at: task.abandonedAt,
    worktree_path: task.worktreePath,
    worktree_branch: task.worktreeBranch,
    worktree_base_ref: task.worktreeBaseRef,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    stale_lease: task.staleLease,
    events: events.slice(-TASK_EVENT_LIMIT).map(taskEventSnapshot),
  };
}

function messageSnapshot(message: MessageRecord): MessageSnapshotRecord {
  return {
    type: 'message',
    schema_version: 1,
    id: message.id,
    sender_id: message.senderId,
    recipient_id: message.recipientId,
    content: message.content,
    kind: message.kind,
    task_id: message.taskId,
    reply_to: message.replyTo,
    created_at: message.createdAt,
    read_at: message.readAt,
  };
}

/**
 * Build one read-only Workspace snapshot. Archived Agents are included so the
 * roster is the complete Store fact; the dashboard filters presentation.
 */
export function buildSnapshot(
  store: SnapshotStore,
  options: SnapshotOptions = {},
): WorkspaceSnapshot {
  const historyLimit = options.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  return {
    agents: store
      .listAgents({ includeArchived: true })
      .map((agent) => agentSnapshot(agent, store.getPendingSummary(agent.id))),
    tasks: store.listTasks().map((listed) => {
      // Re-read each Task with its Events from one read snapshot so the pair
      // cannot tear; a Task pruned between the reads keeps its listed record.
      const pair = store.getTaskWithEvents(listed.id);
      return taskSnapshot(pair.task ?? listed, pair.events);
    }),
    messages: store.listMessageHistory({ limit: historyLimit }).map(messageSnapshot),
  };
}
