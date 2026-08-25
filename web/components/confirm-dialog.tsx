/**
 * One-click confirmation dialog for destructive Console actions (FR-U25,
 * relaxed from the former typed-phrase gate). The modal names the irreversible
 * effect; a single Confirm button fires the action (the server still requires
 * `confirm: true`). Cancel and Escape and a backdrop click all dismiss.
 *
 * Accessibility (unchanged from the typed-phrase version):
 * - role="alertdialog", aria-modal, aria-labelledby/aria-describedby, inside a
 *   full-viewport backdrop that blocks pointer interaction with the page
 * - focus moves to the Confirm button on open and is TRAPPED with Tab/Shift-Tab
 * - focus RESTORES to the previously focused element on close, falling back
 *   to the `[data-focus-fallback]` region when the opener can no longer take
 *   focus
 * - Escape cancels unless an action is in flight
 * - all text via Preact default escaping (never dangerouslySetInnerHTML)
 */
import { useRef } from 'preact/hooks';
import { useDialogFocus } from './dialog-focus.js';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  /** Confirm button label (e.g. "Stop session", "Prune", "Clean"). */
  readonly confirmLabel: string;
  /** Disables both buttons while the action POST is in flight. */
  readonly pending?: boolean;
  /** A bounded failure line shown above the buttons. */
  readonly error?: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  pending = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useDialogFocus({
    open,
    containerRef: dialogRef,
    initialFocusRef: confirmRef,
    onDismiss: onCancel,
    dismissDisabled: pending,
  });

  if (!open) return null;

  return (
    <div
      class="modal-backdrop"
      onClick={(e) => {
        if (pending) return;
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-desc"
        tabIndex={-1}
        class="modal"
      >
        <h3 id="confirm-dialog-title">{title}</h3>
        <p id="confirm-dialog-desc">{description}</p>
        {error !== null && (
          <p class="modal-error" role="alert">
            {error}
          </p>
        )}
        <div class="modal-actions">
          <button class="btn btn-ghost" disabled={pending} onClick={onCancel}>
            Cancel
          </button>
          <button ref={confirmRef} class="btn btn-confirm" disabled={pending} onClick={onConfirm}>
            {pending ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
