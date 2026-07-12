/**
 * Agents view: a card per Agent showing role, liveness, platform, last-seen,
 * current Task, and inbox depth, with a Message action. Pure render from the
 * snapshot; the current-Task fact is derived from the Task list. Activity
 * labels stay "Active"/"Idle"/"Stale"/"Archived" — never "online": crew cannot
 * prove liveness (ADR-0012 honest presentation).
 */
import type { AgentSnapshotRecord, TaskSnapshotRecord } from '../types.js';
import {
  activityMeta,
  currentTaskFor,
  initials,
  relTime,
  roleColor,
  shortId,
} from '../view-model.js';

export interface AgentsProps {
  readonly agents: readonly AgentSnapshotRecord[];
  readonly tasks: readonly TaskSnapshotRecord[];
  readonly now: number;
  readonly onMessageAgent: (id: string) => void;
}

export function Agents({ agents, tasks, now, onMessageAgent }: AgentsProps) {
  return (
    <div class="view-wrap">
      <div class="agent-grid">
        {agents.map((agent) => {
          const meta = activityMeta(agent.activity);
          const color = roleColor(agent.role);
          const current = currentTaskFor(agent.id, tasks);
          const unread = agent.pending_summary.unread_count;
          return (
            <div class="agent-card" key={agent.id}>
              <div class="agent-card-head">
                <span class="avatar" style={{ background: color }}>
                  {initials(agent.id)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div class="agent-card-id">{agent.id}</div>
                  <span class="pill" style={{ background: `${color}18`, color }}>
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
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
