/**
 * Quick-reply popup opened by clicking an Agent (roster row, Agent card, Now
 * worklist idle-agent item) — the design's message modal, replacing the
 * previous "jump to Messages tab" flow (FR-U14 authority unchanged; this is
 * presentation only). Accessibility mirrors confirm-dialog.tsx: focus moves
 * to the textarea on open and is trapped with Tab/Shift-Tab, Escape and a
 * backdrop click both cancel, and focus restores to the opener on close
 * (falling back to `[data-focus-fallback]` when the opener can no longer
 * take focus). Stored content (the Agent id) renders through Preact's
 * default text escaping.
 */
import { useEffect, useRef } from 'preact/hooks';

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

/** Gather every focusable descendant for the focus-trap ring. */
function focusableNodes(container: HTMLElement): HTMLElement[] {
  const selectors =
    'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return [...container.querySelectorAll<HTMLElement>(selectors)].filter((el) => el.tabIndex !== -1);
}

/** Restore focus to the opener on close, falling back to the page's marked region. */
function restoreFocus(prev: HTMLElement | null): void {
  if (prev !== null && prev !== document.body && prev.isConnected) {
    prev.focus();
    if (document.activeElement === prev) return;
  }
  document.querySelector<HTMLElement>('[data-focus-fallback]')?.focus();
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
  const prevFocusRef = useRef<HTMLElement | null>(null);
  const open = to !== null;

  useEffect(() => {
    if (!open) {
      if (prevFocusRef.current) {
        restoreFocus(prevFocusRef.current);
        prevFocusRef.current = null;
      }
      return;
    }
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    textareaRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent): void {
      const container = dialogRef.current;
      if (!container) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const nodes = focusableNodes(container);
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || active === null) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || active === null) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      class="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-modal-title"
        class="modal message-modal"
      >
        <div class="modal-head">
          <h3 id="message-modal-title">
            Message{' '}
            <span class="mono-id" style={{ color: 'var(--accent)' }}>
              {to}
            </span>
          </h3>
          <button type="button" class="modal-close" onClick={onClose} aria-label="Close">
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
