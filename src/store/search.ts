/** Internal FTS5 queries. The public search operations live on Store. */
import type { DatabaseSync } from 'node:sqlite';
import type { CompiledSearchQuery } from '../search-query.js';
import { previewText } from '../preview.js';
import type { MessageKind } from './messages.js';
import type { TaskEventType } from './tasks.js';

export type SearchScope = 'messages' | 'task-events' | 'all';

export interface SearchInput {
  readonly query: CompiledSearchQuery;
  readonly scope: SearchScope;
  readonly agentId?: string;
  readonly since?: number;
  readonly limit?: number;
}

export interface MessageSearchResult {
  readonly id: number;
  readonly rank: number;
  readonly snippet: string;
  readonly createdAt: number;
  readonly senderId: string;
  readonly recipientId: string;
  readonly kind: MessageKind;
  readonly taskId: string | null;
}

export interface TaskEventSearchResult {
  readonly id: number;
  readonly rank: number;
  readonly snippet: string;
  readonly createdAt: number;
  readonly taskId: string;
  readonly actorId: string;
  readonly eventType: TaskEventType;
  readonly revision: number;
}

export interface SearchResults {
  readonly messages: readonly MessageSearchResult[];
  readonly taskEvents: readonly TaskEventSearchResult[];
}

export interface ReindexResult {
  readonly messagesIndexed: number;
  readonly taskEventsIndexed: number;
}

interface SearchFilters {
  readonly agentId?: string;
  readonly since?: number;
  readonly limit: number;
}

interface MessageSearchRow {
  readonly id: number;
  readonly rank: number;
  readonly snippet: string;
  readonly created_at: number;
  readonly sender_id: string;
  readonly recipient_id: string;
  readonly kind: MessageKind;
  readonly task_id: string | null;
}

interface TaskEventSearchRow {
  readonly id: number;
  readonly rank: number;
  readonly snippet: string;
  readonly created_at: number;
  readonly task_id: string;
  readonly actor_id: string;
  readonly event_type: TaskEventType;
  readonly revision: number;
}

function predicates(
  filter: SearchFilters,
  agentSql: string,
): { sql: string; values: Array<string | number> } {
  const parts: string[] = [];
  const values: Array<string | number> = [];
  if (filter.agentId !== undefined) {
    parts.push(agentSql);
    values.push(filter.agentId, ...(agentSql.includes(' OR ') ? [filter.agentId] : []));
  }
  if (filter.since !== undefined) {
    parts.push('source.created_at >= ?');
    values.push(filter.since);
  }
  return {
    sql: parts.length === 0 ? '' : ` AND ${parts.join(' AND ')}`,
    values,
  };
}

/** Search Message content in deterministic relevance order. */
export function searchMessages(
  db: DatabaseSync,
  query: CompiledSearchQuery,
  filter: SearchFilters,
): MessageSearchResult[] {
  const where = predicates(filter, '(source.sender_id = ? OR source.recipient_id = ?)');
  const rows = db
    .prepare(
      `SELECT source.id,
              bm25(messages_fts) AS rank,
              snippet(messages_fts, 0, '', '', '…', 32) AS snippet,
              source.created_at, source.sender_id, source.recipient_id,
              source.kind, source.task_id
       FROM messages_fts
       JOIN messages AS source ON source.id = messages_fts.rowid
       WHERE messages_fts MATCH ?${where.sql}
       ORDER BY rank ASC, source.created_at DESC, source.id DESC
       LIMIT ?`,
    )
    .all(query.match, ...where.values, filter.limit) as unknown as MessageSearchRow[];
  return rows.map((row) => ({
    id: row.id,
    rank: row.rank,
    snippet: previewText(row.snippet),
    createdAt: row.created_at,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    kind: row.kind,
    taskId: row.task_id,
  }));
}

/** Search Task Event detail in deterministic relevance order. */
export function searchTaskEvents(
  db: DatabaseSync,
  query: CompiledSearchQuery,
  filter: SearchFilters,
): TaskEventSearchResult[] {
  const where = predicates(filter, 'source.actor_id = ?');
  const rows = db
    .prepare(
      `SELECT source.id,
              bm25(task_events_fts) AS rank,
              snippet(task_events_fts, 0, '', '', '…', 32) AS snippet,
              source.created_at, source.task_id, source.actor_id,
              source.event_type, source.revision
       FROM task_events_fts
       JOIN task_events AS source ON source.id = task_events_fts.rowid
       WHERE task_events_fts MATCH ?${where.sql}
       ORDER BY rank ASC, source.created_at DESC, source.id DESC
       LIMIT ?`,
    )
    .all(query.match, ...where.values, filter.limit) as unknown as TaskEventSearchRow[];
  return rows.map((row) => ({
    id: row.id,
    rank: row.rank,
    snippet: previewText(row.snippet),
    createdAt: row.created_at,
    taskId: row.task_id,
    actorId: row.actor_id,
    eventType: row.event_type,
    revision: row.revision,
  }));
}

/** Rebuild both derived indexes; the caller owns the enclosing write transaction. */
export function rebuildSearchIndexes(
  db: DatabaseSync,
  step?: (label: string) => void,
): ReindexResult {
  db.exec("INSERT INTO messages_fts (messages_fts) VALUES ('rebuild')");
  step?.('reindex:after-messages');
  db.exec("INSERT INTO task_events_fts (task_events_fts) VALUES ('rebuild')");
  const row = db
    .prepare(
      `SELECT (SELECT count(*) FROM messages) AS messages_indexed,
              (SELECT count(*) FROM task_events) AS task_events_indexed`,
    )
    .get() as unknown as { messages_indexed: number; task_events_indexed: number };
  return {
    messagesIndexed: row.messages_indexed,
    taskEventsIndexed: row.task_events_indexed,
  };
}
