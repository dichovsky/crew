/** Internal Message SQL and row mapping. The public domain operations live on Store. */
import type { DatabaseSync } from 'node:sqlite';

export type MessageKind =
  'note' | 'task_assigned' | 'task_submitted' | 'task_approved' | 'task_requeued' | 'clear_safe';

export interface MessageRecord {
  readonly id: number;
  readonly senderId: string;
  readonly recipientId: string;
  readonly content: string;
  readonly kind: MessageKind;
  readonly taskId: string | null;
  readonly replyTo: number | null;
  readonly createdAt: number;
  readonly readAt: number | null;
}

export interface InboxState {
  readonly agentId: string;
  readonly unreadCount: number;
  readonly maxUnreadId: number | null;
}

export interface MessageHistoryQuery {
  readonly agentId?: string;
  readonly senderId?: string;
  readonly recipientId?: string;
  readonly since?: number;
  readonly limit: number;
}

interface MessageRow {
  readonly id: number;
  readonly sender_id: string;
  readonly recipient_id: string;
  readonly content: string;
  readonly kind: MessageKind;
  readonly task_id: string | null;
  readonly reply_to: number | null;
  readonly created_at: number;
  readonly read_at: number | null;
}

interface InboxStateRow {
  readonly unread_count: number;
  readonly max_unread_id: number | null;
}

function mapMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    content: row.content,
    kind: row.kind,
    taskId: row.task_id,
    replyTo: row.reply_to,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

export function messageParticipantIds(
  db: DatabaseSync,
  id: number,
): { senderId: string; recipientId: string } | null {
  const row = db
    .prepare('SELECT sender_id AS senderId, recipient_id AS recipientId FROM messages WHERE id = ?')
    .get(id) as unknown as { senderId: string; recipientId: string } | undefined;
  return row ?? null;
}

export function insertNote(
  db: DatabaseSync,
  input: {
    senderId: string;
    recipientId: string;
    content: string;
    replyTo: number | null;
    createdAt: number;
  },
): MessageRecord {
  const row = db
    .prepare(
      `INSERT INTO messages
         (sender_id, recipient_id, content, kind, task_id, reply_to, created_at, read_at)
       VALUES (?, ?, ?, 'note', NULL, ?, ?, NULL)
       RETURNING *`,
    )
    .get(
      input.senderId,
      input.recipientId,
      input.content,
      input.replyTo,
      input.createdAt,
    ) as unknown as MessageRow;
  return mapMessage(row);
}

/**
 * Insert one Task notification Message. Only Task transitions call this — a
 * `task_id` is always supplied, which the schema CHECK requires for every
 * non-`note` kind and simply permits for `note` (used for the abandon copies
 * that carry no context-clear permission). The sender is the transition actor
 * so the recipient sees who acted.
 */
export function insertNotification(
  db: DatabaseSync,
  input: {
    senderId: string;
    recipientId: string;
    content: string;
    kind: MessageKind;
    taskId: string;
    createdAt: number;
  },
): MessageRecord {
  const row = db
    .prepare(
      `INSERT INTO messages
         (sender_id, recipient_id, content, kind, task_id, reply_to, created_at, read_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)
       RETURNING *`,
    )
    .get(
      input.senderId,
      input.recipientId,
      input.content,
      input.kind,
      input.taskId,
      input.createdAt,
    ) as unknown as MessageRow;
  return mapMessage(row);
}

export function claimUnreadMessages(
  db: DatabaseSync,
  agentId: string,
  limit: number,
  readAt: number,
): MessageRecord[] {
  const rows = db
    .prepare(
      `UPDATE messages
       SET read_at = ?
       WHERE id IN (
         SELECT id FROM messages
         WHERE recipient_id = ? AND read_at IS NULL
         ORDER BY created_at, id
         LIMIT ?
       )
       RETURNING *`,
    )
    .all(readAt, agentId, limit) as unknown as MessageRow[];
  return rows
    .map(mapMessage)
    .sort((left, right) => left.createdAt - right.createdAt || left.id - right.id);
}

export function pendingMessages(
  db: DatabaseSync,
  agentId: string | undefined,
  limit: number,
): MessageRecord[] {
  const where = agentId === undefined ? 'read_at IS NULL' : 'recipient_id = ? AND read_at IS NULL';
  const statement = db.prepare(
    `SELECT * FROM messages WHERE ${where} ORDER BY created_at, id LIMIT ?`,
  );
  const rows = (agentId === undefined
    ? statement.all(limit)
    : statement.all(agentId, limit)) as unknown as MessageRow[];
  return rows.map(mapMessage);
}

export function pendingSummary(db: DatabaseSync, agentId: string): InboxState {
  const row = db
    .prepare(
      `SELECT count(*) AS unread_count, max(id) AS max_unread_id
       FROM messages WHERE recipient_id = ? AND read_at IS NULL`,
    )
    .get(agentId) as unknown as InboxStateRow;
  return {
    agentId,
    unreadCount: row.unread_count,
    maxUnreadId: row.max_unread_id,
  };
}

export function messageHistory(db: DatabaseSync, query: MessageHistoryQuery): MessageRecord[] {
  const predicates: string[] = [];
  const values: Array<string | number> = [];
  if (query.agentId !== undefined) {
    predicates.push('(sender_id = ? OR recipient_id = ?)');
    values.push(query.agentId, query.agentId);
  }
  if (query.senderId !== undefined) {
    predicates.push('sender_id = ?');
    values.push(query.senderId);
  }
  if (query.recipientId !== undefined) {
    predicates.push('recipient_id = ?');
    values.push(query.recipientId);
  }
  if (query.since !== undefined) {
    predicates.push('created_at >= ?');
    values.push(query.since);
  }
  const where = predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`;
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM messages ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       )
       ORDER BY created_at, id`,
    )
    .all(...values, query.limit) as unknown as MessageRow[];
  return rows.map(mapMessage);
}
