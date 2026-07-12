/**
 * Typed API client for the Console server.
 * - fetchSnapshot() retrieves the current workspace snapshot.
 * - subscribeToChanges() subscribes to SSE 'change' events and refetches on updates.
 */
import type { WorkspaceSnapshot } from './types.js';

export function getToken(): string | null {
  const url = new URL(window.location.href);
  return url.searchParams.get('token');
}

export async function fetchSnapshot(): Promise<WorkspaceSnapshot> {
  const token = getToken();
  if (!token) {
    throw new Error('Token not found in URL. Please reload the page.');
  }

  const response = await fetch(`/api/snapshot?token=${encodeURIComponent(token)}`, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Snapshot request failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as WorkspaceSnapshot;
}

export interface ChangeSubscriptionHandlers {
  readonly onChange: (data: unknown) => void;
  /** FR-U32: the workspace State Store vanished under the running server. */
  readonly onWorkspaceMissing?: () => void;
  /** FR-U32: a re-initialized Store reappeared at the same workspace path. */
  readonly onWorkspaceRestored?: () => void;
}

export function subscribeToChanges(handlers: ChangeSubscriptionHandlers): { close: () => void } {
  const token = getToken();
  if (!token) {
    throw new Error('Token not found in URL. Please reload the page.');
  }

  const eventSource = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);

  eventSource.addEventListener('change', (event: MessageEvent) => {
    const raw = String(event.data);
    try {
      const parsed: unknown = JSON.parse(raw);
      handlers.onChange(parsed);
    } catch {
      handlers.onChange(raw);
    }
  });
  // The FR-U32 recovery pair: distinguishable event NAMES, same listener
  // pattern as 'change' (the payload carries only a bounded reason string).
  eventSource.addEventListener('workspace-missing', () => {
    handlers.onWorkspaceMissing?.();
  });
  eventSource.addEventListener('workspace-restored', () => {
    handlers.onWorkspaceRestored?.();
  });

  // Track connection loss and trigger onChange (refetch) on successful reconnect
  let wasDisconnected = false;
  eventSource.addEventListener('open', () => {
    if (wasDisconnected) {
      wasDisconnected = false;
      handlers.onChange({ reconnected: true });
    }
  });
  eventSource.addEventListener('error', () => {
    wasDisconnected = true;
  });

  return { close: () => eventSource.close() };
}
