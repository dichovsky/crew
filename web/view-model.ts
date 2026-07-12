/**
 * Pure view-model helpers for the Console: relative-time formatting, the
 * role/status/activity/message colour vocabularies from the Crew Console
 * design, and the derived selectors (review queue, unread count, needs-
 * attention, per-agent current task, merged activity feed, header stats). All
 * timestamps are epoch SECONDS, matching the Store snapshot; `now` is passed in
 * milliseconds so callers and tests control the clock. These functions never
 * touch the DOM, so they carry the Console's logic under unit test.
 */
import type {
  AgentSnapshotRecord,
  MessageSnapshotRecord,
  TaskEventSnapshotRecord,
  TaskSnapshotRecord,
} from './types.js';

/** The human Operator's plain Agent id (ADR-0012), mirrored server-side. */
export const OPERATOR_ID = 'operator';

/** The design accent; the sole colour the server/design treat as themeable. */
export const ACCENT = '#3b5bd9';

/** Compact "Ns/Nm/Nh/Nd ago" from an epoch-seconds timestamp. */
export function relTime(tsSeconds: number, now: number = Date.now()): string {
  const s = Math.max(1, Math.round(now / 1000 - tsSeconds));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** First two characters of an id, uppercased, for an avatar chip. */
export function initials(id: string): string {
  return id.slice(0, 2).toUpperCase();
}

/** A compact id chip: long ids (Task UUIDs) collapse to their first 8 chars. */
export function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id;
}

export interface StatusMeta {
  readonly label: string;
  readonly fg: string;
  readonly bg: string;
  readonly dot: string;
}

const STATUS_META: Record<string, StatusMeta> = {
  queued: { label: 'Queued', fg: '#5b6675', bg: '#eef1f5', dot: '#8b95a3' },
  in_progress: { label: 'In progress', fg: '#1f6fd6', bg: '#e8f1fd', dot: '#2f7de0' },
  submitted: { label: 'In review', fg: '#7c3fc4', bg: '#f3ecfb', dot: '#8b4fd0' },
  completed: { label: 'Completed', fg: '#1f8a53', bg: '#e6f4ec', dot: '#27a05f' },
  abandoned: { label: 'Abandoned', fg: '#c04532', bg: '#fbece9', dot: '#d15540' },
};

/** Status vocabulary for pills, dots and column headers. Unknown → queued. */
export function statusMeta(status: string): StatusMeta {
  return STATUS_META[status] ?? STATUS_META['queued']!;
}

export interface ActivityMeta {
  readonly label: string;
  readonly color: string;
  readonly dot: string;
}

const ACTIVITY_META: Record<string, ActivityMeta> = {
  recent: { label: 'Active', color: '#1f8a53', dot: '#27a05f' },
  idle: { label: 'Idle', color: '#b07d14', dot: '#d99a2b' },
  stale: { label: 'Stale', color: '#c04532', dot: '#d15540' },
  archived: { label: 'Archived', color: '#8b95a3', dot: '#b0b6bf' },
};

/** Agent liveness vocabulary. Unknown → idle. */
export function activityMeta(activity: string): ActivityMeta {
  return ACTIVITY_META[activity] ?? ACTIVITY_META['idle']!;
}

const ROLE_COLOR: Record<string, string> = {
  manager: '#3b5bd9',
  worker: '#0e8a8a',
  inspector: '#7c3fc4',
  reviewer: '#7c3fc4',
  operator: '#181a1f',
};

/** Role tint for avatars and role pills. Unknown → neutral slate. */
export function roleColor(role: string): string {
  return ROLE_COLOR[role] ?? '#5b6675';
}

export interface MessageKindMeta {
  readonly label: string;
  readonly bg: string;
  readonly fg: string;
}

const MESSAGE_KIND_META: Record<string, MessageKindMeta> = {
  note: { label: 'Note', bg: '#eef0f3', fg: '#6b7480' },
  task_submitted: { label: 'Submitted', bg: '#f3ecfb', fg: '#7c3fc4' },
  task_approved: { label: 'Approved', bg: '#e6f4ec', fg: '#1f8a53' },
  task_assigned: { label: 'Assigned', bg: '#e8f1fd', fg: '#1f6fd6' },
  task_requeued: { label: 'Requeued', bg: '#eef1f5', fg: '#5b6675' },
  clear_safe: { label: 'Sign-off', bg: '#e6f4f1', fg: '#0f766e' },
};

/** Message-kind pill vocabulary. Unknown → note. */
export function messageKindMeta(kind: string): MessageKindMeta {
  return MESSAGE_KIND_META[kind] ?? MESSAGE_KIND_META['note']!;
}

/** True when a Message is unread and addressed to the Operator. */
export function isUnreadToOperator(message: MessageSnapshotRecord): boolean {
  return message.recipient_id === OPERATOR_ID && message.read_at === null;
}

/** Count of the Operator's own unread Messages. */
export function unreadCount(messages: readonly MessageSnapshotRecord[]): number {
  return messages.filter(isUnreadToOperator).length;
}

/** Submitted Tasks the Operator is the reviewer of — the review queue. */
export function reviewQueue(tasks: readonly TaskSnapshotRecord[]): readonly TaskSnapshotRecord[] {
  return tasks.filter((task) => task.status === 'submitted' && task.reviewer_id === OPERATOR_ID);
}

/** The in-flight Task an Agent currently holds, or `null` when idle. */
export function currentTaskFor(
  agentId: string,
  tasks: readonly TaskSnapshotRecord[],
): TaskSnapshotRecord | null {
  return (
    tasks.find((task) => task.status === 'in_progress' && task.assignee_id === agentId) ?? null
  );
}

export interface AttentionItem {
  readonly title: string;
  readonly detail: string;
  readonly dot: string;
}

/**
 * The "Needs attention" list: stale-lease Tasks, idle Agents, and the review
 * queue — the same three signals the design surfaces, derived from real data.
 */
export function attentionItems(
  tasks: readonly TaskSnapshotRecord[],
  agents: readonly AgentSnapshotRecord[],
  now: number = Date.now(),
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const task of tasks) {
    if (task.stale_lease) {
      items.push({
        title: `Stale lease on ${task.id}`,
        detail: `${task.assignee_id} holds an expired lease — reassign or requeue.`,
        dot: '#d15540',
      });
    }
  }
  for (const agent of agents) {
    if (agent.activity === 'idle') {
      items.push({
        title: `${agent.id} is idle`,
        detail: `No activity for ${relTime(agent.last_seen, now).replace(' ago', '')}.`,
        dot: '#d99a2b',
      });
    }
  }
  const queue = reviewQueue(tasks);
  if (queue.length > 0) {
    items.push({
      title: `${queue.length} task(s) await your review`,
      detail: `${queue.map((task) => task.id).join(', ')} assigned to you as reviewer.`,
      dot: '#8b4fd0',
    });
  }
  return items;
}

export interface ActivityEvent {
  readonly key: string;
  readonly actor: string;
  readonly text: string;
  readonly toStatus: string;
  readonly createdAt: number;
}

/**
 * A merged, newest-first activity feed across every Task's Event timeline —
 * the Overview "Recent events" panel. `limit` bounds the render.
 */
export function activityFeed(tasks: readonly TaskSnapshotRecord[], limit = 8): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const task of tasks) {
    for (const event of task.events) {
      events.push({
        key: `${event.task_id}:${event.id}`,
        actor: event.actor_id,
        text: describeEvent(event, task.id),
        toStatus: event.to_status,
        createdAt: event.created_at,
      });
    }
  }
  events.sort((a, b) => b.createdAt - a.createdAt);
  return events.slice(0, limit);
}

/** A short, human phrase for one Task Event, always naming its Task. */
export function describeEvent(event: TaskEventSnapshotRecord, taskId: string): string {
  const detail = event.detail.trim();
  if (detail.length > 0) return detail;
  switch (event.event_type) {
    case 'created':
      return `created ${taskId}`;
    case 'started':
      return `started ${taskId}`;
    case 'submitted':
      return `submitted ${taskId} for review`;
    case 'approved':
      return `approved ${taskId} — completed`;
    case 'requeued':
      return `requeued ${taskId}`;
    case 'abandoned':
      return `abandoned ${taskId}`;
    default:
      return `updated ${taskId}`;
  }
}

/** Approve is offered only for a submitted Task the Operator reviews (FR-U16). */
export function canApprove(task: TaskSnapshotRecord): boolean {
  return task.status === 'submitted' && task.reviewer_id === OPERATOR_ID;
}

/** Requeue is offered for an in-flight/submitted Task the Operator owns (FR-U17). */
export function canRequeue(task: TaskSnapshotRecord): boolean {
  return (
    (task.status === 'in_progress' || task.status === 'submitted') &&
    (task.creator_id === OPERATOR_ID || task.reviewer_id === OPERATOR_ID)
  );
}

export interface LeaseView {
  readonly label: string;
  readonly color: string;
}

/** Human lease state for the Task detail: expired, active-with-countdown, or none. */
export function leaseView(task: TaskSnapshotRecord, now: number = Date.now()): LeaseView {
  if (task.stale_lease) return { label: 'expired', color: '#c04532' };
  if (task.lease_expires_at !== null) {
    const secondsLeft = task.lease_expires_at - Math.round(now / 1000);
    if (secondsLeft > 0) {
      return { label: `active · ${humanizeDuration(secondsLeft)} left`, color: '#1f8a53' };
    }
    return { label: 'expired', color: '#c04532' };
  }
  return { label: '—', color: '#8a919c' };
}

/** Coarse "Nm"/"Nh"/"Nd"/"Ns" for a positive second span. */
function humanizeDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
