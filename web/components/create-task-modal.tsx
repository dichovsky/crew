/**
 * Create-Task popup opened by the Tasks view's "New task" button (FR-U15, part
 * of the FR-U19 action surface). It collects the assignee, reviewer, title and
 * optional brief and delegates the POST to the App via `onCreate`; the creator
 * is the Operator row the server picks by itself, so the form never names an
 * actor. Assignee and reviewer are chosen from the snapshot roster, so the form
 * cannot post an id the Store has no Agent for. Accessibility mirrors
 * message-modal.tsx: focus moves to the title field on open and is trapped with
 * Tab/Shift-Tab, Escape and a backdrop click both cancel, and focus restores to
 * the opener on close (falling back to `[data-focus-fallback]`). The draft is
 * local and the Tasks view mounts this component only while the modal is open,
 * so every opening starts from an empty form.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { useDialogFocus } from './dialog-focus.js';
import type { RecipientOption } from './tasks-view.js';

/** The create-Task draft the App posts to `/api/tasks` (FR-U15). */
export interface CreateTaskInput {
  readonly assignee: string;
  readonly reviewer: string;
  readonly title: string;
  /** The Task brief; omitted when the Operator left it blank. */
  readonly body?: string;
}

export interface CreateTaskModalProps {
  readonly recipientOptions: readonly RecipientOption[];
  readonly onClose: () => void;
  readonly onCreate: (input: CreateTaskInput) => Promise<void>;
}

export function CreateTaskModal({ recipientOptions, onClose, onCreate }: CreateTaskModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [assignee, setAssignee] = useState('');
  const [reviewer, setReviewer] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasRecipients = recipientOptions.length > 0;

  useDialogFocus({
    open: true,
    containerRef: dialogRef,
    initialFocusRef: titleRef,
    onDismiss: onClose,
    dismissDisabled: pending,
  });

  // Snapshot-backed options can change while this modal is open. Reconcile
  // retained state so a removed or archived Agent is not silently held behind
  // a select that has visually fallen back to its placeholder.
  useEffect(() => {
    if (assignee !== '' && !recipientOptions.some((option) => option.id === assignee)) {
      setAssignee('');
    }
    if (reviewer !== '' && !recipientOptions.some((option) => option.id === reviewer)) {
      setReviewer('');
    }
  }, [assignee, recipientOptions, reviewer]);

  // Mirror only what keeps an obviously-invalid POST off the wire; every other
  // precondition (unknown or inactive Agent, self-review rules) stays server-side.
  async function create(): Promise<void> {
    const trimmedTitle = title.trim();
    if (trimmedTitle === '') {
      setError('A title is required.');
      return;
    }
    if (assignee === '') {
      setError('Pick an assignee.');
      return;
    }
    if (!recipientOptions.some((option) => option.id === assignee)) {
      setError('Pick an active assignee.');
      return;
    }
    if (reviewer === '') {
      setError('Pick a reviewer.');
      return;
    }
    if (!recipientOptions.some((option) => option.id === reviewer)) {
      setError('Pick an active reviewer.');
      return;
    }
    const trimmedBody = body.trim();
    setPending(true);
    setError(null);
    try {
      await onCreate({
        assignee,
        reviewer,
        title: trimmedTitle,
        ...(trimmedBody !== '' ? { body: trimmedBody } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
      setPending(false);
      return;
    }
    // Unmounts this modal — nothing below may touch its state.
    onClose();
  }

  return (
    <div
      class="modal-backdrop"
      onClick={(e) => {
        // Same guard as Escape: a backdrop click mid-create would lose the draft and
        // swallow the server's answer.
        if (pending) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-task-modal-title"
        tabIndex={-1}
        class="modal create-task-modal"
      >
        <div class="modal-head">
          <h3 id="create-task-modal-title">New task</h3>
          <button
            type="button"
            class="modal-close"
            disabled={pending}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {error !== null && (
          <p class="modal-error" role="alert">
            {error}
          </p>
        )}
        {!hasRecipients && (
          <p id="create-task-roster-empty" class="empty-action-note" role="status">
            No active Agents are available. Restore an Agent before creating a Task.
          </p>
        )}
        <label class="field-label" for="create-task-title">
          Title
        </label>
        <input
          ref={titleRef}
          id="create-task-title"
          class="input"
          value={title}
          disabled={pending}
          placeholder="What needs doing"
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
        />
        <label class="field-label" for="create-task-assignee">
          Assignee
        </label>
        <select
          id="create-task-assignee"
          class="select"
          value={recipientOptions.some((option) => option.id === assignee) ? assignee : ''}
          disabled={pending || !hasRecipients}
          aria-describedby={!hasRecipients ? 'create-task-roster-empty' : undefined}
          onChange={(e) => setAssignee((e.target as HTMLSelectElement).value)}
        >
          <option value="">{hasRecipients ? 'Select agent…' : 'No active agents available'}</option>
          {recipientOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <label class="field-label" for="create-task-reviewer">
          Reviewer
        </label>
        <select
          id="create-task-reviewer"
          class="select"
          value={recipientOptions.some((option) => option.id === reviewer) ? reviewer : ''}
          disabled={pending || !hasRecipients}
          aria-describedby={!hasRecipients ? 'create-task-roster-empty' : undefined}
          onChange={(e) => setReviewer((e.target as HTMLSelectElement).value)}
        >
          <option value="">{hasRecipients ? 'Select agent…' : 'No active agents available'}</option>
          {recipientOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <label class="field-label" for="create-task-body">
          Brief (optional)
        </label>
        <textarea
          id="create-task-body"
          class="textarea"
          value={body}
          disabled={pending}
          placeholder="Context the assignee needs…"
          onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
        />
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" disabled={pending} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            class="btn btn-primary"
            disabled={pending || !hasRecipients}
            onClick={() => void create()}
          >
            {pending ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </div>
    </div>
  );
}
