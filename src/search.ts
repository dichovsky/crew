/** `crew search` validation, Store calls, and human/NDJSON rendering. */
import { assertAgentId } from './agent-id.js';
import { CrewError } from './errors.js';
import { formatTimestamp, humanCell, sanitizeHuman, writeJsonLine, writeLine } from './format.js';
import type { Io } from './io.js';
import { parseHistoryTimestamp } from './messages.js';
import { compileSearchQuery } from './search-query.js';
import {
  type MessageSearchResult,
  openWorkspaceStore,
  type SearchScope,
  type TaskEventSearchResult,
} from './store/index.js';
import { resolveWorkspaceRoot } from './workspace.js';

export interface SearchOptions {
  readonly scope?: SearchScope;
  readonly agent?: string;
  readonly since?: string;
  readonly limit?: string;
  readonly reindex: boolean;
  readonly json: boolean;
}

function searchLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new CrewError('USAGE', 'limit must be an integer between 1 and 500');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 500) {
    throw new CrewError('USAGE', 'limit must be an integer between 1 and 500');
  }
  return parsed;
}

function messageRecord(result: MessageSearchResult): Record<string, unknown> {
  return {
    type: 'search_result',
    schema_version: 1,
    scope: 'message',
    id: result.id,
    rank: result.rank,
    snippet: result.snippet,
    created_at: result.createdAt,
    sender_id: result.senderId,
    recipient_id: result.recipientId,
    kind: result.kind,
    task_id: result.taskId,
    actor_id: null,
    event_type: null,
    revision: null,
  };
}

function taskEventRecord(result: TaskEventSearchResult): Record<string, unknown> {
  return {
    type: 'search_result',
    schema_version: 1,
    scope: 'task_event',
    id: result.id,
    rank: result.rank,
    snippet: result.snippet,
    created_at: result.createdAt,
    sender_id: null,
    recipient_id: null,
    kind: null,
    task_id: result.taskId,
    actor_id: result.actorId,
    event_type: result.eventType,
    revision: result.revision,
  };
}

function writeSnippet(io: Io, snippet: string): void {
  for (const line of sanitizeHuman(snippet).split('\n')) writeLine(io, `  ${line}`);
}

function writeMessages(io: Io, results: readonly MessageSearchResult[]): void {
  writeLine(io, 'MESSAGES');
  if (results.length === 0) {
    writeLine(io, 'No matching messages.');
    return;
  }
  for (const result of results) {
    writeLine(
      io,
      `#${result.id}  ${humanCell(result.senderId)} -> ${humanCell(result.recipientId)}  ${formatTimestamp(result.createdAt)}`,
    );
    writeSnippet(io, result.snippet);
  }
}

function writeTaskEvents(io: Io, results: readonly TaskEventSearchResult[]): void {
  writeLine(io, 'TASK EVENTS');
  if (results.length === 0) {
    writeLine(io, 'No matching task events.');
    return;
  }
  for (const result of results) {
    writeLine(
      io,
      `#${result.id}  ${humanCell(result.actorId)}  ${result.eventType}  ${formatTimestamp(result.createdAt)}  task ${humanCell(result.taskId)}`,
    );
    writeSnippet(io, result.snippet);
  }
}

/** Run lexical search or the explicit derived-index rebuild operation. */
export function runSearch(io: Io, clauses: readonly string[], options: SearchOptions): void {
  if (options.reindex) {
    if (
      clauses.length > 0 ||
      options.scope !== undefined ||
      options.agent !== undefined ||
      options.since !== undefined ||
      options.limit !== undefined
    ) {
      throw new CrewError('USAGE', 'search --reindex cannot be combined with a query or filters');
    }
    const root = resolveWorkspaceRoot(io.cwd);
    const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
    try {
      const result = store.reindexSearch();
      if (options.json) {
        writeJsonLine(io, {
          type: 'reindex_result',
          schema_version: 1,
          messages_indexed: result.messagesIndexed,
          task_events_indexed: result.taskEventsIndexed,
        });
      } else {
        writeLine(
          io,
          `Reindexed ${result.messagesIndexed} messages and ${result.taskEventsIndexed} task events.`,
        );
      }
    } finally {
      store.close();
    }
    return;
  }

  const query = compileSearchQuery(clauses);
  const scope = options.scope ?? 'all';
  if (options.agent !== undefined) assertAgentId(options.agent);
  const since = options.since === undefined ? undefined : parseHistoryTimestamp(options.since);
  const limit = searchLimit(options.limit);
  const root = resolveWorkspaceRoot(io.cwd);
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    const results = store.search({
      query,
      scope,
      ...(options.agent !== undefined ? { agentId: options.agent } : {}),
      ...(since !== undefined ? { since } : {}),
      limit,
    });
    if (options.json) {
      for (const result of results.messages) writeJsonLine(io, messageRecord(result));
      for (const result of results.taskEvents) writeJsonLine(io, taskEventRecord(result));
      return;
    }

    if (scope === 'all' && results.messages.length === 0 && results.taskEvents.length === 0) {
      writeLine(io, 'No results.');
      return;
    }
    if (scope !== 'task-events') writeMessages(io, results.messages);
    if (scope === 'all') writeLine(io, '');
    if (scope !== 'messages') writeTaskEvents(io, results.taskEvents);
  } finally {
    store.close();
  }
}
