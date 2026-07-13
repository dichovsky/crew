/**
 * Now view (FR-U37): a single prioritized worklist of everything needing the
 * Operator — stale-Lease Tasks, the review queue, idle Agents, and unread
 * Messages — each card routing to the same action already offered elsewhere
 * (select the Task, message the Agent, or open Messages). Pure render: the
 * items and their target routing come from `nowWorklist`; this component
 * only dispatches the click. Introduces no new data or authority.
 */
import { assertNever, pillBg, type WorkItem } from '../view-model.js';

export interface NowViewProps {
  readonly items: readonly WorkItem[];
  readonly dark: boolean;
  readonly onSelectTask: (taskId: string) => void;
  readonly onMessageAgent: (agentId: string) => void;
  readonly onOpenMessages: () => void;
}

function dispatch(target: WorkItem['target'], props: NowViewProps): void {
  switch (target.kind) {
    case 'task':
      props.onSelectTask(target.taskId);
      return;
    case 'agent':
      props.onMessageAgent(target.agentId);
      return;
    case 'messages':
      props.onOpenMessages();
      return;
    default:
      assertNever(target);
  }
}

export function NowView(props: NowViewProps) {
  const { items, dark } = props;

  if (items.length === 0) {
    return (
      <div class="now-wrap">
        <div class="now-empty">
          <div class="now-empty-icon">
            <svg
              width="24"
              height="24"
              viewBox="0 0 18 18"
              fill="none"
              stroke="#27a05f"
              stroke-width="1.8"
            >
              <path d="M4 9.5l3.2 3.2L14 6" />
            </svg>
          </div>
          <div class="now-empty-title">All clear</div>
          <div class="now-empty-desc">Nothing needs you right now. The crew is running clean.</div>
        </div>
      </div>
    );
  }

  return (
    <div class="now-wrap">
      <div class="now-head">
        <h2>
          {items.length} thing{items.length === 1 ? '' : 's'} need you
        </h2>
        <span>Work top to bottom — the list clears as you go.</span>
      </div>
      <div class="now-list">
        {items.map((item) => (
          <div class="work-card" key={item.key}>
            <div class="work-bar" style={{ background: item.color }} />
            <div class="work-body">
              <span
                class="pill"
                style={{ background: pillBg(item.bg, item.color, dark), color: item.color }}
              >
                {item.label}
              </span>
              <div class="work-title">{item.title}</div>
              <div class="work-detail">{item.detail}</div>
            </div>
            <div class="work-action">
              <button
                type="button"
                style={{ background: item.color }}
                onClick={() => dispatch(item.target, props)}
              >
                {item.actionLabel}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
