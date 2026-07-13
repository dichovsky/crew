/**
 * Overview view: four headline stats, the live crew roster, the "needs
 * attention" list, and a merged recent-events feed. Pure render — every value
 * is derived from the real snapshot via view-model selectors. Clicking a
 * roster row opens the quick-message modal pre-addressed to that Agent.
 */
import type { AgentSnapshotRecord, TaskSnapshotRecord } from '../types.js';
import type { HealthState } from './health.js';
import {
  activityFeed,
  activityMeta,
  attentionItems,
  currentTaskFor,
  initials,
  pillBg,
  relTime,
  reviewQueue,
  roleColor,
  rolePillBg,
  rolePillColor,
  shortId,
  statusMeta,
} from '../view-model.js';

export interface OverviewProps {
  readonly agents: readonly AgentSnapshotRecord[];
  readonly tasks: readonly TaskSnapshotRecord[];
  readonly health: HealthState | null;
  readonly now: number;
  readonly dark: boolean;
  readonly onMessageAgent: (id: string) => void;
  readonly onGoAgents: () => void;
}

function subline(agent: AgentSnapshotRecord, tasks: readonly TaskSnapshotRecord[]): string {
  const current = currentTaskFor(agent.id, tasks);
  if (current) return `working on ${shortId(current.id)}`;
  if (agent.role === 'manager') return 'coordinating the crew';
  if (agent.role === 'inspector') return 'reviewing submissions';
  return 'available';
}

export function Overview({
  agents,
  tasks,
  health,
  now,
  dark,
  onMessageAgent,
  onGoAgents,
}: OverviewProps) {
  const activeAgents = agents.filter((a) => a.activity === 'recent').length;
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
  const staleCount = tasks.filter((t) => t.stale_lease).length;
  const queue = reviewQueue(tasks);
  const attention = attentionItems(tasks, agents, now);
  const feed = activityFeed(tasks);
  const warn = health?.summary.warn ?? 0;
  const errorCount = health?.summary.error ?? 0;
  const healthOk = health?.summary.ok ?? true;

  const stats = [
    {
      label: 'Active agents',
      value: `${activeAgents}/${agents.length}`,
      sub: 'reporting recently',
      tag: 'live',
      tagBg: '#e6f4ec',
      tagFg: '#1f8a53',
    },
    {
      label: 'In progress',
      value: String(inProgress),
      sub: staleCount > 0 ? `${staleCount} with a stale lease` : 'all leases healthy',
      tag: 'tasks',
      tagBg: '#e8f1fd',
      tagFg: '#1f6fd6',
    },
    {
      label: 'Awaiting review',
      value: String(queue.length),
      sub: 'assigned to you',
      tag: 'you',
      tagBg: '#f3ecfb',
      tagFg: '#7c3fc4',
    },
    {
      label: 'Health',
      value: errorCount > 0 ? `${errorCount} error` : `${warn} warn`,
      sub: healthOk ? 'all checks passing' : `${health?.summary.info ?? 0} info notes`,
      tag: healthOk ? 'ok' : 'attention',
      tagBg: healthOk ? '#e6f4ec' : '#fbf1de',
      tagFg: healthOk ? '#1f8a53' : '#b07d14',
    },
  ];

  return (
    <div class="view-wrap">
      <div class="stat-grid">
        {stats.map((s) => (
          <div class="stat" key={s.label}>
            <div class="stat-top">
              <span class="stat-label">{s.label}</span>
              <span
                class="pill"
                style={{ background: pillBg(s.tagBg, s.tagFg, dark), color: s.tagFg }}
              >
                {s.tag}
              </span>
            </div>
            <div class="stat-value">{s.value}</div>
            <div class="stat-sub">{s.sub}</div>
          </div>
        ))}
      </div>

      <div class="overview-grid">
        <div class="card">
          <div class="card-head">
            <div>
              <div class="kicker">Live roster</div>
              <h2>Crew activity</h2>
            </div>
            <button type="button" class="link-btn" onClick={onGoAgents}>
              View all →
            </button>
          </div>
          {agents.map((agent) => {
            const meta = activityMeta(agent.activity);
            const color = roleColor(agent.role);
            const pillColor = rolePillColor(agent.role, dark);
            return (
              <button
                type="button"
                class="roster-row"
                key={agent.id}
                onClick={() => onMessageAgent(agent.id)}
              >
                <span class="avatar" style={{ background: color }}>
                  {initials(agent.id)}
                </span>
                <span class="roster-main">
                  <span class="id-line">
                    <span class="mono-id">{agent.id}</span>
                    <span
                      class="pill"
                      style={{ background: rolePillBg(pillColor, dark), color: pillColor }}
                    >
                      {agent.role}
                    </span>
                  </span>
                  <span class="subline">{subline(agent, tasks)}</span>
                </span>
                <span class="roster-right">
                  <span class="activity-line">
                    <span
                      class={`dot-sm${agent.activity === 'recent' ? ' live' : ''}`}
                      style={{ background: meta.dot }}
                    />
                    <span class="activity-label" style={{ color: meta.color }}>
                      {meta.label}
                    </span>
                  </span>
                  <span class="rel">{relTime(agent.last_seen, now)}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div class="side-col">
          <div class="card">
            <div class="mini-head">
              <span class="dot" style={{ background: '#d99a2b' }} />
              <h2>Needs attention</h2>
            </div>
            {attention.length === 0 ? (
              <div class="empty-note">All clear — nothing needs you right now.</div>
            ) : (
              attention.map((item, index) => (
                <div class="attn-item" key={`${index}:${item.title}`}>
                  <span class="dot" style={{ background: item.dot, marginTop: '4px' }} />
                  <div style={{ minWidth: 0 }}>
                    <div class="attn-title">{item.title}</div>
                    <div class="attn-detail">{item.detail}</div>
                  </div>
                </div>
              ))
            )}
          </div>

          <div class="card">
            <div class="card-head" style={{ display: 'block' }}>
              <div class="kicker">Activity</div>
              <h2 style={{ marginTop: '3px' }}>Recent events</h2>
            </div>
            <div class="events">
              {feed.length === 0 ? (
                <div class="empty-note" style={{ padding: '8px 0' }}>
                  No activity yet.
                </div>
              ) : (
                feed.map((event) => (
                  <div class="event-row" key={event.key}>
                    <span class="dot" style={{ background: statusMeta(event.toStatus).dot }} />
                    <div class="event-text">
                      <span class="actor">{event.actor}</span> {event.text}
                      <div class="event-rel">{relTime(event.createdAt, now)}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
