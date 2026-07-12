/**
 * Transient toast notifications (design "toasts" layer). Pure render: the App
 * owns the toast list and its auto-dismiss timers. Stored content (titles from
 * Task/Agent ids) renders through Preact's default text escaping.
 */
export interface Toast {
  readonly id: number;
  readonly title: string;
  readonly detail: string;
  readonly dot: string;
}

export interface ToastsProps {
  readonly toasts: readonly Toast[];
}

export function Toasts({ toasts }: ToastsProps) {
  if (toasts.length === 0) return null;
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} class="toast">
          <span class="dot" style={{ background: toast.dot }} />
          <div>
            <div class="toast-title">{toast.title}</div>
            {toast.detail !== '' && <div class="toast-detail">{toast.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
