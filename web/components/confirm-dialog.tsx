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
 * - Escape cancels
 * - all text via Preact default escaping (never dangerouslySetInnerHTML)
 */
import { useEffect, useRef } from 'preact/hooks';

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

/** Gather every focusable descendant for the focus-trap ring. */
function focusableNodes(container: HTMLElement): HTMLElement[] {
  const selectors =
    'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return [...container.querySelectorAll<HTMLElement>(selectors)].filter((el) => el.tabIndex !== -1);
}

/**
 * Restore focus to the opener on close. When the opener can no longer take
 * focus — disabled or unmounted in the same render that closed the dialog,
 * as after a confirmed destructive action — fall back to the page's marked
 * `[data-focus-fallback]` region so keyboard focus never drops to `<body>`
 * (WCAG 2.4.3).
 */
function restoreFocus(prev: HTMLElement | null): void {
  if (prev !== null && prev !== document.body && prev.isConnected) {
    prev.focus();
    if (document.activeElement === prev) return;
  }
  document.querySelector<HTMLElement>('[data-focus-fallback]')?.focus();
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
  const prevFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      if (prevFocusRef.current) {
        restoreFocus(prevFocusRef.current);
        prevFocusRef.current = null;
      }
      return;
    }
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent): void {
      const container = dialogRef.current;
      if (!container) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
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
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      class="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-desc"
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
