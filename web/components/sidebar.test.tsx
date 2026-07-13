/**
 * Sidebar tests: the five nav links, the active-view marker, the live badges
 * (agent count, review, unread, attention dot), navigation callbacks, and the
 * workspace label.
 */
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sidebar, type SidebarProps } from './sidebar';

function mount(overrides: Partial<SidebarProps> = {}): {
  host: HTMLElement;
  onNavigate: ReturnType<typeof vi.fn>;
} {
  const onNavigate = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(
    <Sidebar
      view="overview"
      onNavigate={onNavigate}
      agentCount={6}
      reviewCount={0}
      unreadCount={0}
      needsAttention={false}
      workCount={0}
      workspaceLabel="~/dev/crew"
      {...overrides}
    />,
    host,
  );
  return { host, onNavigate };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Sidebar', () => {
  it('renders the six views and marks the active one', () => {
    const { host } = mount({ view: 'tasks' });
    const items = [...host.querySelectorAll('.nav-item')];
    expect(items.map((i) => i.textContent?.replace(/[0-9]/g, '').trim())).toEqual([
      'Now',
      'Overview',
      'Agents',
      'Tasks',
      'Messages',
      'Operations',
    ]);
    const active = host.querySelector('[aria-current="page"]');
    expect(active?.textContent).toContain('Tasks');
  });

  it('shows the Now work-count badge only when non-zero', () => {
    const { host } = mount({ workCount: 0 });
    expect(host.querySelector('.nav-badge.work')).toBeNull();

    const { host: host2 } = mount({ workCount: 4 });
    expect(host2.querySelector('.nav-badge.work')?.textContent).toBe('4');
  });

  it('shows the agent count always and the review/unread badges only when non-zero', () => {
    const { host } = mount({ agentCount: 6, reviewCount: 0, unreadCount: 0 });
    expect(host.querySelector('.nav-count')?.textContent).toBe('6');
    expect(host.querySelector('.nav-badge.review')).toBeNull();
    expect(host.querySelector('.nav-badge.unread')).toBeNull();

    const { host: host2 } = mount({ reviewCount: 3, unreadCount: 2, needsAttention: true });
    expect(host2.querySelector('.nav-badge.review')?.textContent).toBe('3');
    expect(host2.querySelector('.nav-badge.unread')?.textContent).toBe('2');
    expect(host2.querySelector('.nav-dot')).not.toBeNull();
  });

  it('navigates on click and shows the workspace label', () => {
    const { host, onNavigate } = mount();
    const messages = [...host.querySelectorAll('.nav-item')].find((i) =>
      i.textContent?.includes('Messages'),
    );
    messages?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onNavigate).toHaveBeenCalledWith('messages');
    expect(host.querySelector('.path')?.textContent).toBe('~/dev/crew');
  });
});
