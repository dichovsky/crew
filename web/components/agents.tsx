/**
 * Agents view: a card per Agent showing role, honest activity, engine
 * (platform) badge, last-seen, current Task, and inbox depth, with Message
 * and Archive/Restore actions (FR-U36) — never a permanent delete, which
 * crew has no backend capability for (ADR-0017). Activity labels stay
 * "Active"/"Idle"/"Stale"/"Archived" — never "online": crew cannot prove
 * liveness (ADR-0012 honest presentation). Archived Agents are dimmed and
 * hidden by default behind a local "show archived" toggle — the App already
 * sends the full roster (including archived) in the snapshot.
 */
import { useState } from 'preact/hooks';
import type { AgentSnapshotRecord, TaskSnapshotRecord } from '../types.js';
import {
  activityMeta,
  currentTaskFor,
  engineMeta,
  initials,
  OPERATOR_ID,
  relTime,
  roleColor,
  rolePillBg,
  rolePillColor,
  shortId,
} from '../view-model.js';

export interface AgentsProps {
  readonly agents: readonly AgentSnapshotRecord[];
  readonly tasks: readonly TaskSnapshotRecord[];
  readonly now: number;
  readonly dark: boolean;
  /** Disables Archive/Restore during FR-U32 recovery (the pre-existing Message action is unaffected). */
  readonly disabled: boolean;
  readonly onMessageAgent: (id: string) => void;
  readonly onArchiveAgent: (id: string) => void;
  readonly onRestoreAgent: (id: string) => void;
}

export function Agents({
  agents,
  tasks,
  now,
  dark,
  disabled,
  onMessageAgent,
  onArchiveAgent,
  onRestoreAgent,
}: AgentsProps) {
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = agents.filter((a) => a.status === 'archived').length;
  const visible = showArchived ? agents : agents.filter((a) => a.status !== 'archived');

  return (
    <div class="view-wrap">
      {archivedCount > 0 && (
        <div class="agent-toolbar">
          <button
            type="button"
            class={`archived-toggle${showArchived ? ' active' : ''}`}
            onClick={() => setShowArchived((current) => !current)}
          >
            {showArchived ? 'Hide' : 'Show'} archived ({archivedCount})
          </button>
        </div>
      )}
      <div class="agent-grid">
        {visible.map((agent) => {
          const meta = activityMeta(agent.activity);
          const color = roleColor(agent.role);
          const pillColor = rolePillColor(agent.role, dark);
          const engine = engineMeta(agent.platform_id);
          const current = currentTaskFor(agent.id, tasks);
          const unread = agent.pending_summary.unread_count;
          const archived = agent.status === 'archived';
          return (
            <div
              class={`agent-card${archived ? ' archived' : ''}`}
              style={{ borderLeft: `3px solid ${engine.color}` }}
              key={agent.id}
            >
              <div class="agent-card-head">
                <span class="avatar" style={{ background: color }}>
                  {initials(agent.id)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div class="agent-card-id">{agent.id}</div>
                  <span
                    class="pill"
                    style={{ background: rolePillBg(pillColor, dark), color: pillColor }}
                  >
                    {agent.role}
                  </span>
                </div>
                <div class="activity-line">
                  <span
                    class={`dot-sm${agent.activity === 'recent' ? ' live' : ''}`}
                    style={{ background: meta.dot }}
                  />
                  <span class="activity-label" style={{ color: meta.color }}>
                    {meta.label}
                  </span>
                </div>
              </div>

              <div class="agent-card-engine">
                <span
                  class="engine-badge"
                  style={{
                    background: engine.bg,
                    color: engine.fg,
                    border: `1px solid ${engine.color}33`,
                  }}
                >
                  <span class="engine-glyph" style={{ background: engine.color }}>
                    {engine.glyph}
                  </span>
                  {engine.label}
                </span>
              </div>

              <div class="facts">
                <div class="fact">
                  <div class="fact-label">Platform</div>
                  <div class="fact-value">{agent.platform_id ?? '—'}</div>
                </div>
                <div class="fact">
                  <div class="fact-label">Last seen</div>
                  <div class="fact-value">{relTime(agent.last_seen, now)}</div>
                </div>
                <div class="fact">
                  <div class="fact-label">Current task</div>
                  <div class="fact-value" style={{ color: current ? '#181a1f' : '#b0b6bf' }}>
                    {current ? shortId(current.id) : '—'}
                  </div>
                </div>
                <div class="fact">
                  <div class="fact-label">Inbox</div>
                  <div class="fact-value">{unread > 0 ? `${unread} unread` : 'empty'}</div>
                </div>
              </div>

              <div class="agent-actions">
                <button
                  type="button"
                  class="btn btn-outline"
                  onClick={() => onMessageAgent(agent.id)}
                >
                  Message {agent.id}
                </button>
                {/* The operator's own row can never be archived (FR-U36) — a visible
                    control that can only ever fail is dishonest presentation, so it's
                    omitted entirely rather than shown disabled with no explanation. */}
                {agent.id !== OPERATOR_ID && (
                  <button
                    type="button"
                    class="btn-archive"
                    title={`${archived ? 'Restore' : 'Archive'} ${agent.id}`}
                    disabled={disabled}
                    onClick={() => (archived ? onRestoreAgent(agent.id) : onArchiveAgent(agent.id))}
                  >
                    {archived ? (
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 18 18"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.6"
                      >
                        <rect x="2.5" y="3" width="13" height="3.5" rx="1" />
                        <path d="M3.5 6.5v7a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-7M7 9.5h4" />
                      </svg>
                    ) : (
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 18 18"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.6"
                      >
                        <rect x="2.5" y="3" width="13" height="3.5" rx="1" />
                        <path d="M3.5 6.5v7a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-7" />
                        <path d="M7.5 9.5h3" />
                      </svg>
                    )}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
