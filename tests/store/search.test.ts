import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewError } from '../../src/errors.js';
import { compileSearchQuery } from '../../src/search-query.js';
import { Store } from '../../src/store/index.js';

const made: string[] = [];

function path(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-search-'));
  made.push(dir);
  return join(dir, 'crew.db');
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

describe('Store search', () => {
  it('distinguishes AND clauses from phrases, supports prefixes, and treats punctuation as separators', () => {
    const store = new Store(path(), { clock: () => 10 });
    for (const id of ['manager', 'worker']) store.joinAgent({ id, role: id });
    const [separated] = store.sendMessages({
      senderId: 'manager',
      recipientId: 'worker',
      content: 'lease bright inspector foo-bar leasing',
    });
    const [phrase] = store.sendMessages({
      senderId: 'worker',
      recipientId: 'manager',
      content: 'lease inspector foo bar leasehold',
    });

    const search = (clauses: readonly string[]) =>
      store.search({ query: compileSearchQuery(clauses), scope: 'messages' }).messages;
    expect(
      search(['lease', 'inspector'])
        .map((row) => row.id)
        .sort(),
    ).toEqual([separated!.id, phrase!.id].sort());
    expect(search(['lease inspector']).map((row) => row.id)).toEqual([phrase!.id]);
    expect(
      search(['leas*'])
        .map((row) => row.id)
        .sort(),
    ).toEqual([separated!.id, phrase!.id].sort());
    // unicode61 tokenizes punctuation as separators; punctuation is not a
    // literal byte-level constraint of the query language.
    expect(
      search(['foo/bar'])
        .map((row) => row.id)
        .sort(),
    ).toEqual([separated!.id, phrase!.id].sort());
    // FTS operator-looking input remains literal and never becomes raw MATCH
    // syntax (or a SQLite syntax error).
    expect(search(['AND'])).toEqual([]);
    expect(search(['lease AND ('])).toEqual([]);
    expect(search(['content:lease'])).toEqual([]);
    expect(search(['lease" OR "inspector'])).toEqual([]);
    store.close();
  });

  it('does not index Task title or body text', () => {
    const store = new Store(path(), { clock: () => 0 });
    for (const id of ['manager', 'worker', 'inspector']) store.joinAgent({ id, role: id });
    store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'titleonlytoken',
      body: 'bodyonlytoken',
    });
    expect(
      store.search({
        query: compileSearchQuery(['titleonlytoken']),
        scope: 'task-events',
      }).taskEvents,
    ).toEqual([]);
    expect(
      store.search({
        query: compileSearchQuery(['bodyonlytoken']),
        scope: 'task-events',
      }).taskEvents,
    ).toEqual([]);
    store.close();
  });

  it('breaks equal-rank ties by newest created_at and then descending id', () => {
    let now = 10;
    const store = new Store(path(), { clock: () => now });
    for (const id of ['manager', 'worker']) store.joinAgent({ id, role: id });
    const [old] = store.sendMessages({
      senderId: 'manager',
      recipientId: 'worker',
      content: 'sameword',
    });
    now = 20;
    const [newerLowerId] = store.sendMessages({
      senderId: 'manager',
      recipientId: 'worker',
      content: 'sameword',
    });
    const [newerHigherId] = store.sendMessages({
      senderId: 'manager',
      recipientId: 'worker',
      content: 'sameword',
    });
    const rows = store.search({
      query: compileSearchQuery(['sameword']),
      scope: 'messages',
    }).messages;
    expect(new Set(rows.map((row) => row.rank))).toHaveProperty('size', 1);
    expect(rows.map((row) => row.id)).toEqual([newerHigherId!.id, newerLowerId!.id, old!.id]);
    store.close();
  });

  it('applies the 32-token snippet before the 200-code-point preview without rewriting controls', () => {
    const store = new Store(path(), { clock: () => 0 });
    for (const id of ['manager', 'worker']) store.joinAgent({ id, role: id });
    const shortWords = Array.from({ length: 80 }, (_, index) =>
      index === 40 ? 'findtoken' : `w${index}`,
    );
    store.sendMessages({
      senderId: 'manager',
      recipientId: 'worker',
      content: shortWords.join(' '),
    });
    const tokenSnippet = store.search({
      query: compileSearchQuery(['findtoken']),
      scope: 'messages',
    }).messages[0]!.snippet;
    expect(tokenSnippet.split(/\s+/u).filter((token) => token !== '…')).toHaveLength(32);

    const longWords = Array.from({ length: 80 }, (_, index) =>
      index === 40 ? 'rawtoken\u001b[31m\u0007' : `abcdefghij${index}😀`,
    );
    store.sendMessages({
      senderId: 'manager',
      recipientId: 'worker',
      content: longWords.join(' '),
    });
    const preview = store.search({
      query: compileSearchQuery(['rawtoken']),
      scope: 'messages',
    }).messages[0]!.snippet;
    expect(Array.from(preview)).toHaveLength(201);
    expect(Array.from(preview).at(-1)).toBe('…');
    expect(preview).not.toContain('\ufffd');
    store.sendMessages({
      senderId: 'manager',
      recipientId: 'worker',
      content: 'controltoken\u001b[31m\u0007 exact',
    });
    expect(
      store.search({
        query: compileSearchQuery(['controltoken']),
        scope: 'messages',
      }).messages[0]!.snippet,
    ).toContain('\u001b[31m\u0007');
    store.close();
  });

  it('searches both scopes with independent filters/limits and changes no Message or Agent state', () => {
    let now = 1;
    const store = new Store(path(), { clock: () => now });
    for (const id of ['manager', 'worker', 'inspector']) store.joinAgent({ id, role: id });
    now = 10;
    const [older] = store.sendMessages({
      senderId: 'manager',
      recipientId: 'worker',
      content: 'CAFÉ needle',
    });
    now = 20;
    const [newer] = store.sendMessages({
      senderId: 'inspector',
      recipientId: 'manager',
      content: 'cafe needle',
    });
    const task = store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'Unindexed title',
    });
    now = 21;
    store.startTask('worker', task.id);
    now = 22;
    store.submitTask('worker', task.id, 'café needle event');

    const beforeMessage = store.getMessage(older!.id);
    const beforeAgents = store.listAgents({ includeArchived: true });
    const results = store.search({
      query: compileSearchQuery(['cafe', 'needle']),
      scope: 'all',
      limit: 1,
    });
    expect(results.messages).toHaveLength(1);
    expect(results.messages[0]?.id).toBe(newer!.id);
    expect(results.taskEvents).toHaveLength(1);
    expect(results.taskEvents[0]).toMatchObject({
      taskId: task.id,
      actorId: 'worker',
      eventType: 'submitted',
      revision: 2,
    });
    expect(store.getMessage(older!.id)).toEqual(beforeMessage);
    expect(store.listAgents({ includeArchived: true })).toEqual(beforeAgents);

    expect(
      store
        .search({
          query: compileSearchQuery(['needle']),
          scope: 'messages',
          agentId: 'worker',
          since: 10,
        })
        .messages.map((row) => row.id),
    ).toEqual([older!.id]);
    expect(
      store.search({
        query: compileSearchQuery(['needle']),
        scope: 'task-events',
        agentId: 'worker',
        since: 22,
      }).taskEvents,
    ).toHaveLength(1);

    store.leaveAgent('worker');
    expect(
      store.search({
        query: compileSearchQuery(['needle']),
        scope: 'all',
        agentId: 'worker',
      }).messages,
    ).toHaveLength(1);
    expectCode(
      () =>
        store.search({
          query: compileSearchQuery(['needle']),
          scope: 'all',
          agentId: 'missing',
        }),
      'NOT_FOUND',
    );
    store.close();
  });

  it('uses one deferred snapshot across the two scope reads', () => {
    let now = 10;
    const databasePath = path();
    const seed = new Store(databasePath, { clock: () => now });
    for (const id of ['manager', 'worker', 'inspector']) seed.joinAgent({ id, role: id });
    seed.sendMessages({
      senderId: 'manager',
      recipientId: 'worker',
      content: 'snapshotword',
    });
    const task = seed.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'Snapshot test',
    });
    seed.startTask('worker', task.id);
    seed.close();

    const writer = new Store(databasePath, { clock: () => now });
    let wrote = false;
    const reader = new Store(databasePath, {
      clock: () => now,
      onTransactionStep: (label) => {
        if (label === 'search:after-messages' && !wrote) {
          wrote = true;
          now = 20;
          writer.submitTask('worker', task.id, 'snapshotword');
        }
      },
    });
    const query = compileSearchQuery(['snapshotword']);
    const first = reader.search({ query, scope: 'all' });
    expect(first.messages).toHaveLength(1);
    expect(first.taskEvents).toEqual([]);
    expect(reader.search({ query, scope: 'all' }).taskEvents).toHaveLength(1);
    reader.close();
    writer.close();
  });

  it('rebuilds both deliberately stale indexes and reports authoritative row counts', () => {
    const databasePath = path();
    let store = new Store(databasePath, { clock: () => 0 });
    for (const id of ['manager', 'worker', 'inspector']) store.joinAgent({ id, role: id });
    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'indexed' });
    const task = store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'Task',
    });
    store.startTask('worker', task.id);
    store.submitTask('worker', task.id, 'indexed');
    const messagesIndexed = store.listMessageHistory({ limit: 500 }).length;
    const taskEventsIndexed = store.getTaskEvents(task.id).length;
    store.close();

    const raw = new DatabaseSync(databasePath);
    raw.exec("INSERT INTO messages_fts (messages_fts) VALUES ('delete-all')");
    raw.exec("INSERT INTO task_events_fts (task_events_fts) VALUES ('delete-all')");
    raw.close();

    let failBetweenRebuilds = true;
    store = new Store(databasePath, {
      clock: () => 0,
      onTransactionStep: (label) => {
        if (label === 'reindex:after-messages' && failBetweenRebuilds) {
          failBetweenRebuilds = false;
          throw new Error('stop between index rebuilds');
        }
      },
    });
    expect(store.search({ query: compileSearchQuery(['indexed']), scope: 'all' })).toEqual({
      messages: [],
      taskEvents: [],
    });
    expectCode(() => store.reindexSearch(), 'INTEGRITY');
    // The first rebuild ran before the injected failure, but BEGIN IMMEDIATE
    // rolls it back together with the unstarted second rebuild.
    expect(store.search({ query: compileSearchQuery(['indexed']), scope: 'all' })).toEqual({
      messages: [],
      taskEvents: [],
    });
    expect(store.reindexSearch()).toEqual({ messagesIndexed, taskEventsIndexed });
    expect(
      store.search({ query: compileSearchQuery(['indexed']), scope: 'messages' }).messages,
    ).toHaveLength(1);
    expect(
      store.search({ query: compileSearchQuery(['indexed']), scope: 'task-events' }).taskEvents,
    ).toHaveLength(1);
    store.close();
  });

  it('validates Store-layer scope, bounds, timestamps, and exact Message ids', () => {
    const store = new Store(path(), { clock: () => 0 });
    const query = compileSearchQuery(['x']);
    expectCode(() => store.search({ query, scope: 'all', limit: 0 }), 'USAGE');
    expectCode(() => store.search({ query, scope: 'all', since: 1.5 }), 'USAGE');
    expectCode(() => store.search({ query, scope: 'bogus' as 'all' }), 'USAGE');
    expectCode(() => store.getMessage(0), 'USAGE');
    expect(store.getMessage(1)).toBeNull();
    store.close();
  });
});
