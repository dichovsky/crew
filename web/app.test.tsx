/**
 * App wiring tests (jsdom): mocked ./api.js and a URL-routing fetch stub prove
 * the mount fetch + render of Now (the default view) and Overview, sidebar
 * navigation across the six views, the SSE-driven refetch (no polling),
 * close() on unmount, the honest error state and recovery, the message send
 * (POST then refetch), the quick-message modal opened by clicking an Agent,
 * the light/dark theme toggle (persisted, FR-U38), and the one-click
 * destructive confirm (including Agent archive, FR-U36).
 */
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './app.js';
import type {
  AgentSnapshotRecord,
  MessageSnapshotRecord,
  ResumableSessionSnapshotRecord,
  SessionSnapshotRecord,
  TaskSnapshotRecord,
  WorkspaceSnapshot,
} from './types.js';

const mocks = vi.hoisted(() => ({
  fetchSnapshot: vi.fn<() => Promise<unknown>>(),
  close: vi.fn(),
  subscribe: vi.fn(),
  onChange: { current: null as (() => void) | null },
  onMissing: { current: null as (() => void) | null },
  onRestored: { current: null as (() => void) | null },
}));

interface SubscriptionHandlers {
  onChange: () => void;
  onWorkspaceMissing?: () => void;
  onWorkspaceRestored?: () => void;
}

vi.mock('./api.js', () => ({
  getToken: () => 'test-token',
  fetchSnapshot: mocks.fetchSnapshot,
  subscribeToChanges: (handlers: SubscriptionHandlers) => {
    mocks.onChange.current = handlers.onChange;
    mocks.onMissing.current = handlers.onWorkspaceMissing ?? null;
    mocks.onRestored.current = handlers.onWorkspaceRestored ?? null;
    mocks.subscribe(handlers);
    return { close: mocks.close };
  },
}));

const HEALTH = {
  findings: [{ severity: 'info', code: 'SETUP_DRIFT', message: 'artifact missing' }],
  summary: { ok: true, info: 1, warn: 0, error: 0, workspace: '/repo/.crew' },
};

function agent(id: string, overrides: Partial<AgentSnapshotRecord> = {}): AgentSnapshotRecord {
  return {
    type: 'agent',
    schema_version: 1,
    id,
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
      agent_id: id,
      unread_count: 3,
      max_unread_id: 9,
    },
    ...overrides,
  };
}

function task(id: string, title: string): TaskSnapshotRecord {
  return {
    type: 'task',
    schema_version: 1,
    id,
    title,
    body: 'brief',
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
    created_at: 1,
    updated_at: 1,
    stale_lease: false,
    events: [],
  };
}

function message(id: number, content: string): MessageSnapshotRecord {
  return {
    type: 'message',
    schema_version: 1,
    id,
    sender_id: 'manager-1',
    recipient_id: 'operator',
    content,
    kind: 'note',
    task_id: null,
    reply_to: null,
    created_at: 5,
    read_at: null,
  };
}

function snapshotOf(tasks: TaskSnapshotRecord[]): WorkspaceSnapshot {
  return {
    agents: [agent('manager-1')],
    tasks,
    messages: [message(1, 'hello from the manager')],
  };
}

interface PostRecord {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** Route fetch by URL/method: GET health/sessions return fixtures; POSTs are recorded. */
function stubFetch(
  sessions: readonly SessionSnapshotRecord[] = [],
  resumableSessions: readonly ResumableSessionSnapshotRecord[] = [],
): PostRecord[] {
  const posts: PostRecord[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') {
        const parsed = init.body
          ? (JSON.parse(init.body as string) as Record<string, unknown>)
          : {};
        posts.push({ url, body: parsed });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) } as Response);
      }
      if (url.includes('/api/sessions')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, sessions }),
        } as unknown as Response);
      }
      if (url.includes('/api/resumable-sessions')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, resumable_sessions: resumableSessions }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(HEALTH),
      } as unknown as Response);
    }),
  );
  return posts;
}

function mount(): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(<App />, host);
  return host;
}

function unmount(host: HTMLDivElement): void {
  render(null, host);
  host.remove();
}

/** Click the sidebar nav button whose label matches. */
function navigate(host: HTMLElement, label: string): void {
  const button = [...host.querySelectorAll<HTMLButtonElement>('.nav-item')].find((b) =>
    b.textContent?.includes(label),
  );
  button?.click();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.onChange.current = null;
  mocks.onMissing.current = null;
  mocks.onRestored.current = null;
  document.body.innerHTML = '';
});

describe('App shell', () => {
  it('fetches on mount and renders Now (the default view) with the unread-message worklist', async () => {
    stubFetch();
    mocks.fetchSnapshot.mockResolvedValue(snapshotOf([task('t-1', 'Ship the widget')]));
    const host = mount();

    await vi.waitFor(() => {
      expect(host.textContent).toContain('manager-1');
    });
    expect(host.querySelector('.sidebar')).not.toBeNull();
    expect(host.querySelector('h1')?.textContent).toBe('Now');
    expect(host.textContent).toContain('Reply to manager-1'); // the unread-message work item
    expect(mocks.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.subscribe).toHaveBeenCalledTimes(1);

    navigate(host, 'Overview');
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('Overview'));
    expect(host.textContent).toContain('/repo/.crew'); // operator card workspace label
    expect(host.querySelector('.roster-row')?.textContent).toContain('manager-1');
    unmount(host);
  });

  it('navigates between the six views from the sidebar', async () => {
    stubFetch();
    mocks.fetchSnapshot.mockResolvedValue(snapshotOf([task('t-1', 'Ship the widget')]));
    const host = mount();
    await vi.waitFor(() => expect(host.textContent).toContain('manager-1'));
    expect(host.querySelector('h1')?.textContent).toBe('Now');

    navigate(host, 'Tasks');
    await vi.waitFor(() => expect(host.textContent).toContain('Ship the widget'));
    expect(host.querySelector('h1')?.textContent).toBe('Tasks');

    navigate(host, 'Messages');
    await vi.waitFor(() => expect(host.textContent).toContain('hello from the manager'));

    navigate(host, 'Agents');
    await vi.waitFor(() => expect(host.textContent).toContain('3 unread'));

    navigate(host, 'Operations');
    await vi.waitFor(() => expect(host.textContent).toContain('artifact missing'));
    expect(host.textContent).toContain('Maintenance');
    unmount(host);
  });

  it('refetches on an SSE change and closes the subscription on unmount', async () => {
    stubFetch();
    mocks.fetchSnapshot.mockResolvedValue(snapshotOf([task('t-1', 'First')]));
    const host = mount();
    await vi.waitFor(() => expect(host.textContent).toContain('manager-1'));
    navigate(host, 'Agents');
    await vi.waitFor(() => expect(host.textContent).toContain('manager-1'));

    mocks.fetchSnapshot.mockResolvedValue({
      agents: [agent('linus-2')],
      tasks: [],
      messages: [],
    });
    mocks.onChange.current!();
    await vi.waitFor(() => expect(host.textContent).toContain('linus-2'));
    expect(mocks.fetchSnapshot).toHaveBeenCalledTimes(2);

    expect(mocks.close).not.toHaveBeenCalled();
    unmount(host);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('shows the honest error state and recovers on the next successful fetch', async () => {
    stubFetch();
    mocks.fetchSnapshot.mockRejectedValue(new Error('boom'));
    const host = mount();
    await vi.waitFor(() => expect(host.textContent).toContain('snapshot fetch failed'));

    mocks.fetchSnapshot.mockResolvedValue(snapshotOf([task('t-1', 'Recovered')]));
    mocks.onChange.current!();
    await vi.waitFor(() => expect(host.textContent).toContain('manager-1'));
    expect(host.textContent).not.toContain('snapshot fetch failed');
    unmount(host);
  });
});

describe('App actions', () => {
  it('opens the quick-message modal from a roster row and sends a message', async () => {
    const posts = stubFetch();
    mocks.fetchSnapshot.mockResolvedValue(snapshotOf([]));
    const host = mount();
    await vi.waitFor(() => expect(host.textContent).toContain('manager-1'));
    navigate(host, 'Overview');
    await vi.waitFor(() => expect(host.querySelector('.roster-row')).not.toBeNull());

    // Click the roster row → opens the quick-message modal pre-addressed to manager-1.
    (host.querySelector('.roster-row') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(host.querySelector('.message-modal')).not.toBeNull());
    expect(host.querySelector('.message-modal')?.textContent).toContain('manager-1');
    // The Messages tab's own compose is untouched by this flow.
    expect(host.querySelector('#compose-recipient')).toBeNull();

    const textarea = host.querySelector('.message-modal textarea') as HTMLTextAreaElement;
    textarea.value = 'ping';
    textarea.dispatchEvent(new Event('input'));
    // Let the controlled-input state commit before the send reads it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const send = [...host.querySelectorAll('.message-modal button')].find((b) =>
      b.textContent?.includes('Send message'),
    ) as HTMLButtonElement;
    send.click();

    await vi.waitFor(() => {
      expect(posts.some((p) => p.url.includes('/api/messages'))).toBe(true);
    });
    const post = posts.find((p) => p.url.includes('/api/messages'))!;
    expect(post.body).toEqual({ to: 'manager-1', content: 'ping' });
    // The modal closes and a refetch follows the completed POST.
    await vi.waitFor(() => expect(host.querySelector('.message-modal')).toBeNull());
    expect(mocks.fetchSnapshot.mock.calls.length).toBeGreaterThan(1);
    unmount(host);
  });

  it('cancels the quick-message modal without sending', async () => {
    const posts = stubFetch();
    mocks.fetchSnapshot.mockResolvedValue(snapshotOf([]));
    const host = mount();
    await vi.waitFor(() => expect(host.textContent).toContain('manager-1'));
    navigate(host, 'Overview');
    await vi.waitFor(() => expect(host.querySelector('.roster-row')).not.toBeNull());

    (host.querySelector('.roster-row') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(host.querySelector('.message-modal')).not.toBeNull());
    const cancel = [...host.querySelectorAll('.message-modal button')].find(
      (b) => b.textContent === 'Cancel',
    ) as HTMLButtonElement;
    cancel.click();
    await vi.waitFor(() => expect(host.querySelector('.message-modal')).toBeNull());
    expect(posts.some((p) => p.url.includes('/api/messages'))).toBe(false);
    unmount(host);
  });

  it('toggles the light/dark theme and persists it across a remount', async () => {
    stubFetch();
    mocks.fetchSnapshot.mockResolvedValue(snapshotOf([]));
    localStorage.clear();
    const host = mount();
    await vi.waitFor(() => expect(host.textContent).toContain('manager-1'));
    expect(document.documentElement.dataset['theme']).toBe('light');

    (host.querySelector('.theme-toggle') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.documentElement.dataset['theme']).toBe('dark'));
    expect(localStorage.getItem('crew-console-theme')).toBe('dark');

    unmount(host);
    const host2 = mount();
    await vi.waitFor(() => expect(host2.textContent).toContain('manager-1'));
    expect(document.documentElement.dataset['theme']).toBe('dark');
    unmount(host2);
    localStorage.clear();
    document.documentElement.dataset['theme'] = 'light';
  });

  it('archives an agent through the one-click confirm and restores it with no confirmation', async () => {
    const posts = stubFetch();
    mocks.fetchSnapshot.mockResolvedValue(snapshotOf([]));
    const host = mount();
    await vi.waitFor(() => expect(host.textContent).toContain('manager-1'));

    navigate(host, 'Agents');
    await vi.waitFor(() => expect(host.querySelector('.btn-archive')).not.toBeNull());
    (host.querySelector('.btn-archive') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain('Archive agent'),
    );
    (host.querySelector('.btn-confirm') as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(posts.some((p) => p.url.includes('/api/agents/manager-1/archive'))).toBe(true),
    );
    expect(posts.find((p) => p.url.includes('/archive'))!.body).toEqual({ confirm: true });
    await vi.waitFor(() => expect(host.querySelector('[role="alertdialog"]')).toBeNull());

    // Restoring an already-archived agent's card is a no-confirm, single-click flow.
    // Archived agents are hidden by default — reveal via the toggle first.
    mocks.fetchSnapshot.mockResolvedValue({
      ...snapshotOf([]),
      agents: [agent('manager-1', { status: 'archived', activity: 'archived' })],
    });
    mocks.onChange.current!();
    await vi.waitFor(() => expect(host.querySelector('.archived-toggle')).not.toBeNull());
    (host.querySelector('.archived-toggle') as HTMLButtonElement).click();
    // Archive/restore is an icon-only button — the label lives in `title`, not textContent.
    await vi.waitFor(() =>
      expect(host.querySelector('.btn-archive')?.getAttribute('title')).toBe('Restore manager-1'),
    );
    (host.querySelector('.btn-archive') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(posts.some((p) => p.url.includes('/api/agents/manager-1/restore'))).toBe(true),
    );
    expect(posts.find((p) => p.url.includes('/restore'))!.body).toEqual({});
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    unmount(host);
  });

  it('runs a one-click destructive confirm for prune', async () => {
    const posts = stubFetch();
    mocks.fetchSnapshot.mockResolvedValue(snapshotOf([]));
    const host = mount();
    await vi.waitFor(() => expect(host.textContent).toContain('manager-1'));

    navigate(host, 'Operations');
    await vi.waitFor(() => expect(host.textContent).toContain('Maintenance'));
    const prune = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Prune…');
    prune!.click();

    await vi.waitFor(() =>
      expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain('Prune'),
    );
    (host.querySelector('.btn-confirm') as HTMLButtonElement).click();

    await vi.waitFor(() => expect(posts.some((p) => p.url.includes('/api/prune'))).toBe(true));
    expect(posts.find((p) => p.url.includes('/api/prune'))!.body).toEqual({ confirm: true });
    // The modal closes after success.
    await vi.waitFor(() => expect(host.querySelector('[role="alertdialog"]')).toBeNull());
    unmount(host);
  });

  it('lists live sessions in Operations and offers stop-with-confirm', async () => {
    const posts = stubFetch([
      {
        type: 'session',
        schema_version: 1,
        session_name: 'crew-dev',
        pane_count: 5,
        agent_count: 4,
        started_at: 0,
      },
    ]);
    mocks.fetchSnapshot.mockResolvedValue(snapshotOf([]));
    const host = mount();
    await vi.waitFor(() => expect(host.textContent).toContain('manager-1'));

    navigate(host, 'Operations');
    await vi.waitFor(() => expect(host.textContent).toContain('crew-dev'));
    expect(host.textContent).toContain('5 panes');

    (host.querySelector('.session-stop') as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain('Stop session'),
    );
    (host.querySelector('.btn-confirm') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(posts.some((p) => p.url.includes('/api/team/stop'))).toBe(true));
    expect(posts.find((p) => p.url.includes('/api/team/stop'))!.body).toEqual({
      session: 'crew-dev',
      confirm: true,
    });
    unmount(host);
  });

  it('keeps honest idle labels on Launch and Stop while recovering', async () => {
    stubFetch([
      {
        type: 'session',
        schema_version: 1,
        session_name: 'crew-dev',
        pane_count: 5,
        agent_count: 4,
        started_at: 0,
      },
    ]);
    mocks.fetchSnapshot.mockResolvedValue(snapshotOf([]));
    const host = mount();
    await vi.waitFor(() => expect(host.textContent).toContain('manager-1'));

    navigate(host, 'Operations');
    await vi.waitFor(() => expect(host.textContent).toContain('crew-dev'));

    mocks.onMissing.current!();
    await vi.waitFor(() => expect(host.textContent).toContain('Workspace unavailable'));

    // Workspace-missing recovery disables the team controls but must never
    // claim an operation is in flight: the disable-reason (recovering) stays
    // separate from the busy label, matching the Maintenance buttons.
    const launch = host.querySelector('.launch-row .btn-primary') as HTMLButtonElement;
    expect(launch.disabled).toBe(true);
    expect(launch.textContent).toBe('Launch');
    expect(launch.textContent).not.toContain('Working');
    const stop = host.querySelector('.session-stop') as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    expect(stop.textContent).toBe('Stop');
    unmount(host);
  });

  it('disables actions and shows the recovery banner while the workspace is missing', async () => {
    stubFetch();
    mocks.fetchSnapshot.mockResolvedValue(snapshotOf([]));
    const host = mount();
    await vi.waitFor(() => expect(host.textContent).toContain('manager-1'));

    mocks.onMissing.current!();
    await vi.waitFor(() => expect(host.textContent).toContain('Workspace unavailable'));

    navigate(host, 'Operations');
    await vi.waitFor(() => expect(host.textContent).toContain('Maintenance'));
    const prune = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Prune…',
    ) as HTMLButtonElement;
    expect(prune.disabled).toBe(true);
    unmount(host);
  });
});
