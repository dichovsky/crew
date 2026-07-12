import { describe, expect, it } from 'vitest';
import type {
  AgentSnapshotRecord,
  MessageSnapshotRecord,
  TaskEventSnapshotRecord,
  TaskSnapshotRecord,
} from './types.js';
import {
  activityFeed,
  activityMeta,
  attentionItems,
  canApprove,
  canRequeue,
  currentTaskFor,
  describeEvent,
  initials,
  isUnreadToOperator,
  leaseView,
  messageKindMeta,
  OPERATOR_ID,
  relTime,
  reviewQueue,
  roleColor,
  shortId,
  statusMeta,
  unreadCount,
} from './view-model.js';

function agent(overrides: Partial<AgentSnapshotRecord> = {}): AgentSnapshotRecord {
  return {
    type: 'agent',
    schema_version: 1,
    id: 'ada',
    role: 'worker',
    platform_id: null,
    status: 'active',
    activity: 'recent',
    joined_at: 1,
    last_seen: 2,
    archived_at: null,
    stale_lease_count: 0,
    pending_summary: {
      type: 'inbox_state',
      schema_version: 1,
      agent_id: 'ada',
      unread_count: 0,
      max_unread_id: null,
    },
    ...overrides,
  };
}

function task(overrides: Partial<TaskSnapshotRecord> = {}): TaskSnapshotRecord {
  return {
    type: 'task',
    schema_version: 1,
    id: 'a'.repeat(36),
    title: 'Add X',
    body: '',
    creator_id: 'manager',
    assignee_id: 'worker',
    reviewer_id: 'inspector',
    status: 'queued',
    revision: 0,
    lease_owner_id: null,
    lease_expires_at: null,
    submission_summary: null,
    submitted_at: null,
    review_summary: null,
    completed_at: null,
    abandoned_at: null,
    created_at: 0,
    updated_at: 0,
    stale_lease: false,
    events: [],
    ...overrides,
  };
}

function event(overrides: Partial<TaskEventSnapshotRecord> = {}): TaskEventSnapshotRecord {
  return {
    type: 'task_event',
    schema_version: 1,
    id: 1,
    task_id: 'a'.repeat(36),
    revision: 0,
    event_type: 'created',
    actor_id: 'manager',
    from_status: null,
    to_status: 'queued',
    detail: '',
    created_at: 0,
    ...overrides,
  };
}

function message(overrides: Partial<MessageSnapshotRecord> = {}): MessageSnapshotRecord {
  return {
    type: 'message',
    schema_version: 1,
    id: 1,
    sender_id: 'ada',
    recipient_id: OPERATOR_ID,
    content: 'hi',
    kind: 'note',
    task_id: null,
    reply_to: null,
    created_at: 0,
    read_at: null,
    ...overrides,
  };
}

describe('relTime', () => {
  it('formats seconds, minutes, hours and days', () => {
    const now = 1_000_000_000_000; // ms
    const nowSec = now / 1000;
    expect(relTime(nowSec - 5, now)).toBe('5s ago');
    expect(relTime(nowSec - 120, now)).toBe('2m ago');
    expect(relTime(nowSec - 7200, now)).toBe('2h ago');
    expect(relTime(nowSec - 172800, now)).toBe('2d ago');
  });

  it('never returns a non-positive age', () => {
    const now = 1_000_000;
    expect(relTime(now / 1000 + 500, now)).toBe('1s ago');
  });
});

describe('id helpers', () => {
  it('initials takes the first two chars uppercased', () => {
    expect(initials('ada')).toBe('AD');
    expect(initials('x')).toBe('X');
  });

  it('shortId collapses long UUIDs but keeps short ids', () => {
    expect(shortId('a'.repeat(36))).toBe('aaaaaaaa');
    expect(shortId('T-9')).toBe('T-9');
  });
});

describe('colour vocabularies', () => {
  it('statusMeta maps known statuses and falls back to queued', () => {
    expect(statusMeta('submitted').label).toBe('In review');
    expect(statusMeta('completed').dot).toBe('#27a05f');
    expect(statusMeta('nonsense').label).toBe('Queued');
  });

  it('activityMeta maps known activities and falls back to idle', () => {
    expect(activityMeta('recent').label).toBe('Active');
    expect(activityMeta('stale').color).toBe('#c04532');
    expect(activityMeta('???').label).toBe('Idle');
  });

  it('roleColor maps known roles and falls back to slate', () => {
    expect(roleColor('manager')).toBe('#3b5bd9');
    expect(roleColor('mystery')).toBe('#5b6675');
  });

  it('messageKindMeta maps known kinds and falls back to note', () => {
    expect(messageKindMeta('task_submitted').label).toBe('Submitted');
    expect(messageKindMeta('clear_safe').label).toBe('Sign-off');
    expect(messageKindMeta('other').label).toBe('Note');
  });
});

describe('message selectors', () => {
  it('isUnreadToOperator is true only for unread operator-addressed messages', () => {
    expect(isUnreadToOperator(message())).toBe(true);
    expect(isUnreadToOperator(message({ read_at: 5 }))).toBe(false);
    expect(isUnreadToOperator(message({ recipient_id: 'ada' }))).toBe(false);
  });

  it('unreadCount counts only the operator inbox', () => {
    expect(
      unreadCount([
        message(),
        message({ id: 2, read_at: 1 }),
        message({ id: 3, recipient_id: 'x' }),
      ]),
    ).toBe(1);
  });
});

describe('task selectors', () => {
  it('reviewQueue picks submitted tasks the operator reviews', () => {
    const mine = task({ id: 'm'.repeat(36), status: 'submitted', reviewer_id: OPERATOR_ID });
    const theirs = task({ id: 't'.repeat(36), status: 'submitted', reviewer_id: 'inspector' });
    expect(reviewQueue([mine, theirs]).map((t) => t.id)).toEqual([mine.id]);
  });

  it('currentTaskFor returns the in-progress task an agent holds', () => {
    const running = task({ status: 'in_progress', assignee_id: 'ada' });
    expect(currentTaskFor('ada', [running])?.id).toBe(running.id);
    expect(currentTaskFor('ada', [task({ status: 'queued', assignee_id: 'ada' })])).toBeNull();
  });

  it('canApprove/canRequeue enforce the FR-U16/U17 matrix', () => {
    expect(canApprove(task({ status: 'submitted', reviewer_id: OPERATOR_ID }))).toBe(true);
    expect(canApprove(task({ status: 'submitted', reviewer_id: 'x' }))).toBe(false);
    expect(canRequeue(task({ status: 'in_progress', creator_id: OPERATOR_ID }))).toBe(true);
    expect(canRequeue(task({ status: 'submitted', reviewer_id: OPERATOR_ID }))).toBe(true);
    expect(canRequeue(task({ status: 'queued', creator_id: OPERATOR_ID }))).toBe(false);
    expect(canRequeue(task({ status: 'in_progress', creator_id: 'x', reviewer_id: 'y' }))).toBe(
      false,
    );
  });
});

describe('attentionItems', () => {
  it('surfaces stale leases, idle agents, and the review queue', () => {
    const now = 1_000_000;
    const items = attentionItems(
      [
        task({ id: 's'.repeat(36), stale_lease: true, assignee_id: 'rob' }),
        task({ id: 'r'.repeat(36), status: 'submitted', reviewer_id: OPERATOR_ID }),
      ],
      [agent({ id: 'grace', activity: 'idle', last_seen: now / 1000 - 360 })],
      now,
    );
    expect(items.map((i) => i.title)).toEqual([
      expect.stringContaining('Stale lease'),
      expect.stringContaining('grace is idle'),
      expect.stringContaining('await your review'),
    ]);
  });

  it('is empty when nothing needs the operator', () => {
    expect(attentionItems([task({ status: 'queued' })], [agent({ activity: 'recent' })])).toEqual(
      [],
    );
  });
});

describe('activityFeed', () => {
  it('merges task events newest-first and bounds the count', () => {
    const t = task({
      events: [
        event({ id: 1, created_at: 10, event_type: 'created' }),
        event({ id: 2, created_at: 30, event_type: 'submitted' }),
        event({ id: 3, created_at: 20, event_type: 'started' }),
      ],
    });
    const feed = activityFeed([t]);
    expect(feed.map((e) => e.createdAt)).toEqual([30, 20, 10]);
    expect(feed[0]!.key).toBe(`${t.id}:2`);
  });

  it('respects the limit', () => {
    const t = task({
      events: Array.from({ length: 12 }, (_, i) => event({ id: i + 1, created_at: i })),
    });
    expect(activityFeed([t], 5)).toHaveLength(5);
  });
});

describe('describeEvent', () => {
  it('prefers the stored detail when present', () => {
    expect(describeEvent(event({ detail: '  did a thing  ' }), 'T-1')).toBe('did a thing');
  });

  it('falls back to an event-type phrase naming the task', () => {
    expect(describeEvent(event({ event_type: 'submitted', detail: '' }), 'T-1')).toBe(
      'submitted T-1 for review',
    );
    expect(describeEvent(event({ event_type: 'approved', detail: '' }), 'T-1')).toContain(
      'approved',
    );
    expect(describeEvent(event({ event_type: 'created', detail: '' }), 'T-1')).toContain('created');
    expect(describeEvent(event({ event_type: 'started', detail: '' }), 'T-1')).toContain('started');
    expect(describeEvent(event({ event_type: 'requeued', detail: '' }), 'T-1')).toContain(
      'requeued',
    );
    expect(describeEvent(event({ event_type: 'abandoned', detail: '' }), 'T-1')).toContain(
      'abandoned',
    );
  });
});

describe('leaseView', () => {
  it('reports an expired stale lease', () => {
    expect(leaseView(task({ stale_lease: true })).label).toBe('expired');
  });

  it('reports a countdown for an active lease and a dash for none', () => {
    const now = 1_000_000;
    const active = leaseView(task({ lease_expires_at: now / 1000 + 600 }), now);
    expect(active.label).toContain('active');
    expect(active.label).toContain('left');
    expect(leaseView(task({ lease_expires_at: null }), now).label).toBe('—');
    expect(leaseView(task({ lease_expires_at: now / 1000 - 10 }), now).label).toBe('expired');
  });
});
