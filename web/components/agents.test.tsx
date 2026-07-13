/**
 * Agents view tests: one card per Agent with role/activity, engine badge,
 * platform, current task (derived), inbox depth, and Message/Archive-Restore
 * actions. Activity stays honest ("Active"/"Idle"/"Stale") — never "online".
 * Archived Agents are hidden by default behind a local toggle and dimmed
 * when shown. Hostile ids render inert. No Delete action exists (ADR-0017).
 */
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSnapshotRecord, TaskSnapshotRecord } from '../types.js';
import { Agents, type AgentsProps } from './agents';

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

function mount(overrides: Partial<AgentsProps> = {}): {
  host: HTMLElement;
  onMessageAgent: ReturnType<typeof vi.fn>;
  onArchiveAgent: ReturnType<typeof vi.fn>;
  onRestoreAgent: ReturnType<typeof vi.fn>;
} {
  const onMessageAgent = vi.fn();
  const onArchiveAgent = vi.fn();
  const onRestoreAgent = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(
    <Agents
      agents={[agent()]}
      tasks={[]}
      now={0}
      dark={false}
      disabled={false}
      onMessageAgent={onMessageAgent}
      onArchiveAgent={onArchiveAgent}
      onRestoreAgent={onRestoreAgent}
      {...overrides}
    />,
    host,
  );
  return { host, onMessageAgent, onArchiveAgent, onRestoreAgent };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Agents', () => {
  it('renders a card per agent with role, platform, and inbox depth', () => {
    const { host } = mount({
      agents: [
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
      ],
    });
    const card = host.querySelector('.agent-card')!;
    expect(card.textContent).toContain('ada');
    expect(card.textContent).toContain('manager');
    expect(card.textContent).toContain('claude-code');
    expect(card.textContent).toContain('2 unread');
    host.remove();
  });

  it('shows a dash for a null platform and an empty inbox', () => {
    const { host } = mount({ agents: [agent({ platform_id: null })] });
    expect(host.textContent).toContain('—');
    expect(host.textContent).toContain('empty');
    host.remove();
  });

  it('derives the current-task fact from an in-progress assignment', () => {
    const { host } = mount({
      agents: [agent({ id: 'worker', role: 'worker' })],
      tasks: [task({ id: 'b'.repeat(36), status: 'in_progress', assignee_id: 'worker' })],
    });
    const facts = host.querySelector('.facts')!;
    expect(facts.textContent).toContain('bbbbbbbb'); // shortId of the current task
    host.remove();
  });

  it('labels activity honestly and never "online"', () => {
    const { host } = mount({ agents: [agent({ activity: 'stale' })] });
    expect(host.textContent).toContain('Stale');
    expect(host.textContent).not.toContain('online');
    host.remove();
  });

  it('fires onMessageAgent from the Message button', () => {
    const { host, onMessageAgent } = mount({ agents: [agent({ id: 'grace' })] });
    const button = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Message grace'),
    ) as HTMLButtonElement;
    button.click();
    expect(onMessageAgent).toHaveBeenCalledWith('grace');
    host.remove();
  });

  it('renders hostile stored ids as inert text', () => {
    const { host } = mount({ agents: [agent({ id: '<img src=x onerror=alert(1)>' })] });
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(host.querySelector('img')).toBeNull();
    host.remove();
  });

  it('shows an engine badge naming the platform', () => {
    const { host } = mount({ agents: [agent({ platform_id: 'gemini-cli' })] });
    expect(host.querySelector('.engine-badge')?.textContent).toContain('Gemini');
    host.remove();
  });

  it('shows an unknown-engine badge for a null platform', () => {
    const { host } = mount({ agents: [agent({ platform_id: null })] });
    expect(host.querySelector('.engine-badge')?.textContent).toContain('unknown');
    host.remove();
  });

  it('fires onArchiveAgent from an active card and hides no Delete action', () => {
    const { host, onArchiveAgent } = mount({ agents: [agent({ id: 'grace', status: 'active' })] });
    const archiveBtn = host.querySelector('.btn-archive') as HTMLButtonElement;
    expect(archiveBtn.title).toBe('Archive grace');
    archiveBtn.click();
    expect(onArchiveAgent).toHaveBeenCalledWith('grace');
    expect([...host.querySelectorAll('button')].some((b) => /delete/i.test(b.title))).toBe(false);
    host.remove();
  });

  it('disables the Archive/Restore button while `disabled` (FR-U32 recovery)', () => {
    const { host } = mount({
      agents: [agent({ id: 'grace', status: 'active' })],
      disabled: true,
    });
    expect((host.querySelector('.btn-archive') as HTMLButtonElement).disabled).toBe(true);
    host.remove();
  });

  it("never shows an Archive control on the operator agent's own card (FR-U36)", () => {
    const { host } = mount({
      agents: [agent({ id: 'operator', role: 'operator', status: 'active' })],
    });
    const card = host.querySelector('.agent-card')!;
    expect(card.textContent).toContain('operator');
    expect(card.querySelector('.btn-archive')).toBeNull();
    // The Message action is unaffected — only Archive is withheld.
    expect(card.querySelector('.btn-outline')).not.toBeNull();
    host.remove();
  });

  it('shows a legible operator role pill in dark mode', () => {
    const { host } = mount({
      agents: [agent({ id: 'operator', role: 'operator', status: 'active' })],
      dark: true,
    });
    const pill = [...host.querySelectorAll('.pill')].find((p) => p.textContent === 'operator')!;
    const style = (pill as HTMLElement).style;
    expect(style.color).not.toBe('rgb(24, 26, 31)'); // #181a1f — invisible on the dark surface
    host.remove();
  });

  it('hides archived agents by default and shows them dimmed via the toggle', async () => {
    const { host } = mount({
      agents: [agent({ id: 'ada', status: 'active' }), agent({ id: 'rob', status: 'archived' })],
    });
    expect(host.querySelectorAll('.agent-card')).toHaveLength(1);
    expect(host.textContent).toContain('Show archived (1)');

    (host.querySelector('.archived-toggle') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(host.querySelectorAll('.agent-card')).toHaveLength(2);
    const archivedCard = [...host.querySelectorAll('.agent-card')].find((c) =>
      c.textContent?.includes('rob'),
    )!;
    expect(archivedCard.classList.contains('archived')).toBe(true);
    host.remove();
  });

  it('fires onRestoreAgent from an archived card, shown once revealed', async () => {
    const { host, onRestoreAgent } = mount({ agents: [agent({ id: 'rob', status: 'archived' })] });
    (host.querySelector('.archived-toggle') as HTMLButtonElement).click();
    await Promise.resolve();
    const restoreBtn = host.querySelector('.btn-archive') as HTMLButtonElement;
    expect(restoreBtn.title).toBe('Restore rob');
    restoreBtn.click();
    expect(onRestoreAgent).toHaveBeenCalledWith('rob');
    host.remove();
  });

  it('renders no archived-toggle when there are no archived agents', () => {
    const { host } = mount({ agents: [agent({ status: 'active' })] });
    expect(host.querySelector('.archived-toggle')).toBeNull();
    host.remove();
  });
});
