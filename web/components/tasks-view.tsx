/**
 * Tasks view: the reviewed-work board (five honest status columns, including a
 * real, selectable Abandoned column) beside a sticky detail panel
 * with the FR-U16/U17 approve and requeue controls. A submitted Task is shown
 * as "In review" — a Submission awaiting its reviewer, never as done. The POST
 * itself is delegated to the App via async callbacks; this component owns only
 * the board/detail render and the requeue draft.
 */
import { useEffect, useState } from 'preact/hooks';
import type { TaskSnapshotRecord } from '../types.js';
import {
  ACCENT,
  canApprove,
  canRequeue,
  describeEvent,
  initials,
  leaseView,
  relTime,
  roleColor,
  shortId,
  statusMeta,
} from '../view-model.js';

interface ColumnDef {
  readonly status: TaskSnapshotRecord['status'];
  readonly label: string;
}

const COLUMNS: readonly ColumnDef[] = [
  { status: 'queued', label: 'Queued' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'submitted', label: 'In review' },
  { status: 'completed', label: 'Completed' },
  { status: 'abandoned', label: 'Abandoned' },
];

export interface RecipientOption {
  readonly id: string;
  readonly label: string;
}

export interface TasksViewProps {
  readonly tasks: readonly TaskSnapshotRecord[];
  readonly selectedId: string | null;
  readonly now: number;
  readonly disabled: boolean;
  readonly recipientOptions: readonly RecipientOption[];
  readonly onSelect: (taskId: string) => void;
  readonly onApprove: (taskId: string) => Promise<void>;
  readonly onRequeue: (taskId: string, input: { reason: string; to?: string }) => Promise<void>;
}

export function TasksView({
  tasks,
  selectedId,
  now,
  disabled,
  recipientOptions,
  onSelect,
  onApprove,
  onRequeue,
}: TasksViewProps) {
  const selected = tasks.find((task) => task.id === selectedId) ?? null;
  const [reason, setReason] = useState('');
  const [to, setTo] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the requeue draft whenever the selection changes.
  useEffect(() => {
    setReason('');
    setTo('');
    setError(null);
  }, [selectedId]);

  async function approve(taskId: string): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await onApprove(taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approve failed');
    } finally {
      setPending(false);
    }
  }

  async function requeue(taskId: string): Promise<void> {
    if (reason.trim() === '') {
      setError('A reason is required to requeue.');
      return;
    }
    setPending(true);
    setError(null);
    const trimmedTo = to.trim();
    try {
      await onRequeue(taskId, {
        reason: reason.trim(),
        ...(trimmedTo !== '' ? { to: trimmedTo } : {}),
      });
      setReason('');
      setTo('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Requeue failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <div class="tasks-layout">
      <div class="board-scroll">
        <div class="board">
          {COLUMNS.map((column) => {
            const list = tasks.filter((task) => task.status === column.status);
            const meta = statusMeta(column.status);
            return (
              <section key={column.status} data-status={column.status}>
                <div class="column-head">
                  <span class="dot-sm" style={{ background: meta.dot }} />
                  <span class="column-label">{column.label}</span>
                  <span class="column-count">{list.length}</span>
                </div>
                <div class="column-cards">
                  {list.length === 0 ? (
                    <div class="column-empty">Empty</div>
                  ) : (
                    list.map((task) => (
                      <button
                        type="button"
                        key={task.id}
                        class={`task-card${task.id === selectedId ? ' selected' : ''}`}
                        aria-pressed={task.id === selectedId}
                        onClick={() => onSelect(task.id)}
                      >
                        <div class="task-card-top">
                          <span class="task-id">{shortId(task.id)}</span>
                          {task.stale_lease && <span class="stale-tag">STALE</span>}
                        </div>
                        <div class="task-card-title">{task.title}</div>
                        <div class="task-card-foot">
                          <span class="avatar" style={{ background: roleColor('worker') }}>
                            {initials(task.assignee_id)}
                          </span>
                          <span class="task-card-assignee">{task.assignee_id}</span>
                          <span class="task-card-updated">{relTime(task.updated_at, now)}</span>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      <div class="detail">
        {selected === null ? (
          <div class="detail-empty">
            <div class="glyph">
              <svg
                width="20"
                height="20"
                viewBox="0 0 18 18"
                fill="none"
                stroke="#b0b6bf"
                stroke-width="1.6"
              >
                <rect x="2.5" y="2.5" width="13" height="13" rx="2.5" />
                <path d="M5.5 6.5h7M5.5 9h7M5.5 11.5h4.5" />
              </svg>
            </div>
            <p>Select a task to view its detail and act on it.</p>
          </div>
        ) : (
          <TaskDetail
            task={selected}
            now={now}
            disabled={disabled}
            pending={pending}
            error={error}
            reason={reason}
            to={to}
            recipientOptions={recipientOptions}
            onReason={setReason}
            onTo={setTo}
            onApprove={() => void approve(selected.id)}
            onRequeue={() => void requeue(selected.id)}
          />
        )}
      </div>
    </div>
  );
}

interface TaskDetailProps {
  readonly task: TaskSnapshotRecord;
  readonly now: number;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly reason: string;
  readonly to: string;
  readonly recipientOptions: readonly RecipientOption[];
  readonly onReason: (value: string) => void;
  readonly onTo: (value: string) => void;
  readonly onApprove: () => void;
  readonly onRequeue: () => void;
}

function TaskDetail({
  task,
  now,
  disabled,
  pending,
  error,
  reason,
  to,
  recipientOptions,
  onReason,
  onTo,
  onApprove,
  onRequeue,
}: TaskDetailProps) {
  const meta = statusMeta(task.status);
  const lease = leaseView(task, now);
  const approvable = canApprove(task);
  const requeueable = canRequeue(task);
  const events = task.events.slice().reverse();

  return (
    <div>
      <div class="detail-head">
        <div class="detail-top">
          <span class="detail-id">{shortId(task.id)}</span>
          <span class="pill" style={{ background: meta.bg, color: meta.fg }}>
            {meta.label}
          </span>
        </div>
        <h2 class="detail-title">{task.title}</h2>
        {task.body !== '' && <p class="detail-body">{task.body}</p>}
      </div>

      <div class="detail-facts">
        <div>
          <div class="section-label">Assignee</div>
          <div class="detail-fact-value">{task.assignee_id}</div>
        </div>
        <div>
          <div class="section-label">Reviewer</div>
          <div class="detail-fact-value">{task.reviewer_id}</div>
        </div>
        <div>
          <div class="section-label">Creator</div>
          <div class="detail-fact-value">{task.creator_id}</div>
        </div>
        <div>
          <div class="section-label">Lease</div>
          <div class="detail-fact-value" style={{ color: lease.color }}>
            {lease.label}
          </div>
        </div>
      </div>

      {task.submission_summary !== null && (
        <div class="submission">
          <div class="section-label">Submission summary</div>
          <p>{task.submission_summary}</p>
        </div>
      )}

      <div class="timeline">
        <div class="section-label timeline-label">Timeline</div>
        {events.map((event, index) => (
          <div class="tl-row" key={event.id}>
            <div class="tl-rail">
              <span class="dot-sm" style={{ background: statusMeta(event.to_status).dot }} />
              {index < events.length - 1 && <span class="tl-line" />}
            </div>
            <div>
              <div class="tl-text">
                <span class="actor">{event.actor_id}</span> {describeEvent(event, task.id)}
              </div>
              <div class="tl-rel">{relTime(event.created_at, now)}</div>
            </div>
          </div>
        ))}
      </div>

      <div class="detail-actions">
        {error !== null && (
          <p class="modal-error" role="alert" style={{ margin: '0 0 10px' }}>
            {error}
          </p>
        )}
        {approvable && (
          <button
            type="button"
            class="btn btn-primary"
            style={{ width: '100%', background: ACCENT, marginBottom: requeueable ? '10px' : '0' }}
            disabled={pending || disabled}
            onClick={onApprove}
          >
            {pending ? 'Working…' : 'Approve — complete task'}
          </button>
        )}
        {requeueable && (
          <div class="requeue-box">
            <div class="label">Requeue this task</div>
            <input
              class="input"
              value={reason}
              onInput={(e) => onReason((e.target as HTMLInputElement).value)}
              placeholder="Reason (required)"
              disabled={pending || disabled}
              aria-label="Requeue reason"
            />
            <select
              class="select"
              value={to}
              onChange={(e) => onTo((e.target as HTMLSelectElement).value)}
              disabled={pending || disabled}
              aria-label="Reassign to agent"
            >
              <option value="">Keep assignee ({task.assignee_id})</option>
              {recipientOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  Reassign to {option.id}
                </option>
              ))}
            </select>
            <button
              type="button"
              class="btn-requeue"
              disabled={pending || disabled}
              onClick={onRequeue}
            >
              {pending ? 'Working…' : 'Requeue task'}
            </button>
          </div>
        )}
        {!approvable && !requeueable && (
          <div class="readonly-note">
            You are not the reviewer or creator on this task — view only.
          </div>
        )}
      </div>
    </div>
  );
}
