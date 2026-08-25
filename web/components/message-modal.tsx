/**
 * Quick-reply popup opened by clicking an Agent (roster row, Agent card, Now
 * worklist idle-agent item) — the design's message modal, replacing the
 * previous "jump to Messages tab" flow (FR-U14 authority unchanged; this is
 * presentation only). Accessibility mirrors confirm-dialog.tsx: focus moves
 * to the textarea on open and is trapped with Tab/Shift-Tab, Escape and a
 * backdrop click both cancel unless a send is pending, and focus restores to the opener on close
 * (falling back to `[data-focus-fallback]` when the opener can no longer
 * take focus). Stored content (the Agent id) renders through Preact's
 * default text escaping.
 */
import { useRef } from 'preact/hooks';
import { useDialogFocus } from './dialog-focus.js';

export interface MessageModalProps {
  /** The addressed Agent id, or `null` when the modal is closed. */
  readonly to: string | null;
  readonly text: string;
  /** Disables input and both buttons while the send POST is in flight. */
  readonly pending?: boolean;
  /** A bounded failure line shown above the textarea. */
  readonly error?: string | null;
  readonly onTextChange: (value: string) => void;
  readonly onClose: () => void;
  readonly onSend: () => void;
}

export function MessageModal({
  to,
  text,
  pending = false,
  error = null,
  onTextChange,
  onClose,
  onSend,
}: MessageModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const open = to !== null;

  useDialogFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: textareaRef,
    onDismiss: onClose,
    dismissDisabled: pending,
  });

  if (!open) return null;

  return (
    <div
      class="modal-backdrop"
      onClick={(e) => {
        if (pending) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-modal-title"
        tabIndex={-1}
        class="modal message-modal"
      >
        <div class="modal-head">
          <h3 id="message-modal-title">
            Message{' '}
            <span class="mono-id" style={{ color: 'var(--accent)' }}>
              {to}
            </span>
          </h3>
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
        <textarea
          ref={textareaRef}
          class="textarea"
          value={text}
          disabled={pending}
          placeholder={`Type a note to ${to ?? ''}…`}
          aria-label={`Message to ${to ?? ''}`}
          onInput={(e) => onTextChange((e.target as HTMLTextAreaElement).value)}
        />
        <div class="modal-actions" style={{ marginTop: '14px' }}>
          <button type="button" class="btn btn-ghost" disabled={pending} onClick={onClose}>
            Cancel
          </button>
          <button type="button" class="btn btn-primary" disabled={pending} onClick={onSend}>
            {pending ? 'Sending…' : 'Send message'}
          </button>
        </div>
      </div>
    </div>
  );
}
