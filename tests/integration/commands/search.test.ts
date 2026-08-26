import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../../src/init.js';
import { run } from '../../../src/run.js';
import { captureIo } from '../../helpers/io.js';

const made: string[] = [];

function workspace(clock: () => number = () => 0) {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-search-command-'));
  made.push(cwd);
  const capture = captureIo({ cwd, clock });
  initWorkspace(capture.io, { withGuides: false, json: false });
  capture.out.length = 0;
  return { cwd, ...capture };
}

async function joinAgents(io: ReturnType<typeof captureIo>['io']): Promise<void> {
  for (const id of ['manager', 'worker', 'inspector']) {
    expect(await run(['join', id, '--json'], io)).toBe(0);
  }
}

function records(output: readonly string[]): Array<Record<string, unknown>> {
  return output.map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('search command', () => {
  it('preserves phrase argv boundaries and emits Messages then Task Events as stable NDJSON', async () => {
    let now = 1;
    const { io, out, err } = workspace(() => now);
    await joinAgents(io);
    out.length = 0;
    now = 10;
    await run(
      ['send', 'manager', 'worker', 'lease bright inspector\u001b[31m\u0007', '--json'],
      io,
    );
    now = 20;
    await run(['send', 'worker', 'manager', 'lease inspector', '--json'], io);
    now = 30;
    await run(
      [
        'task',
        'create',
        'manager',
        'worker',
        '--reviewer',
        'inspector',
        '--title',
        'Neutral task',
        '--json',
      ],
      io,
    );
    const taskId = String(records(out).at(-1)?.id);
    now = 31;
    await run(['task', 'start', 'worker', taskId, '--json'], io);
    now = 32;
    await run(
      [
        'task',
        'submit',
        'worker',
        taskId,
        '--summary',
        'lease inspector event\u001b[32m\u0007',
        '--json',
      ],
      io,
    );
    out.length = 0;

    // Two argv clauses are ANDed, so the non-contiguous Message also matches.
    expect(await run(['search', 'lease', 'inspector', '--json'], io)).toBe(0);
    expect(err).toEqual([]);
    const all = records(out);
    expect(all.map((row) => row.scope)).toEqual(['message', 'message', 'task_event']);
    expect(all[0]).toMatchObject({
      type: 'search_result',
      schema_version: 1,
      scope: 'message',
      sender_id: 'worker',
      recipient_id: 'manager',
      actor_id: null,
      event_type: null,
      revision: null,
    });
    expect(typeof all[0]?.rank).toBe('number');
    expect(all[2]).toMatchObject({
      type: 'search_result',
      schema_version: 1,
      scope: 'task_event',
      task_id: taskId,
      actor_id: 'worker',
      event_type: 'submitted',
      revision: 2,
      sender_id: null,
      recipient_id: null,
      kind: null,
    });
    expect(String(all[2]?.snippet)).toContain('\u001b[32m\u0007');

    // A shell-quoted phrase reaches run() as one argv element.
    out.length = 0;
    expect(await run(['search', 'lease inspector', '--json'], io)).toBe(0);
    expect(records(out).map((row) => row.scope)).toEqual(['message', 'task_event']);
  });

  it('sanitizes only human snippets and renders each selected scope contract', async () => {
    const { io, out } = workspace();
    await joinAgents(io);
    out.length = 0;
    await run(['send', 'manager', 'worker', 'needle\u001b[31m forged\u0007\nNEXT', '--json'], io);
    out.length = 0;
    expect(await run(['search', 'needle'], io)).toBe(0);
    const human = out.join('');
    expect(human).toContain('MESSAGES\n');
    expect(human).toContain('TASK EVENTS\nNo matching task events.\n');
    expect(human).toContain('  needle forged\n  NEXT\n');
    expect(human).not.toContain('\u001b');
    expect(human).not.toContain('\u0007');
    expect(human).not.toContain('rank');

    out.length = 0;
    expect(await run(['search', 'absent'], io)).toBe(0);
    expect(out).toEqual(['No results.\n']);

    out.length = 0;
    expect(await run(['search', 'absent', '--scope', 'messages'], io)).toBe(0);
    expect(out.join('')).toBe('MESSAGES\nNo matching messages.\n');

    out.length = 0;
    expect(await run(['search', 'absent', '--scope', 'task-events'], io)).toBe(0);
    expect(out.join('')).toBe('TASK EVENTS\nNo matching task events.\n');

    out.length = 0;
    expect(await run(['search', 'absent', '--json'], io)).toBe(0);
    expect(out).toEqual([]);
  });

  it('applies scope, Agent, inclusive time, prefix, and per-scope limit filters', async () => {
    let now = 10;
    const { io, out, err } = workspace(() => now);
    await joinAgents(io);
    out.length = 0;
    await run(['send', 'manager', 'worker', 'searchable older', '--json'], io);
    now = 20;
    await run(['send', 'inspector', 'manager', 'searching newer', '--json'], io);
    out.length = 0;

    expect(
      await run(
        [
          'search',
          'search*',
          '--scope',
          'messages',
          '--agent',
          'manager',
          '--since',
          '20',
          '--limit',
          '1',
          '--json',
        ],
        io,
      ),
    ).toBe(0);
    expect(records(out)).toHaveLength(1);
    expect(records(out)[0]).toMatchObject({ sender_id: 'inspector', created_at: 20 });

    out.length = 0;
    expect(await run(['search', 'search*', '--agent', 'missing', '--json'], io)).toBe(1);
    expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('validates the closed command shape before opening a Workspace', async () => {
    const { io, out, err } = workspace();
    const invalid = [
      ['search', '--json'],
      ['search', 'x'.repeat(501), '--json'],
      ['search', 'x', '--limit', '0', '--json'],
      ['search', 'x', '--limit', '501', '--json'],
      ['search', 'x', '--since', 'yesterday', '--json'],
      ['search', 'x', '--scope', 'bogus', '--json'],
      ['search', 'x', '--reindex', '--json'],
      ['search', '--reindex', '--scope', 'all', '--json'],
      ['search', '--reindex', '--limit', '1', '--json'],
    ];
    for (const argv of invalid) {
      expect(await run(argv, io)).toBe(2);
      expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'USAGE' } });
    }
    expect(out).toEqual([]);
  });

  it('reindexes both scopes and renders the result on both surfaces', async () => {
    const { io, out } = workspace();
    await joinAgents(io);
    out.length = 0;
    await run(['send', 'manager', 'worker', 'indexed', '--json'], io);
    out.length = 0;

    expect(await run(['search', '--reindex', '--json'], io)).toBe(0);
    const result = records(out)[0]!;
    expect(result).toMatchObject({
      type: 'reindex_result',
      schema_version: 1,
      messages_indexed: 1,
      task_events_indexed: 0,
    });

    out.length = 0;
    expect(await run(['search', '--reindex'], io)).toBe(0);
    expect(out.join('')).toBe('Reindexed 1 messages and 0 task events.\n');
  });

  it('advertises search and exact Message retrieval in command help', async () => {
    const { io, out } = workspace();
    expect(await run(['search', '--help'], io)).toBe(0);
    expect(out.join('')).toContain('search [options] [query...]');
    expect(out.join('')).toContain('--reindex');
    out.length = 0;
    expect(await run(['history', '--help'], io)).toBe(0);
    expect(out.join('')).toContain('--id <message-id>');
    expect(out.join('')).toContain('requires --json');
  });
});
