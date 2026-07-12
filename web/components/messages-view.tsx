/**
 * Messages view: the newest-window inbox/sent history beside a compose panel.
 * Retained history is never claimed gap-free (FR-U23): `crew prune` removes
 * old read Messages, so a visible note says gaps are possible.
 * Unread Messages addressed to the Operator are tinted and dot-marked. The
 * recipient is controlled by the App (so "Message <agent>" can pre-address it);
 * the compose body is local and clears on a successful send. The POST is
 * delegated to the App via onSend. Stored content renders through Preact
 * default escaping.
 */
import { useState } from 'preact/hooks';
import type { MessageSnapshotRecord } from '../types.js';
import type { RecipientOption } from './tasks-view.js';
import {
  initials,
  isUnreadToOperator,
  messageKindMeta,
  relTime,
  roleColor,
} from '../view-model.js';

export interface MessagesViewProps {
  readonly messages: readonly MessageSnapshotRecord[];
  readonly recipientOptions: readonly RecipientOption[];
  readonly recipient: string;
  readonly now: number;
  readonly disabled: boolean;
  /** Resolve an id to a role so the avatar tint matches the sender's role. */
  readonly roleOf: (id: string) => string;
  readonly onRecipientChange: (id: string) => void;
  readonly onSend: (input: { recipient: string; content: string }) => Promise<void>;
}

export function MessagesView({
  messages,
  recipientOptions,
  recipient,
  now,
  disabled,
  roleOf,
  onRecipientChange,
  onSend,
}: MessagesViewProps) {
  const [content, setContent] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(): Promise<void> {
    if (recipient === '') {
      setError('Pick a recipient.');
      return;
    }
    if (content.trim() === '') {
      setError('Message is empty.');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onSend({ recipient, content: content.trim() });
      setContent('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <div class="messages-layout">
      <div class="card">
        <div class="card-head" style={{ display: 'block' }}>
          <div class="kicker">Inbox &amp; sent</div>
          <h2 style={{ marginTop: '3px' }}>Recent messages</h2>
        </div>
        {/* FR-U23: never claim retained history is gap-free. */}
        <p class="history-gap-note">History can have gaps: prune removes old read Messages.</p>
        <div>
          {messages.length === 0 ? (
            <p class="empty-note">No messages yet.</p>
          ) : (
            messages.map((message) => {
              const unread = isUnreadToOperator(message);
              const kind = messageKindMeta(message.kind);
              return (
                <div class={`msg-row${unread ? ' unread' : ''}`} key={message.id}>
                  <span class="avatar" style={{ background: roleColor(roleOf(message.sender_id)) }}>
                    {initials(message.sender_id)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div class="msg-head">
                      <span class="msg-sender">{message.sender_id}</span>
                      <span class="msg-arrow">→</span>
                      <span class="msg-recipient">{message.recipient_id}</span>
                      <span class="pill" style={{ background: kind.bg, color: kind.fg }}>
                        {kind.label}
                      </span>
                      {unread && <span class="msg-unread-dot" aria-label="unread" />}
                      <span class="msg-rel">{relTime(message.created_at, now)}</span>
                    </div>
                    <div class="msg-content">{message.content}</div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div class="compose">
        <h2>Compose</h2>
        {error !== null && (
          <p class="modal-error" role="alert" style={{ margin: '0 0 12px' }}>
            {error}
          </p>
        )}
        <label class="field-label" for="compose-recipient">
          Recipient
        </label>
        <select
          id="compose-recipient"
          class="select"
          value={recipient}
          disabled={pending || disabled}
          onChange={(e) => onRecipientChange((e.target as HTMLSelectElement).value)}
        >
          <option value="">Select agent…</option>
          {recipientOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <label class="field-label" for="compose-body">
          Message
        </label>
        <textarea
          id="compose-body"
          class="textarea"
          value={content}
          disabled={pending || disabled}
          placeholder="Type a note to the agent…"
          onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
        />
        <button
          type="button"
          class="btn btn-primary"
          disabled={pending || disabled}
          onClick={() => void send()}
        >
          {pending ? 'Sending…' : 'Send message'}
        </button>
      </div>
    </div>
  );
}
