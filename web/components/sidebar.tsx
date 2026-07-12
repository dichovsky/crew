/**
 * Left navigation rail (design "aside"): brand, the five view links with their
 * live badges (agent count, review-queue count, unread count, attention dot),
 * the "listening for changes" indicator, and the operator identity card. Pure
 * render — the App owns the active view and the counts.
 */
import type { JSX } from 'preact';

export type ViewId = 'overview' | 'agents' | 'tasks' | 'messages' | 'operations';

export interface SidebarProps {
  readonly view: ViewId;
  readonly onNavigate: (view: ViewId) => void;
  readonly agentCount: number;
  readonly reviewCount: number;
  readonly unreadCount: number;
  readonly needsAttention: boolean;
  readonly workspaceLabel: string;
}

interface NavDef {
  readonly id: ViewId;
  readonly label: string;
  readonly icon: JSX.Element;
}

const icon = (children: JSX.Element): JSX.Element => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 18 18"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
  >
    {children}
  </svg>
);

const NAV: readonly NavDef[] = [
  {
    id: 'overview',
    label: 'Overview',
    icon: icon(
      <>
        <rect x="2" y="2" width="6" height="6" rx="1.5" />
        <rect x="10" y="2" width="6" height="6" rx="1.5" />
        <rect x="2" y="10" width="6" height="6" rx="1.5" />
        <rect x="10" y="10" width="6" height="6" rx="1.5" />
      </>,
    ),
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: icon(
      <>
        <circle cx="6.5" cy="6" r="2.6" />
        <circle cx="12.5" cy="7.5" r="2" />
        <path d="M2 15c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" />
        <path d="M11.5 15c0-1.6.8-2.9 2-3.4" />
      </>,
    ),
  },
  {
    id: 'tasks',
    label: 'Tasks',
    icon: icon(
      <>
        <rect x="2.5" y="2.5" width="13" height="13" rx="2.5" />
        <path d="M5.5 6.5h7M5.5 9h7M5.5 11.5h4.5" />
      </>,
    ),
  },
  {
    id: 'messages',
    label: 'Messages',
    icon: icon(
      <path d="M3 4.5h12a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 15 13.5H7l-3.5 2.5V13.5A1.5 1.5 0 0 1 2 12V6A1.5 1.5 0 0 1 3 4.5Z" />,
    ),
  },
  {
    id: 'operations',
    label: 'Operations',
    icon: icon(
      <>
        <path d="M2.5 5.5h9M2.5 12.5h6" />
        <circle cx="13.5" cy="5.5" r="2" />
        <circle cx="10.5" cy="12.5" r="2" />
      </>,
    ),
  },
];

export function Sidebar({
  view,
  onNavigate,
  agentCount,
  reviewCount,
  unreadCount,
  needsAttention,
  workspaceLabel,
}: SidebarProps) {
  return (
    <aside class="sidebar">
      <div class="sidebar-brand">
        <div class="brand-mark">
          <span />
        </div>
        <div>
          <div class="brand-name">crew</div>
          <div class="brand-sub">console</div>
        </div>
      </div>

      <nav class="nav" aria-label="Primary">
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            class="nav-item"
            aria-current={view === item.id ? 'page' : undefined}
            onClick={() => onNavigate(item.id)}
          >
            {item.icon}
            <span class="nav-label">{item.label}</span>
            {item.id === 'overview' && needsAttention && (
              <span class="nav-dot" aria-label="needs attention" />
            )}
            {item.id === 'agents' && <span class="nav-count">{agentCount}</span>}
            {item.id === 'tasks' && reviewCount > 0 && (
              <span class="nav-badge review" aria-label={`${reviewCount} awaiting review`}>
                {reviewCount}
              </span>
            )}
            {item.id === 'messages' && unreadCount > 0 && (
              <span class="nav-badge unread" aria-label={`${unreadCount} unread`}>
                {unreadCount}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div class="sidebar-spacer" />

      <div class="sidebar-foot">
        <div class="listening" role="status">
          <span class="dot" />
          <span>Listening for changes</span>
        </div>
        <div class="operator-card">
          <div class="avatar">OP</div>
          <div style={{ minWidth: 0 }}>
            <div class="name">operator</div>
            <div class="path" title={workspaceLabel}>
              {workspaceLabel}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
