/**
 * Pane-peek panel (folded into Operations): session (required) and window
 * (optional) inputs driving GET /api/peek with the page token. The server
 * control-sanitizes the capture (FR-U24) and refuses unowned sessions with
 * NOT_FOUND; this component never interprets the text as HTML — lines render
 * inside a <pre> through Preact default escaping. Controls disable while a
 * request is in flight; failures render the bounded {error:{code,message}}
 * envelope.
 */
import { useState } from 'preact/hooks';
import { getToken } from '../api.js';

interface ErrorEnvelope {
  readonly error?: { readonly code?: string; readonly message?: string };
}

interface PeekEnvelope {
  readonly peek?: { readonly target?: string; readonly text?: string };
}

interface PeekResult {
  readonly target: string;
  readonly text: string;
}

export interface PeekViewProps {
  /** Disable the whole panel (FR-U32 recovery window). */
  readonly disabled?: boolean;
}

export function PeekView({ disabled = false }: PeekViewProps) {
  const [session, setSession] = useState('');
  const [windowName, setWindowName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PeekResult | null>(null);

  async function fetchPeek(): Promise<void> {
    if (session.trim() === '') {
      setError('Session name is required');
      return;
    }
    const token = getToken();
    if (!token) {
      setError('Token not found in URL. Please reload the page.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      const params = new URLSearchParams({ session: session.trim() });
      if (windowName.trim() !== '') params.set('window', windowName.trim());
      const response = await fetch(`/api/peek?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const envelope = (await response.json().catch(() => ({}))) as ErrorEnvelope;
        setError(`Error ${response.status}: ${envelope.error?.message ?? 'request failed'}`);
        return;
      }
      const body = (await response.json()) as PeekEnvelope;
      setResult({ target: body.peek?.target ?? session.trim(), text: body.peek?.text ?? '' });
    } catch {
      setError('Network error — the crew ui server may have stopped');
    } finally {
      setPending(false);
    }
  }

  return (
    <div class="ops-card" aria-label="Pane peek">
      <h2>Pane peek</h2>
      <p class="ops-note">
        Read the sanitized visible text of one crew-owned pane. Unowned sessions are refused.
      </p>
      {error !== null && (
        <p class="modal-error" role="alert" style={{ margin: '0 0 12px' }}>
          {error}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void fetchPeek();
        }}
      >
        <div class="launch-row">
          <input
            type="text"
            class="input peek-session-input"
            value={session}
            onInput={(event) => setSession(event.currentTarget.value)}
            disabled={pending || disabled}
            placeholder="session (e.g. crew-dev)"
            aria-label="Session name"
          />
          <input
            type="text"
            class="input peek-window-input"
            value={windowName}
            onInput={(event) => setWindowName(event.currentTarget.value)}
            disabled={pending || disabled}
            placeholder="window (optional)"
            aria-label="Window name"
            style={{ flex: 1 }}
          />
          <button type="submit" class="btn btn-primary" disabled={pending || disabled}>
            {pending ? 'Peeking…' : 'Peek'}
          </button>
        </div>
      </form>
      {result !== null && (
        <div class="peek">
          <div class="peek-head">
            <span class="peek-target">{result.target}</span>
            <button
              type="button"
              class="peek-close"
              disabled={pending || disabled}
              onClick={() => void fetchPeek()}
            >
              Refresh
            </button>
          </div>
          <pre class="peek-text">{result.text}</pre>
        </div>
      )}
    </div>
  );
}
