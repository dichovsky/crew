import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../../src/init.js';
import { run } from '../../../src/run.js';
import { captureIo } from '../../helpers/io.js';

const made: string[] = [];

function workspace(clock: () => number = () => 0) {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-message-command-'));
  made.push(cwd);
  const capture = captureIo({ cwd, clock });
  initWorkspace(capture.io, { withGuides: false, json: false });
  capture.out.length = 0;
  return { cwd, ...capture };
}

async function joinAgents(io: ReturnType<typeof captureIo>['io'], ...ids: string[]): Promise<void> {
  for (const id of ids) expect(await run(['join', id, '--json'], io)).toBe(0);
}

function records(output: readonly string[]): Array<Record<string, unknown>> {
  return output.map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('Message commands', () => {
  it('sends positional content and emits the stable Message NDJSON contract', async () => {
    const { io, out, err } = workspace();
    await joinAgents(io, 'manager', 'worker');
    out.length = 0;
    expect(await run(['send', 'manager', 'worker', 'Inspect', 'X', '--json'], io)).toBe(0);
    expect(err).toEqual([]);
    expect(JSON.parse(out.join(''))).toEqual({
      type: 'message',
      schema_version: 1,
      id: 1,
      sender_id: 'manager',
      recipient_id: 'worker',
      content: 'Inspect X',
      kind: 'note',
      task_id: null,
      reply_to: null,
      created_at: 0,
      read_at: null,
    });
  });

  it('reads relative files and stdin as strict UTF-8 without rewriting content', async () => {
    const first = workspace();
    await joinAgents(first.io, 'manager', 'worker');
    const exact = '\ufeffline one\nline two\n';
    writeFileSync(join(first.cwd, 'message.txt'), exact);
    first.out.length = 0;
    expect(
      await run(['send', 'manager', 'worker', '--file', 'message.txt', '--json'], first.io),
    ).toBe(0);
    expect(records(first.out)[0]?.content).toBe(exact);

    const second = workspace();
    await joinAgents(second.io, 'manager', 'worker');
    const stdin = Readable.from([Buffer.from('stdin\ncontent')]);
    const capture = captureIo({ cwd: second.cwd, stdin });
    expect(await run(['send', 'manager', 'worker', '--file', '-', '--json'], capture.io)).toBe(0);
    expect(records(capture.out)[0]?.content).toBe('stdin\ncontent');
  });

  it('rejects malformed UTF-8, conflicting/missing content, and invalid limits as USAGE', async () => {
    const { cwd, io, out, err } = workspace();
    await joinAgents(io, 'manager', 'worker');
    writeFileSync(join(cwd, 'bad.bin'), Buffer.from([0xc3, 0x28]));
    out.length = 0;
    for (const argv of [
      ['send', 'manager', 'worker', '--file', 'bad.bin', '--json'],
      ['send', 'manager', 'worker', 'text', '--file', 'bad.bin', '--json'],
      ['send', 'manager', 'worker', '--json'],
      ['receive', 'worker', '--limit', '0', '--json'],
      ['receive', 'worker', '--limit', '501', '--json'],
      ['history', '--limit', '1001', '--json'],
      ['pending', '--agent', 'worker', '--summary', '--limit', '1', '--json'],
    ]) {
      expect(await run(argv, io)).toBe(2);
      expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'USAGE' } });
    }
    expect(out).toEqual([]);
  });

  it('broadcasts one row per sorted recipient and reports zero recipients clearly', async () => {
    const { io, out } = workspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    out.length = 0;
    expect(await run(['send', 'manager', '@all', 'news', '--json'], io)).toBe(0);
    expect(records(out).map((row) => row.recipient_id)).toEqual(['inspector', 'worker']);
    await run(['leave', 'worker', '--json'], io);
    await run(['leave', 'inspector', '--json'], io);
    out.length = 0;
    expect(await run(['send', 'manager', '@all', 'nobody', '--json'], io)).toBe(0);
    expect(out).toEqual([]);
    expect(await run(['send', 'manager', '@all', 'nobody'], io)).toBe(0);
    expect(out).toEqual(['Broadcast reached 0 recipients.\n']);
  });

  it('supports direct replies and maps missing/inactive resources to domain errors', async () => {
    const { io, out, err } = workspace();
    await joinAgents(io, 'manager', 'worker', 'inspector');
    out.length = 0;
    await run(['send', 'manager', 'worker', 'question', '--json'], io);
    out.length = 0;
    expect(
      await run(['send', 'worker', 'manager', 'answer', '--reply-to', '1', '--json'], io),
    ).toBe(0);
    expect(records(out)[0]?.reply_to).toBe(1);
    expect(await run(['send', 'inspector', 'worker', 'no', '--reply-to', '1', '--json'], io)).toBe(
      1,
    );
    expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(await run(['send', 'manager', 'missing', 'no', '--json'], io)).toBe(1);
    expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'NOT_FOUND' } });
    await run(['leave', 'worker', '--json'], io);
    expect(await run(['send', 'manager', 'worker', 'no', '--json'], io)).toBe(1);
    expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'AGENT_INACTIVE' } });
    expect(await run(['send', 'manager', '@all', 'no', '--reply-to', '1', '--json'], io)).toBe(2);
    expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'USAGE' } });
  });

  it('keeps pending non-consuming and emits a complete content-free summary', async () => {
    const { io, out } = workspace();
    await joinAgents(io, 'manager', 'worker');
    out.length = 0;
    await run(['send', 'manager', 'worker', 'one', '--json'], io);
    await run(['send', 'manager', 'worker', 'two', '--json'], io);
    out.length = 0;
    expect(await run(['pending', '--agent', 'worker', '--limit', '1', '--json'], io)).toBe(0);
    expect(records(out).map((row) => row.content)).toEqual(['one']);
    out.length = 0;
    expect(await run(['pending', '--agent', 'worker', '--summary', '--json'], io)).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({
      type: 'inbox_state',
      schema_version: 1,
      agent_id: 'worker',
      unread_count: 2,
      max_unread_id: 2,
    });
    out.length = 0;
    expect(await run(['receive', 'worker', '--limit', '1', '--json'], io)).toBe(0);
    expect(records(out)[0]?.content).toBe('one');
    out.length = 0;
    expect(await run(['receive', 'worker', '--json'], io)).toBe(0);
    expect(records(out)[0]?.content).toBe('two');
    out.length = 0;
    expect(await run(['receive', 'worker', '--json'], io)).toBe(0);
    expect(out).toEqual([]);
  });

  it('lists global pending Messages oldest-first across recipients', async () => {
    let now = 0;
    const { io, out } = workspace(() => now);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    out.length = 0;
    now = 1;
    await run(['send', 'manager', 'worker', 'first', '--json'], io);
    now = 2;
    await run(['send', 'manager', 'inspector', 'second', '--json'], io);
    out.length = 0;

    expect(await run(['pending', '--json'], io)).toBe(0);
    expect(records(out).map((row) => [row.recipient_id, row.content])).toEqual([
      ['worker', 'first'],
      ['inspector', 'second'],
    ]);
  });

  it('validates and renders human pending summaries, including an empty Inbox', async () => {
    const { io, out, err } = workspace();
    await joinAgents(io, 'manager', 'worker');
    out.length = 0;

    expect(await run(['pending', '--summary'], io)).toBe(2);
    expect(out).toEqual([]);
    expect(err).toEqual(['[USAGE] pending --summary requires --agent\n']);

    await run(['send', 'manager', 'worker', 'one', '--json'], io);
    await run(['send', 'manager', 'worker', 'two', '--json'], io);
    out.length = 0;
    expect(await run(['pending', '--agent', 'worker', '--summary'], io)).toBe(0);
    expect(out).toEqual(['worker: 2 unread; max #2\n']);

    out.length = 0;
    await run(['receive', 'worker', '--json'], io);
    out.length = 0;
    expect(await run(['pending', '--agent', 'worker', '--summary'], io)).toBe(0);
    expect(out).toEqual(['worker: 0 unread; max none\n']);
    out.length = 0;
    expect(await run(['pending', '--agent', 'worker'], io)).toBe(0);
    expect(out).toEqual(['No messages.\n']);
  });

  it('retains a committed receive in history when output fails after commit', async () => {
    const { cwd, io, out } = workspace();
    await joinAgents(io, 'manager', 'worker');
    out.length = 0;
    await run(['send', 'manager', 'worker', 'recoverable', '--json'], io);
    const errors: string[] = [];
    const failedOutputIo = {
      ...io,
      stdout: () => {
        throw new Error('simulated output failure');
      },
      stderr: (text: string) => {
        errors.push(text);
      },
    };
    expect(await run(['receive', 'worker', '--json'], failedOutputIo)).toBe(1);
    expect(JSON.parse(errors[0]!)).toMatchObject({ error: { code: 'ERROR' } });

    const history = captureIo({ cwd });
    expect(await run(['history', '--agent', 'worker', '--json'], history.io)).toBe(0);
    expect(JSON.parse(history.out[0]!)).toMatchObject({ content: 'recoverable', read_at: 0 });
    const pending = captureIo({ cwd });
    expect(await run(['pending', '--agent', 'worker', '--json'], pending.io)).toBe(0);
    expect(pending.out).toEqual([]);
  });

  it('filters history with inclusive exact timestamps and returns newest windows in order', async () => {
    let now = 0;
    const { io, out, err } = workspace(() => now);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    out.length = 0;
    now = 1_767_225_600; // 2026-01-01T00:00:00Z
    await run(['send', 'manager', 'worker', 'edge', '--json'], io);
    now++;
    await run(['send', 'inspector', 'worker', 'latest', '--json'], io);
    out.length = 0;
    expect(
      await run(
        [
          'history',
          '--agent',
          'worker',
          '--from',
          'manager',
          '--to',
          'worker',
          '--since',
          '2026-01-01T02:00:00+02:00',
          '--json',
        ],
        io,
      ),
    ).toBe(0);
    expect(records(out).map((row) => row.content)).toEqual(['edge']);
    out.length = 0;
    expect(await run(['history', '--limit', '1', '--json'], io)).toBe(0);
    expect(records(out).map((row) => row.content)).toEqual(['latest']);
    for (const invalid of ['1.5', '9007199254740992', '2026-01-01', '2026-01-01T00:00:00.000Z']) {
      expect(await run(['history', '--since', invalid, '--json'], io)).toBe(2);
      expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'USAGE' } });
    }
  });

  it('renders exact-second human headers, safe continuation lines, and bounded previews', async () => {
    const { io, out } = workspace();
    await joinAgents(io, 'manager', 'worker');
    out.length = 0;
    const content = `\u001b[31mheading\u001b[0m\n# forged\n${'😀'.repeat(201)}`;
    expect(await run(['send', 'manager', 'worker', content], io)).toBe(0);
    const sent = out.join('');
    const header = '#1  manager -> worker  1970-01-01T00:00:00Z\n';
    expect(sent).toBe(`${header}  heading\n  # forged\n  ${'😀'.repeat(201)}\n`);
    out.length = 0;
    expect(await run(['pending', '--agent', 'worker'], io)).toBe(0);
    const pending = out.join('');
    const preview = `${header}  heading\n  # forged\n  ${'😀'.repeat(183)}…\n`;
    expect(pending).toBe(preview);
    out.length = 0;
    expect(await run(['history', '--agent', 'worker'], io)).toBe(0);
    expect(out.join('')).toBe(preview);
    out.length = 0;
    expect(await run(['receive', 'worker'], io)).toBe(0);
    expect(out.join('')).toBe(sent);
    out.length = 0;
    expect(await run(['receive', 'worker'], io)).toBe(0);
    expect(out).toEqual(['No messages.\n']);
  });
});
