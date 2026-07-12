/**
 * Agents view tests: one card per Agent with role/activity, platform, current
 * task (derived), inbox depth, and a Message action. Activity stays honest
 * ("Active"/"Idle"/"Stale") — never "online". Hostile ids render inert.
 */
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSnapshotRecord, TaskSnapshotRecord } from '../types.js';
import { Agents } from './agents';

function agent(overrides: Partial<AgentSnapshotRecord> = {}): AgentSnapshotRecord {
  return {
    type: 'agent',
    schema_version: 1,
    id: 'ada',
    role: 'worker',
    platform_id: 'codex-cli',
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

function mount(
  agents: readonly AgentSnapshotRecord[],
  tasks: readonly TaskSnapshotRecord[] = [],
  onMessageAgent: (id: string) => void = () => {},
): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(<Agents agents={agents} tasks={tasks} now={0} onMessageAgent={onMessageAgent} />, host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Agents', () => {
  it('renders a card per agent with role, platform, and inbox depth', () => {
    const host = mount([
      agent({
        id: 'ada',
        role: 'manager',
        platform_id: 'claude-code',
        pending_summary: {
          type: 'inbox_state',
          schema_version: 1,
          agent_id: 'ada',
          unread_count: 2,
          max_unread_id: 5,
        },
      }),
    ]);
    const card = host.querySelector('.agent-card')!;
    expect(card.textContent).toContain('ada');
    expect(card.textContent).toContain('manager');
    expect(card.textContent).toContain('claude-code');
    expect(card.textContent).toContain('2 unread');
    host.remove();
  });

  it('shows a dash for a null platform and an empty inbox', () => {
    const host = mount([agent({ platform_id: null })]);
    expect(host.textContent).toContain('—');
    expect(host.textContent).toContain('empty');
    host.remove();
  });

  it('derives the current-task fact from an in-progress assignment', () => {
    const host = mount(
      [agent({ id: 'worker', role: 'worker' })],
      [task({ id: 'b'.repeat(36), status: 'in_progress', assignee_id: 'worker' })],
    );
    const facts = host.querySelector('.facts')!;
    expect(facts.textContent).toContain('bbbbbbbb'); // shortId of the current task
    host.remove();
  });

  it('labels activity honestly and never "online"', () => {
    const host = mount([agent({ activity: 'stale' })]);
    expect(host.textContent).toContain('Stale');
    expect(host.textContent).not.toContain('online');
    host.remove();
  });

  it('fires onMessageAgent from the Message button', () => {
    const onMessage = vi.fn();
    const host = mount([agent({ id: 'grace' })], [], onMessage);
    const button = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Message grace'),
    ) as HTMLButtonElement;
    button.click();
    expect(onMessage).toHaveBeenCalledWith('grace');
    host.remove();
  });

  it('renders hostile stored ids as inert text', () => {
    const host = mount([agent({ id: '<img src=x onerror=alert(1)>' })]);
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(host.querySelector('img')).toBeNull();
    host.remove();
  });
});
