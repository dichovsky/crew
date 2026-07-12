/**
 * Presentational banner for the deleted-Workspace state (FR-U32).
 *
 * When visible, it informs the user that the Workspace/state store is missing,
 * that actions are disabled, and that the displayed data is the last-known
 * snapshot which may be stale.
 *
 * No side effects: no fetching, no EventSource, no timers.
 */
import type { JSX } from 'preact';

export interface RecoveryBannerProps {
  /** Whether the banner is currently visible. */
  readonly visible: boolean;
  /** An optional short reason (e.g. from a network error or state check). */
  readonly reason?: string;
}

export function RecoveryBanner({ visible, reason }: RecoveryBannerProps): JSX.Element | null {
  if (!visible) {
    return null;
  }

  return (
    <div class="recovery" role="alert">
      <h2 class="recovery-title">Workspace unavailable</h2>
      <p class="recovery-desc">
        The workspace state store has been lost or is unreachable. Actions are disabled until the
        workspace is restored. The data currently displayed is the last-known snapshot and may be
        stale.
      </p>
      {reason && (
        <p class="recovery-desc" style={{ marginTop: '6px', fontFamily: 'var(--mono)' }}>
          {reason}
        </p>
      )}
    </div>
  );
}
