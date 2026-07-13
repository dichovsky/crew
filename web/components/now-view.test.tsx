/**
 * Now view tests: the "All clear" empty state when there is no work, one
 * card per WorkItem with its label/title/detail, and dispatching a click to
 * the right callback per target kind (task/agent/messages).
 */
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '../view-model';
import { NowView, type NowViewProps } from './now-view';

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    key: 'stale:T-1',
    kind: 'stale_lease',
    label: 'Stale lease',
    title: 'Reassign or requeue T-1',
    detail: 'grace holds an expired lease.',
    actionLabel: 'Resolve',
    color: '#d15540',
    bg: '#fbece9',
    target: { kind: 'task', taskId: 'T-1' },
    ...overrides,
  };
}

function mount(overrides: Partial<NowViewProps> = {}): {
  host: HTMLElement;
  onSelectTask: ReturnType<typeof vi.fn>;
  onMessageAgent: ReturnType<typeof vi.fn>;
  onOpenMessages: ReturnType<typeof vi.fn>;
} {
  const onSelectTask = vi.fn();
  const onMessageAgent = vi.fn();
  const onOpenMessages = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(
    <NowView
      items={[workItem()]}
      dark={false}
      onSelectTask={onSelectTask}
      onMessageAgent={onMessageAgent}
      onOpenMessages={onOpenMessages}
      {...overrides}
    />,
    host,
  );
  return { host, onSelectTask, onMessageAgent, onOpenMessages };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('NowView', () => {
  it('shows the All clear empty state when there is no work', () => {
    const { host } = mount({ items: [] });
    expect(host.querySelector('.now-empty-title')?.textContent).toBe('All clear');
    expect(host.querySelector('.work-card')).toBeNull();
    host.remove();
  });

  it('renders one card per item with its label, title, and detail', () => {
    const { host } = mount({
      items: [
        workItem(),
        workItem({ key: 'idle:grace', label: 'Idle agent', title: 'grace has gone quiet' }),
      ],
    });
    const cards = [...host.querySelectorAll('.work-card')];
    expect(cards).toHaveLength(2);
    expect(cards[0]!.querySelector('.pill')?.textContent).toBe('Stale lease');
    expect(cards[0]!.querySelector('.work-title')?.textContent).toBe('Reassign or requeue T-1');
    expect(cards[1]!.querySelector('.pill')?.textContent).toBe('Idle agent');
    host.remove();
  });

  it('shows the pluralized heading count', () => {
    const { host } = mount({ items: [workItem(), workItem({ key: 'b' })] });
    expect(host.querySelector('.now-head h2')?.textContent).toBe('2 things need you');
    host.remove();
  });

  it('dispatches a task target to onSelectTask', () => {
    const { host, onSelectTask } = mount({
      items: [workItem({ target: { kind: 'task', taskId: 'T-9' } })],
    });
    host
      .querySelector('.work-action button')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onSelectTask).toHaveBeenCalledWith('T-9');
  });

  it('dispatches an agent target to onMessageAgent', () => {
    const { host, onMessageAgent } = mount({
      items: [workItem({ target: { kind: 'agent', agentId: 'grace' } })],
    });
    host
      .querySelector('.work-action button')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onMessageAgent).toHaveBeenCalledWith('grace');
  });

  it('dispatches a messages target to onOpenMessages', () => {
    const { host, onOpenMessages } = mount({ items: [workItem({ target: { kind: 'messages' } })] });
    host
      .querySelector('.work-action button')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onOpenMessages).toHaveBeenCalledTimes(1);
  });
});
