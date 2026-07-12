import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../src/init.js';
import { run } from '../../src/run.js';
import { openWorkspaceStore, type Store } from '../../src/store/index.js';
import { buildSnapshot, DEFAULT_HISTORY_LIMIT, TASK_EVENT_LIMIT } from '../../src/ui/snapshot.js';
import { captureIo } from '../helpers/io.js';

const made: string[] = [];

function workspace(clock: () => number = () => 0) {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-ui-snapshot-'));
  made.push(cwd);
  const capture = captureIo({ cwd, clock });
  initWorkspace(capture.io, { withGuides: false, json: false });
  capture.out.length = 0;
  return { cwd, ...capture };
}

function records(output: readonly string[]): Array<Record<string, unknown>> {
  return output
    .join('')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Wrap a Store so every method invocation is recorded by name. The snapshot
 * builder receives the full Store surface at runtime; the recorded set proves
 * which methods it actually touched (FR-U12: no consuming reads).
 */
function recordingStore(store: Store): { store: Store; called: Set<string> } {
  const called = new Set<string>();
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value === 'function' && typeof prop === 'string') {
        called.add(prop);
        return (value as (...args: unknown[]) => unknown).bind(target);
      }
      return value;
    },
  });
  return { store: proxy, called };
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('buildSnapshot non-consuming reads (FR-U11/FR-U12)', () => {
  it('touches only the five read methods and never receiveMessages', () => {
    const { cwd } = workspace();
    const store = openWorkspaceStore(cwd, () => 0);
    store.joinAgent({ id: 'manager', role: 'manager' });
    store.joinAgent({ id: 'worker', role: 'worker' });
    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'unread one' });
    store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'manager',
      title: 'observed task',
    });

    const recording = recordingStore(store);
    buildSnapshot(recording.store);

    expect([...recording.called].sort()).toEqual([
      'getPendingSummary',
      'getTaskWithEvents',
      'listAgents',
      'listMessageHistory',
      'listTasks',
    ]);
    expect(recording.called.has('receiveMessages')).toBe(false);
  });

  it('leaves unread Messages unread; repeated builds return identical snapshots', () => {
    const { cwd } = workspace();
    const store = openWorkspaceStore(cwd, () => 0);
    store.joinAgent({ id: 'manager', role: 'manager' });
    store.joinAgent({ id: 'worker', role: 'worker' });
    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'unread one' });
    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'unread two' });

    const first = buildSnapshot(store);
    const second = buildSnapshot(store);
    expect(second).toEqual(first);

    // The snapshot saw both Messages as unread…
    expect(first.messages.map((message) => message.read_at)).toEqual([null, null]);
    const worker = first.agents.find((agent) => agent.id === 'worker');
    expect(worker?.pending_summary).toEqual({
      type: 'inbox_state',
      schema_version: 1,
      agent_id: 'worker',
      unread_count: 2,
      max_unread_id: 2,
    });

    // …and they are still claimable afterwards: nothing was consumed.
    expect(store.getPendingSummary('worker')).toEqual({
      agentId: 'worker',
      unreadCount: 2,
      maxUnreadId: 2,
    });
    const claimed = store.receiveMessages('worker');
    expect(claimed.map((message) => message.content)).toEqual(['unread one', 'unread two']);
  });
});

describe('buildSnapshot record shapes match the --json CLI contract', () => {
  it('emits the same agent, inbox_state, task, and message records as the CLI', async () => {
    const now = 100;
    const { cwd, io, out } = workspace(() => now);
    expect(await run(['join', 'manager', '--json'], io)).toBe(0);
    expect(await run(['join', 'worker', '--platform', 'claude-code', '--json'], io)).toBe(0);
    expect(await run(['join', 'inspector', '--json'], io)).toBe(0);
    expect(await run(['send', 'manager', 'worker', 'start please', '--json'], io)).toBe(0);
    expect(await run(['send', 'worker', 'manager', 'ack', '--json'], io)).toBe(0);
    expect(await run(['receive', 'manager', '--json'], io)).toBe(0);
    out.length = 0;
    expect(
      await run(
        [
          'task',
          'create',
          'manager',
          'worker',
          '--reviewer',
          'inspector',
          '--title',
          'Ship the widget',
          '--body',
          'full brief',
          '--json',
        ],
        io,
      ),
    ).toBe(0);
    const taskId = records(out)[0]?.id as string;
    expect(await run(['task', 'start', 'worker', taskId, '--json'], io)).toBe(0);
    expect(await run(['task', 'submit', 'worker', taskId, '--summary', 'done', '--json'], io)).toBe(
      0,
    );
    expect(await run(['leave', 'inspector', '--json'], io)).toBe(0);

    out.length = 0;
    expect(await run(['agents', '--all', '--json'], io)).toBe(0);
    const agentRecords = records(out);
    out.length = 0;
    expect(await run(['task', 'list', '--json'], io)).toBe(0);
    const taskRecords = records(out);
    out.length = 0;
    expect(await run(['history', '--limit', '10', '--json'], io)).toBe(0);
    const messageRecords = records(out);

    const snapshot = buildSnapshot(
      openWorkspaceStore(cwd, () => now),
      { historyLimit: 10 },
    );

    const withoutSummary = snapshot.agents.map((agent) => {
      const clone: Record<string, unknown> = { ...agent };
      delete clone.pending_summary;
      return clone;
    });
    expect(withoutSummary).toEqual(agentRecords);
    const withoutEvents = snapshot.tasks.map((task) => {
      const clone: Record<string, unknown> = { ...task };
      delete clone.events;
      return clone;
    });
    expect(withoutEvents).toEqual(taskRecords);
    expect(snapshot.messages).toEqual(messageRecords);

    for (const agent of snapshot.agents) {
      out.length = 0;
      expect(await run(['pending', '--agent', agent.id, '--summary', '--json'], io)).toBe(0);
      expect([agent.pending_summary]).toEqual(records(out));
    }

    // Each task's embedded timeline matches the task_event records that
    // `crew task show --json` emits after the task record itself.
    for (const task of snapshot.tasks) {
      out.length = 0;
      expect(await run(['task', 'show', task.id, '--events', '--json'], io)).toBe(0);
      const shown = records(out);
      expect(task.events).toEqual(shown.filter((record) => record['type'] === 'task_event'));
    }

    // The snapshot is one JSON-ready object: a serialization round-trip is lossless.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});

describe('buildSnapshot bounded history', () => {
  it('returns only the newest window, oldest-to-newest', () => {
    let now = 0;
    const { cwd } = workspace();
    const store = openWorkspaceStore(cwd, () => now);
    store.joinAgent({ id: 'manager', role: 'manager' });
    store.joinAgent({ id: 'worker', role: 'worker' });
    for (let i = 1; i <= 7; i += 1) {
      now = i;
      store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: `note ${i}` });
    }

    const snapshot = buildSnapshot(store, { historyLimit: 3 });
    expect(snapshot.messages.map((message) => message.id)).toEqual([5, 6, 7]);
    expect(snapshot.messages.map((message) => message.content)).toEqual([
      'note 5',
      'note 6',
      'note 7',
    ]);
  });

  it('applies the default bound when no limit is given', () => {
    let now = 0;
    const { cwd } = workspace();
    const store = openWorkspaceStore(cwd, () => now);
    store.joinAgent({ id: 'manager', role: 'manager' });
    store.joinAgent({ id: 'worker', role: 'worker' });
    for (let i = 1; i <= DEFAULT_HISTORY_LIMIT + 2; i += 1) {
      now = i;
      store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: `note ${i}` });
    }

    const snapshot = buildSnapshot(store);
    expect(snapshot.messages).toHaveLength(DEFAULT_HISTORY_LIMIT);
    expect(snapshot.messages[0]?.id).toBe(3);
    expect(snapshot.messages.at(-1)?.id).toBe(DEFAULT_HISTORY_LIMIT + 2);
  });

  it('propagates the Store limit contract for an out-of-range bound', () => {
    const { cwd } = workspace();
    const store = openWorkspaceStore(cwd, () => 0);
    expect(() => buildSnapshot(store, { historyLimit: 0 })).toThrowError(/limit/);
    expect(() => buildSnapshot(store, { historyLimit: 1_001 })).toThrowError(/limit/);
  });
});

describe('buildSnapshot bounded task events', () => {
  it('carries only the newest TASK_EVENT_LIMIT events, oldest-to-newest', () => {
    let now = 0;
    const { cwd } = workspace();
    const store = openWorkspaceStore(cwd, () => now);
    store.joinAgent({ id: 'manager', role: 'manager' });
    store.joinAgent({ id: 'worker', role: 'worker' });
    const task = store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'manager',
      title: 'busy task',
    });
    // Each start->submit->requeue round appends three Events on top of `created`.
    const rounds = 17;
    for (let round = 1; round <= rounds; round += 1) {
      now = round;
      store.startTask('worker', task.id);
      store.submitTask('worker', task.id, `round ${round}`);
      store.requeueTask({ actorId: 'manager', taskId: task.id, reason: `round ${round}` });
    }

    const snapshot = buildSnapshot(store);
    const events = snapshot.tasks[0]!.events;
    const total = store.getTaskWithEvents(task.id).events.length;
    expect(total).toBe(rounds * 3 + 1);
    expect(events).toHaveLength(TASK_EVENT_LIMIT);
    // The oldest events (from `created` at revision 0) fell out of the
    // window; order stays ascending by revision up to the newest.
    expect(events[0]?.revision).toBe(total - TASK_EVENT_LIMIT);
    expect(events.at(-1)?.revision).toBe(total - 1);
    expect(events.map((event) => event.revision)).toEqual(
      [...events].sort((a, b) => a.revision - b.revision).map((event) => event.revision),
    );
  });
});

describe('buildSnapshot pruned-task fallback', () => {
  it('keeps the listed record when a Task disappears between the list and its re-read', () => {
    const { cwd } = workspace();
    const store = openWorkspaceStore(cwd, () => 0);
    store.joinAgent({ id: 'manager', role: 'manager' });
    store.joinAgent({ id: 'worker', role: 'worker' });
    const task = store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'manager',
      title: 'pruned mid-snapshot',
    });

    // Simulate a prune landing between listTasks and getTaskWithEvents: the
    // re-read finds nothing, so the snapshot must fall back to the listed row.
    const racing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'getTaskWithEvents') {
          return () => ({ task: null, events: [] });
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });

    const snapshot = buildSnapshot(racing);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({ id: task.id, title: 'pruned mid-snapshot' });
    expect(snapshot.tasks[0]!.events).toEqual([]);
  });
});
