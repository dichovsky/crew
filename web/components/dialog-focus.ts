/**
 * Shared keyboard-focus behavior for Console dialogs. The hook moves focus to
 * the dialog's preferred control, keeps Tab navigation inside the dialog, and
 * restores focus to the opener (or the page fallback) when the dialog closes.
 */
import { useEffect, useRef } from 'preact/hooks';

interface ElementRef {
  readonly current: HTMLElement | null;
}

interface DialogFocusOptions {
  readonly open: boolean;
  readonly containerRef: ElementRef;
  readonly initialFocusRef: ElementRef;
  readonly onDismiss: () => void;
  /** Keep the dialog open while its action is in flight. */
  readonly dismissDisabled?: boolean;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** Return the enabled controls that participate in a dialog's Tab ring. */
export function dialogFocusableNodes(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(':disabled') &&
      !(element instanceof HTMLInputElement && element.type === 'hidden') &&
      element.closest('[hidden], [inert]') === null,
  );
}

/** Restore focus to the opener, falling back when it cannot receive focus. */
function restoreFocus(previous: HTMLElement | null): void {
  if (previous !== null && previous !== document.body && previous.isConnected) {
    previous.focus();
    if (document.activeElement === previous) return;
  }
  document.querySelector<HTMLElement>('[data-focus-fallback]')?.focus();
}

/** Apply initial focus, focus restoration, Escape dismissal, and a Tab trap. */
export function useDialogFocus({
  open,
  containerRef,
  initialFocusRef,
  onDismiss,
  dismissDisabled = false,
}: DialogFocusOptions): void {
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const active = document.activeElement;
    previousFocusRef.current = active instanceof HTMLElement ? active : null;
    initialFocusRef.current?.focus();

    return () => {
      restoreFocus(previousFocusRef.current);
      previousFocusRef.current = null;
    };
  }, [initialFocusRef, open]);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent): void {
      const container = containerRef.current;
      if (container === null) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        if (!dismissDisabled) onDismiss();
        return;
      }
      if (event.key !== 'Tab') return;

      const nodes = dialogFocusableNodes(container);
      if (nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement;

      if (event.shiftKey) {
        if (active === first || !container.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !container.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [containerRef, dismissDisabled, onDismiss, open]);
}
