/**
 * Operations tests: Teams (launch validation + the live session list with
 * owned-stop), the maintenance triggers, and that pane peek and health render.
 */
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResumableSessionSnapshotRecord } from '../types.js';
import type { SessionSnapshotRecord } from '../types.js';
import type { HealthState } from './health.js';
import { Operations } from './operations';

vi.mock('../api.js', () => ({ getToken: () => 'test-token' }));

const HEALTH: HealthState = {
  findings: [{ severity: 'warn', code: 'STALE_LEASE', message: 'rob holds an expired lease' }],
  summary: { ok: false, info: 0, warn: 1, error: 0, workspace: '/repo/.crew' },
};

interface Opts {
  sessions?: readonly SessionSnapshotRecord[];
  resumableSessions?: readonly ResumableSessionSnapshotRecord[];
  onLaunch?: (team: string) => Promise<void>;
  onRequestResume?: (session: string) => Promise<void>;
  onRequestStop?: (session: string) => void;
  onRequestPrune?: () => void;
  onRequestClean?: () => void;
}

function mount(opts: Opts = {}): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(
    <Operations
      sessions={opts.sessions ?? []}
      resumableSessions={opts.resumableSessions ?? []}
      health={HEALTH}
      now={0}
      dark={false}
      disabled={false}
      onLaunch={opts.onLaunch ?? (() => Promise.resolve())}
      onRequestResume={opts.onRequestResume ?? (() => Promise.resolve())}
      onRequestStop={opts.onRequestStop ?? (() => {})}
      onRequestPrune={opts.onRequestPrune ?? (() => {})}
      onRequestClean={opts.onRequestClean ?? (() => {})}
    />,
    host,
  );
  return host;
}

function byText(host: HTMLElement, text: string): Element | undefined {
  return [...host.querySelectorAll('button')].find((b) => b.textContent === text);
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Operations', () => {
  it('shows an empty note when no sessions are running', () => {
    const host = mount({ sessions: [] });
    expect(host.textContent).toContain('No sessions running.');
  });

  it('lists a live session and stops it by name', () => {
    const onRequestStop = vi.fn();
    const host = mount({
      sessions: [
        {
          type: 'session',
          schema_version: 1,
          session_name: 'crew-dev',
          pane_count: 5,
          agent_count: 4,
          started_at: 0,
        },
      ],
      onRequestStop,
    });
    const row = host.querySelector('.session-row')!;
    expect(row.textContent).toContain('crew-dev');
    expect(row.textContent).toContain('5 panes');
    host.querySelector('.session-stop')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onRequestStop).toHaveBeenCalledWith('crew-dev');
  });

  it('triggers the maintenance confirmations', () => {
    const onRequestPrune = vi.fn();
    const onRequestClean = vi.fn();
    const host = mount({ onRequestPrune, onRequestClean });
    byText(host, 'Prune…')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    byText(host, 'Clean…')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onRequestPrune).toHaveBeenCalled();
    expect(onRequestClean).toHaveBeenCalled();
  });

  it('lists resumable sessions and resumes them by name', () => {
    const onRequestResume = vi.fn(() => Promise.resolve());
    const host = mount({
      resumableSessions: [
        {
          type: 'resumable_session',
          schema_version: 1,
          session_name: 'crew-resume',
          team: 'dev',
          stopped_at: 10,
          agents_archived: 4,
        },
      ],
      onRequestResume,
    });
    expect(host.textContent).toContain('Resumable sessions');
    expect(host.textContent).toContain('crew-resume');
    byText(host, 'Resume')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onRequestResume).toHaveBeenCalledWith('crew-resume');
  });

  it('requires a team name and otherwise launches', async () => {
    const onLaunch = vi.fn(() => Promise.resolve());
    const host = mount({ onLaunch });
    const form = host.querySelector('form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(host.querySelector('.modal-error')?.textContent).toContain('team name'),
    );
    expect(onLaunch).not.toHaveBeenCalled();

    const input = host.querySelector('.launch-row .input') as HTMLInputElement;
    input.value = 'dev';
    input.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(input.value).toBe('dev'));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(onLaunch).toHaveBeenCalledWith('dev'));
  });

  it('renders pane peek and the health findings', () => {
    const host = mount();
    expect(host.textContent).toContain('Pane peek');
    expect(host.textContent).toContain('STALE_LEASE');
  });
});
