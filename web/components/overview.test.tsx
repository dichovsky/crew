/**
 * Overview tests: the four stat cards, the roster (with the message click and
 * "View all"), the needs-attention list (stale lease + idle agent) with its
 * empty state, and the recent-events feed.
 */
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSnapshotRecord, TaskSnapshotRecord } from '../types.js';
import type { HealthState } from './health.js';
import { Overview } from './overview';

function agent(overrides: Partial<AgentSnapshotRecord> = {}): AgentSnapshotRecord {
  return {
    type: 'agent',
    schema_version: 1,
    id: 'ada',
    role: 'manager',
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
    title: 'A task',
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

const HEALTH: HealthState = {
  findings: [],
  summary: { ok: true, info: 0, warn: 0, error: 0, workspace: '/repo/.crew' },
};

function mount(
  agents: readonly AgentSnapshotRecord[],
  tasks: readonly TaskSnapshotRecord[],
  handlers: { onMessageAgent?: (id: string) => void; onGoAgents?: () => void } = {},
): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(
    <Overview
      agents={agents}
      tasks={tasks}
      health={HEALTH}
      now={0}
      dark={false}
      onMessageAgent={handlers.onMessageAgent ?? (() => {})}
      onGoAgents={handlers.onGoAgents ?? (() => {})}
    />,
    host,
  );
  return host;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Overview', () => {
  it('renders four stat cards and the roster', () => {
    const host = mount([agent({ id: 'ada' })], [task({ status: 'in_progress' })]);
    expect(host.querySelectorAll('.stat')).toHaveLength(4);
    expect(host.textContent).toContain('Active agents');
    expect(host.querySelector('.roster-row')?.textContent).toContain('ada');
  });

  it('messages an agent on row click and goes to agents on "View all"', () => {
    const onMessageAgent = vi.fn();
    const onGoAgents = vi.fn();
    const host = mount([agent({ id: 'grace' })], [], { onMessageAgent, onGoAgents });
    host.querySelector('.roster-row')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onMessageAgent).toHaveBeenCalledWith('grace');
    host.querySelector('.link-btn')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onGoAgents).toHaveBeenCalled();
  });

  it('lists stale leases and idle agents under needs-attention', () => {
    const host = mount(
      [agent({ id: 'grace', role: 'worker', activity: 'idle' })],
      [task({ id: 's'.repeat(36), stale_lease: true, assignee_id: 'rob' })],
    );
    const attn = host.querySelector('.attn-item')?.parentElement?.textContent ?? '';
    expect(attn).toContain('Stale lease');
    expect(attn).toContain('grace is idle');
  });

  it('shows the all-clear note when nothing needs attention', () => {
    const host = mount([agent({ activity: 'recent' })], [task({ status: 'queued' })]);
    expect(host.textContent).toContain('All clear');
  });

  it('renders the recent-events feed from task events', () => {
    const host = mount(
      [agent()],
      [
        task({
          events: [
            {
              type: 'task_event',
              schema_version: 1,
              id: 1,
              task_id: 'a'.repeat(36),
              revision: 0,
              event_type: 'created',
              actor_id: 'turing',
              from_status: null,
              to_status: 'queued',
              detail: 'created the task',
              created_at: 0,
            },
          ],
        }),
      ],
    );
    expect(host.querySelector('.events')?.textContent).toContain('turing');
    expect(host.querySelector('.events')?.textContent).toContain('created the task');
  });
});
