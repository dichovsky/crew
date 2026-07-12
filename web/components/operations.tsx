/**
 * Operations view: Teams (detached launch + the live crew-owned session list
 * with owned-stop), pane peek, workspace Health, and Maintenance (prune/clean).
 * Launch and the maintenance/stop triggers are delegated to the App; the
 * destructive ones open the confirm modal there. The session list is real —
 * every row came from GET /api/sessions' ownership proof.
 */
import { useState } from 'preact/hooks';
import type { ResumableSessionSnapshotRecord, SessionSnapshotRecord } from '../types.js';
import { relTime } from '../view-model.js';
import { HealthList, type HealthState } from './health.js';
import { PeekView } from './peek-view.js';

export interface OperationsProps {
  readonly sessions: readonly SessionSnapshotRecord[];
  readonly resumableSessions: readonly ResumableSessionSnapshotRecord[];
  readonly health: HealthState | null;
  readonly now: number;
  readonly disabled: boolean;
  readonly onLaunch: (team: string) => Promise<void>;
  readonly onRequestResume: (session: string) => Promise<void>;
  readonly onRequestStop: (session: string) => void;
  readonly onRequestPrune: () => void;
  readonly onRequestClean: () => void;
}

export function Operations({
  sessions,
  resumableSessions,
  health,
  now,
  disabled,
  onLaunch,
  onRequestResume,
  onRequestStop,
  onRequestPrune,
  onRequestClean,
}: OperationsProps) {
  const [team, setTeam] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function launch(): Promise<void> {
    if (team.trim() === '') {
      setError('A team name is required.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onLaunch(team.trim());
      setTeam('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Launch failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <div class="ops-layout">
      <div class="col-stack">
        <div class="ops-card" aria-label="Teams">
          <h2>Teams</h2>
          <p class="ops-note">Launch a packaged team detached, or stop a session crew owns.</p>
          {error !== null && (
            <p class="modal-error" role="alert" style={{ margin: '0 0 12px' }}>
              {error}
            </p>
          )}
          <form
            class="launch-row"
            onSubmit={(e) => {
              e.preventDefault();
              void launch();
            }}
          >
            <input
              class="input"
              value={team}
              onInput={(e) => setTeam((e.target as HTMLInputElement).value)}
              placeholder="team name (e.g. dev)"
              disabled={pending || disabled}
              aria-label="Team name"
            />
            <button type="submit" class="btn btn-primary" disabled={pending || disabled}>
              {pending ? 'Working…' : 'Launch'}
            </button>
          </form>
          <div class="section-label" style={{ marginBottom: '9px' }}>
            Active sessions
          </div>
          {sessions.length === 0 ? (
            <div class="empty-state">No sessions running.</div>
          ) : (
            sessions.map((session) => (
              <div class="session-row" key={session.session_name}>
                <span class="dot-sm live" style={{ background: '#27a05f' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div class="name">{session.session_name}</div>
                  <div class="detail">
                    {session.pane_count} panes · started {relTime(session.started_at, now)}
                  </div>
                </div>
                <button
                  type="button"
                  class="session-stop"
                  disabled={disabled}
                  onClick={() => onRequestStop(session.session_name)}
                >
                  Stop
                </button>
              </div>
            ))
          )}
          <div class="section-label" style={{ margin: '16px 0 9px' }}>
            Resumable sessions
          </div>
          {resumableSessions.length === 0 ? (
            <div class="empty-state">No cleanly stopped sessions available.</div>
          ) : (
            resumableSessions.map((session) => (
              <div class="session-row" key={session.session_name}>
                <span class="dot-sm live" style={{ background: '#8b95a3' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div class="name">{session.session_name}</div>
                  <div class="detail">
                    {session.team} · stopped {relTime(session.stopped_at, now)} ·{' '}
                    {session.agents_archived} archived
                  </div>
                </div>
                <button
                  type="button"
                  class="session-stop"
                  disabled={disabled}
                  onClick={() => {
                    void onRequestResume(session.session_name);
                  }}
                >
                  Resume
                </button>
              </div>
            ))
          )}
        </div>

        <PeekView disabled={disabled} />
      </div>

      <div class="col-stack">
        <div class="ops-card" aria-label="Health">
          <h2 style={{ marginBottom: '12px' }}>Health</h2>
          {health === null ? (
            <p class="empty-state">Loading health…</p>
          ) : (
            <HealthList findings={health.findings} />
          )}
        </div>

        <div class="ops-card" aria-label="Maintenance">
          <h2>Maintenance</h2>
          <p class="ops-note">
            Prune deletes old read messages and finished tasks. Clean removes the State Store
            entirely. Both ask for confirmation.
          </p>
          <div class="maint-buttons">
            <button
              type="button"
              class="btn btn-ghost"
              disabled={disabled}
              onClick={onRequestPrune}
            >
              Prune…
            </button>
            <button
              type="button"
              class="btn btn-danger"
              disabled={disabled}
              onClick={onRequestClean}
            >
              Clean…
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
