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

/**
 * Pill background: the design's fixed light pastel, or (dark mode) a
 * translucent tint of the foreground colour — the Crew Console dark
 * palette's own `color-mix(in srgb, fg 20%, transparent)` formula, since a
 * flat light pastel reads as washed out against a dark surface. Foreground,
 * dot, and every other semantic colour stay identical between themes.
 */
export function pillBg(bg: string, fg: string, dark: boolean): string {
  return dark ? `color-mix(in srgb, ${fg} 20%, transparent)` : bg;
}

/** Status vocabulary for pills, dots and column headers. Unknown → queued. */
export function statusMeta(status: string, dark = false): StatusMeta {
  const meta = STATUS_META[status] ?? STATUS_META['queued']!;
  return { ...meta, bg: pillBg(meta.bg, meta.fg, dark) };
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

/** Role tint for avatars. Unknown → neutral slate. Always this value, in both themes — avatars pair it with fixed white text (`.avatar` CSS), which stays legible against operator's near-black either way. */
export function roleColor(role: string): string {
  return ROLE_COLOR[role] ?? '#5b6675';
}

/**
 * Role tint for pills specifically (text colour and, via {@link rolePillBg},
 * the tinted background). Distinct from {@link roleColor}: operator's near-
 * black (`#181a1f`, correct on an avatar's white-on-black chip) would put
 * near-black text on a `color-mix`-darkened near-black pill background in
 * dark mode — invisible. Substitutes a light, legible tone for operator only
 * when dark; every other role's colour already has enough contrast in both
 * themes and is returned unchanged.
 */
export function rolePillColor(role: string, dark: boolean): string {
  if (dark && role === 'operator') return '#c7ccd4';
  return roleColor(role);
}

/**
 * Role pill background: light mode keeps the design's ~9% hex-alpha tint
 * (`${color}18`); dark mode uses the same `color-mix` translucency as every
 * other pill in {@link pillBg}. Pass {@link rolePillColor}'s result, not
 * {@link roleColor}'s, so the tint matches the (possibly substituted) text.
 */
export function rolePillBg(color: string, dark: boolean): string {
  return dark ? `color-mix(in srgb, ${color} 20%, transparent)` : `${color}18`;
}

export interface EngineMeta {
  readonly label: string;
  /** Two-glyph badge symbol; a Unicode character rather than a logo image (no network asset). */
  readonly glyph: string;
  /** Solid tint for the small glyph chip. */
  readonly color: string;
  readonly bg: string;
  readonly fg: string;
}

const ENGINE_META: Record<string, EngineMeta> = {
  'claude-code': {
    label: 'Claude Code',
    glyph: '✳',
    color: '#d97757',
    bg: '#fbf0ea',
    fg: '#b45635',
  },
  'codex-cli': { label: 'Codex', glyph: '◇', color: '#10a37f', bg: '#e6f5f0', fg: '#0c7d61' },
  'gemini-cli': { label: 'Gemini', glyph: '✦', color: '#4285f4', bg: '#e8f0fe', fg: '#2b66c9' },
  'copilot-cli': { label: 'Copilot', glyph: '⧉', color: '#6e40c9', bg: '#f0eafb', fg: '#5a2fb0' },
  'antigravity-cli': {
    label: 'Antigravity',
    glyph: '▲',
    color: '#1f8a53',
    bg: '#e6f4ec',
    fg: '#1a7345',
  },
  'pi-cli': { label: 'Pi', glyph: 'π', color: '#c2317a', bg: '#fbe9f2', fg: '#a52868' },
  'opencode-cli': { label: 'opencode', glyph: '❯', color: '#c9821f', bg: '#f9f0e2', fg: '#a66b12' },
};

/**
 * Per-platform badge tint for an Agent card. Unlike status/role pills this
 * does not vary with the light/dark theme — the design keeps engine badges
 * at a fixed pastel in both. Unknown or absent (`null`) platform → a neutral
 * "unknown" badge naming whatever id was given (or "unknown" for `null`).
 */
export function engineMeta(platformId: string | null): EngineMeta {
  if (platformId !== null && platformId in ENGINE_META) return ENGINE_META[platformId]!;
  return {
    label: platformId ?? 'unknown',
    glyph: '·',
    color: '#5b6675',
    bg: '#eef0f3',
    fg: '#5b6675',
  };
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
export function messageKindMeta(kind: string, dark = false): MessageKindMeta {
  const meta = MESSAGE_KIND_META[kind] ?? MESSAGE_KIND_META['note']!;
  return { ...meta, bg: pillBg(meta.bg, meta.fg, dark) };
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

export type WorkItemKind = 'stale_lease' | 'review' | 'idle_agent' | 'unread_message';

export type WorkItemTarget =
  | { readonly kind: 'task'; readonly taskId: string }
  | { readonly kind: 'agent'; readonly agentId: string }
  | { readonly kind: 'messages' };

export interface WorkItem {
  readonly key: string;
  readonly kind: WorkItemKind;
  readonly label: string;
  readonly title: string;
  readonly detail: string;
  readonly actionLabel: string;
  /** Bar/tag/action-button tint. */
  readonly color: string;
  /** Tag's light-mode background (dark mode derives its own via {@link pillBg}). */
  readonly bg: string;
  readonly target: WorkItemTarget;
}

/**
 * The "Now" triage worklist (FR-U37): the same stale-Lease/review-queue/
 * idle-Agent signals {@link attentionItems} surfaces for Overview, plus the
 * Operator's unread Messages, in the design's priority order (stale lease,
 * review queue, idle Agents, unread Messages) with an action each item
 * routes to. Introduces no new data or authority — every action named here
 * already exists elsewhere in the Console.
 */
export function nowWorklist(
  tasks: readonly TaskSnapshotRecord[],
  agents: readonly AgentSnapshotRecord[],
  messages: readonly MessageSnapshotRecord[],
  now: number = Date.now(),
): WorkItem[] {
  const items: WorkItem[] = [];
  for (const task of tasks) {
    if (!task.stale_lease) continue;
    items.push({
      key: `stale:${task.id}`,
      kind: 'stale_lease',
      label: 'Stale lease',
      title: `Reassign or requeue ${task.id}`,
      detail: `${task.assignee_id} holds an expired lease on “${task.title}”.`,
      actionLabel: 'Resolve',
      color: '#d15540',
      bg: '#fbece9',
      target: { kind: 'task', taskId: task.id },
    });
  }
  for (const task of reviewQueue(tasks)) {
    items.push({
      key: `review:${task.id}`,
      kind: 'review',
      label: 'Awaiting review',
      title: `Review ${task.id}`,
      detail: `“${task.title}” submitted by ${task.assignee_id}.`,
      actionLabel: 'Review',
      color: '#8b4fd0',
      bg: '#f3ecfb',
      target: { kind: 'task', taskId: task.id },
    });
  }
  for (const agent of agents) {
    if (agent.activity !== 'idle') continue;
    items.push({
      key: `idle:${agent.id}`,
      kind: 'idle_agent',
      label: 'Idle agent',
      title: `${agent.id} has gone quiet`,
      detail: `No activity for ${relTime(agent.last_seen, now).replace(' ago', '')}. Nudge it or reassign its work.`,
      actionLabel: 'Message',
      color: '#d99a2b',
      bg: '#fbf1de',
      target: { kind: 'agent', agentId: agent.id },
    });
  }
  for (const message of messages) {
    if (!isUnreadToOperator(message)) continue;
    items.push({
      key: `unread:${message.id}`,
      kind: 'unread_message',
      label: 'Unread message',
      title: `Reply to ${message.sender_id}`,
      detail: `“${message.content}”`,
      actionLabel: 'Open inbox',
      color: ACCENT,
      bg: `${ACCENT}18`,
      target: { kind: 'messages' },
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

/**
 * Exhaustiveness guard for a discriminated union's remaining branch (e.g. the
 * last arm of an if/else chain or a switch's default). `x` is typed `never`
 * only when every other member has already been narrowed away, so adding a
 * new union member without handling it here is a compile error, not a silent
 * runtime no-op.
 */
export function assertNever(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
