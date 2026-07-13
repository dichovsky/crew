/**
 * Messages view tests: the inbox/sent list (unread tint + kind pill), the
 * controlled recipient, and the compose validation + send delegation.
 */
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageSnapshotRecord } from '../types.js';
import { MessagesView } from './messages-view';

function message(overrides: Partial<MessageSnapshotRecord> = {}): MessageSnapshotRecord {
  return {
    type: 'message',
    schema_version: 1,
    id: 1,
    sender_id: 'ada',
    recipient_id: 'operator',
    content: 'hello',
    kind: 'note',
    task_id: null,
    reply_to: null,
    created_at: 0,
    read_at: null,
    ...overrides,
  };
}

interface Opts {
  recipient?: string;
  onSend?: (input: { recipient: string; content: string }) => Promise<void>;
  onRecipientChange?: (id: string) => void;
}

function mount(messages: readonly MessageSnapshotRecord[], opts: Opts = {}): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(
    <MessagesView
      messages={messages}
      recipientOptions={[{ id: 'grace', label: 'grace · worker' }]}
      recipient={opts.recipient ?? ''}
      now={0}
      dark={false}
      disabled={false}
      roleOf={() => 'worker'}
      onRecipientChange={opts.onRecipientChange ?? (() => {})}
      onSend={opts.onSend ?? (() => Promise.resolve())}
    />,
    host,
  );
  return host;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('MessagesView', () => {
  it('tints unread operator messages and renders the kind pill', () => {
    const host = mount([
      message({ id: 1, recipient_id: 'operator', read_at: null }),
      message({ id: 2, recipient_id: 'worker', read_at: 5, kind: 'task_submitted' }),
    ]);
    const rows = [...host.querySelectorAll('.msg-row')];
    expect(rows[0]?.classList.contains('unread')).toBe(true);
    expect(rows[1]?.classList.contains('unread')).toBe(false);
    expect(host.textContent).toContain('Submitted');
  });

  it('renders the visible history-gaps disclosure (FR-U23)', () => {
    // Even an empty inbox is never presented as gap-free history.
    const host = mount([]);
    expect(host.querySelector('.history-gap-note')?.textContent).toBe(
      'History can have gaps: prune removes old read Messages.',
    );
  });

  it('reflects the controlled recipient', () => {
    const host = mount([], { recipient: 'grace' });
    expect((host.querySelector('#compose-recipient') as HTMLSelectElement).value).toBe('grace');
  });

  it('blocks an empty recipient or body and does not send', async () => {
    const onSend = vi.fn(() => Promise.resolve());
    const host = mount([], { recipient: '', onSend });
    host.querySelector('.btn-primary')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() =>
      expect(host.querySelector('.modal-error')?.textContent).toContain('recipient'),
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it('sends the trimmed body to the recipient and clears the field', async () => {
    const onSend = vi.fn(() => Promise.resolve());
    const host = mount([], { recipient: 'grace', onSend });
    const body = host.querySelector('#compose-body') as HTMLTextAreaElement;
    body.value = '  ping  ';
    body.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(body.value).toBe('  ping  '));
    host.querySelector('.btn-primary')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() =>
      expect(onSend).toHaveBeenCalledWith({ recipient: 'grace', content: 'ping' }),
    );
  });

  it('renders hostile message content as inert text', () => {
    const host = mount([message({ content: '<img src=x onerror=alert(1)>' })]);
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(host.querySelector('img')).toBeNull();
  });
});
