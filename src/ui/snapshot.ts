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
import type {
  AgentSnapshotRecord,
  InboxStateSnapshotRecord,
  MessageSnapshotRecord,
  TaskEventSnapshotRecord,
  TaskSnapshotRecord,
  WorkspaceSnapshot,
} from './snapshot-records.js';

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

/**
 * The snapshot wire shapes live in `./snapshot-records.js` — a leaf with no
 * Store import — so the browser bundle in `web/` can name the same
 * declarations instead of hand-copying them. Re-exported here because this
 * module is the one every `src/` and `tests/` consumer already imports.
 */
export type {
  AgentSnapshotRecord,
  InboxStateSnapshotRecord,
  MessageSnapshotRecord,
  TaskEventSnapshotRecord,
  TaskSnapshotRecord,
  WorkspaceSnapshot,
};

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
