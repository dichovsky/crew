import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewError } from '../../src/errors.js';
import { Store } from '../../src/store/index.js';
import { SHELL_METACHARS } from '../helpers/security-corpus.js';

const made: string[] = [];

function create(clock: () => number): { store: Store; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'crew-messages-'));
  made.push(dir);
  const path = join(dir, 'crew.db');
  return { store: new Store(path, { clock }), path };
}

function addAgents(store: Store, ...ids: string[]): void {
  for (const id of ids) store.joinAgent({ id, role: id });
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('expected failure');
  } catch (err) {
    expect(err).toBeInstanceOf(CrewError);
    expect((err as CrewError).code).toBe(code);
  }
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('Store Message send', () => {
  it('sends direct notes with exact content and one operation timestamp', () => {
    let now = 10;
    const { store } = create(() => now);
    addAgents(store, 'manager', 'worker');
    now = 20;
    const [message] = store.sendMessages({
      senderId: 'manager',
      recipientId: 'worker',
      content: 'line one\nline two',
    });
    expect(message).toEqual({
      id: 1,
      senderId: 'manager',
      recipientId: 'worker',
      content: 'line one\nline two',
      kind: 'note',
      taskId: null,
      replyTo: null,
      createdAt: 20,
      readAt: null,
    });
    expect(store.getAgent('manager')?.lastSeen).toBe(20);
    expect(store.getAgent('worker')?.lastSeen).toBe(10);
    store.close();
  });

  it('validates missing and archived participants without partial writes', () => {
    const { store } = create(() => 0);
    addAgents(store, 'manager', 'worker');
    expectCode(
      () => store.sendMessages({ senderId: 'missing', recipientId: 'worker', content: 'x' }),
      'NOT_FOUND',
    );
    expectCode(
      () => store.sendMessages({ senderId: 'manager', recipientId: 'missing', content: 'x' }),
      'NOT_FOUND',
    );
    store.leaveAgent('worker');
    expectCode(
      () => store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'x' }),
      'AGENT_INACTIVE',
    );
    store.leaveAgent('manager');
    expectCode(
      () => store.sendMessages({ senderId: 'manager', recipientId: '@all', content: 'x' }),
      'AGENT_INACTIVE',
    );
    expect(store.listMessageHistory()).toEqual([]);
    store.close();
  });

  it('broadcasts atomically in recipient-id order, excludes sender, and permits zero recipients', () => {
    let now = 0;
    const { store } = create(() => now);
    addAgents(store, 'sender', 'zeta', 'alpha');
    now = 1;
    const sent = store.sendMessages({ senderId: 'sender', recipientId: '@all', content: 'news' });
    expect(sent.map((message) => message.recipientId)).toEqual(['alpha', 'zeta']);
    store.leaveAgent('alpha');
    store.leaveAgent('zeta');
    now = 2;
    expect(
      store.sendMessages({ senderId: 'sender', recipientId: '@all', content: 'none' }),
    ).toEqual([]);
    expect(store.getAgent('sender')?.lastSeen).toBe(2);
    store.close();
  });

  it('validates reply existence/access and rejects broadcast replies', () => {
    const { store } = create(() => 0);
    addAgents(store, 'manager', 'worker', 'outsider');
    const original = store.sendMessages({
      senderId: 'manager',
      recipientId: 'worker',
      content: 'question',
    })[0]!;
    expect(
      store.sendMessages({
        senderId: 'worker',
        recipientId: 'manager',
        content: 'answer',
        replyTo: original.id,
      })[0]?.replyTo,
    ).toBe(original.id);
    expectCode(
      () =>
        store.sendMessages({
          senderId: 'outsider',
          recipientId: 'worker',
          content: 'leak',
          replyTo: original.id,
        }),
      'NOT_FOUND',
    );
    expectCode(
      () =>
        store.sendMessages({
          senderId: 'worker',
          recipientId: 'manager',
          content: 'missing',
          replyTo: 99,
        }),
      'NOT_FOUND',
    );
    expectCode(
      () =>
        store.sendMessages({
          senderId: 'manager',
          recipientId: '@all',
          content: 'invalid',
          replyTo: original.id,
        }),
      'USAGE',
    );
    store.close();
  });

  it('enforces Unicode code-point bounds and cannot forge notification kinds', () => {
    const { store } = create(() => 0);
    addAgents(store, 'manager', 'worker');
    expectCode(
      () => store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: '' }),
      'USAGE',
    );
    const exact = '😀'.repeat(100_000);
    expect(
      store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: exact })[0]
        ?.content,
    ).toBe(exact);
    expectCode(
      () =>
        store.sendMessages({
          senderId: 'manager',
          recipientId: 'worker',
          content: `${exact}x`,
        }),
      'USAGE',
    );
    const forged = store.sendMessages({
      senderId: 'manager',
      recipientId: 'worker',
      content: 'still a note',
      kind: 'task_assigned',
    } as Parameters<Store['sendMessages']>[0] & { kind: string });
    expect(forged[0]?.kind).toBe('note');
    expect(forged[0]?.taskId).toBeNull();
    store.close();
  });

  it('rolls back a partially expanded broadcast and sender touch on insertion failure', () => {
    let now = 0;
    const { store, path } = create(() => now);
    addAgents(store, 'sender', 'alpha', 'zeta');
    const db = new DatabaseSync(path);
    db.exec(`CREATE TRIGGER fail_zeta BEFORE INSERT ON messages
      WHEN NEW.recipient_id = 'zeta'
      BEGIN SELECT RAISE(ABORT, 'forced failure'); END`);
    now = 10;
    expectCode(
      () => store.sendMessages({ senderId: 'sender', recipientId: '@all', content: 'atomic' }),
      'INTEGRITY',
    );
    db.exec('DROP TRIGGER fail_zeta');
    db.close();
    expect(store.listMessageHistory()).toEqual([]);
    expect(store.getAgent('sender')?.lastSeen).toBe(0);
    store.close();
  });

  it('stores Message text with shell metacharacters literally, byte-exact [security]', () => {
    const { store } = create(() => 0);
    addAgents(store, 'manager', 'worker');
    for (const payload of SHELL_METACHARS) {
      const [sent] = store.sendMessages({
        senderId: 'manager',
        recipientId: 'worker',
        content: payload,
      });
      expect(sent?.content).toBe(payload);
    }
    expect(store.listMessageHistory().map((message) => message.content)).toEqual([
      ...SHELL_METACHARS,
    ]);
    store.close();
  });
});

describe('Store Message receive and queries', () => {
  it('claims bounded oldest rows, sorts RETURNING output, commits read_at, and never repeats', () => {
    let now = 0;
    const { store } = create(() => now);
    addAgents(store, 'manager', 'worker');
    now = 30;
    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'third' });
    now = 10;
    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'first' });
    now = 20;
    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'second' });
    now = 40;
    const received = store.receiveMessages('worker', 2);
    expect(received.map((message) => message.content)).toEqual(['first', 'second']);
    expect(received.map((message) => message.readAt)).toEqual([40, 40]);
    expect(store.receiveMessages('worker').map((message) => message.content)).toEqual(['third']);
    expect(store.receiveMessages('worker')).toEqual([]);
    expect(store.getAgent('worker')?.lastSeen).toBe(40);
    expect(store.listMessageHistory().map((message) => message.readAt)).toEqual([40, 40, 40]);
    store.close();
  });

  it('validates receive limits and active status, while an empty receive touches activity', () => {
    let now = 0;
    const { store } = create(() => now);
    addAgents(store, 'worker');
    expectCode(() => store.receiveMessages('worker', 0), 'USAGE');
    expectCode(() => store.receiveMessages('worker', 501), 'USAGE');
    expectCode(() => store.receiveMessages('missing'), 'NOT_FOUND');
    now = 5;
    expect(store.receiveMessages('worker')).toEqual([]);
    expect(store.getAgent('worker')?.lastSeen).toBe(5);
    store.leaveAgent('worker');
    expectCode(() => store.receiveMessages('worker'), 'AGENT_INACTIVE');
    store.close();
  });

  it('keeps pending non-consuming, defaults to the oldest 50, and summarizes the complete Inbox', () => {
    let now = 0;
    const { store } = create(() => now);
    addAgents(store, 'manager', 'worker');
    for (let index = 0; index < 55; index++) {
      now = index;
      store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: String(index) });
    }
    const pending = store.listPendingMessages({ agentId: 'worker' });
    expect(pending).toHaveLength(50);
    expect(pending[0]?.content).toBe('0');
    expect(pending[49]?.content).toBe('49');
    expect(store.getPendingSummary('worker')).toEqual({
      agentId: 'worker',
      unreadCount: 55,
      maxUnreadId: 55,
    });
    expect(store.listPendingMessages({ agentId: 'worker', limit: 500 })).toHaveLength(55);
    expect(store.getAgent('worker')?.lastSeen).toBe(0);
    store.receiveMessages('worker', 500);
    expect(store.getPendingSummary('worker')).toEqual({
      agentId: 'worker',
      unreadCount: 0,
      maxUnreadId: null,
    });
    store.close();
  });

  it('lists global pending Messages oldest-first across recipients', () => {
    let now = 0;
    const { store } = create(() => now);
    addAgents(store, 'manager', 'worker', 'inspector');
    now = 1;
    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'first' });
    now = 2;
    store.sendMessages({ senderId: 'manager', recipientId: 'inspector', content: 'second' });

    expect(
      store.listPendingMessages({}).map((message) => [message.recipientId, message.content]),
    ).toEqual([
      ['worker', 'first'],
      ['inspector', 'second'],
    ]);
    store.close();
  });

  it('allows archived pending/history filters but rejects unknown filters', () => {
    const { store } = create(() => 0);
    addAgents(store, 'manager', 'worker');
    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'retained' });
    store.leaveAgent('worker');
    expect(store.listPendingMessages({ agentId: 'worker' })).toHaveLength(1);
    expect(store.getPendingSummary('worker').unreadCount).toBe(1);
    expect(store.listMessageHistory({ agentId: 'worker' })).toHaveLength(1);
    expectCode(() => store.listPendingMessages({ agentId: 'missing' }), 'NOT_FOUND');
    expectCode(() => store.getPendingSummary('missing'), 'NOT_FOUND');
    expectCode(() => store.listMessageHistory({ senderId: 'missing' }), 'NOT_FOUND');
    store.close();
  });

  it('combines inclusive history filters and returns the newest window oldest-to-newest', () => {
    let now = 0;
    const { store } = create(() => now);
    addAgents(store, 'a', 'b', 'c');
    now = 10;
    store.sendMessages({ senderId: 'a', recipientId: 'b', content: 'old' });
    now = 20;
    store.sendMessages({ senderId: 'a', recipientId: 'b', content: 'edge' });
    now = 30;
    store.sendMessages({ senderId: 'c', recipientId: 'b', content: 'other sender' });
    now = 40;
    store.sendMessages({ senderId: 'a', recipientId: 'c', content: 'other recipient' });
    expect(store.listMessageHistory({ limit: 2 }).map((message) => message.content)).toEqual([
      'other sender',
      'other recipient',
    ]);
    expect(
      store
        .listMessageHistory({ agentId: 'b', senderId: 'a', recipientId: 'b', since: 20 })
        .map((message) => message.content),
    ).toEqual(['edge']);
    expectCode(() => store.listMessageHistory({ limit: 1_001 }), 'USAGE');
    store.close();
  });
});
