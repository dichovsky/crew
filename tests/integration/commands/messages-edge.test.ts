// Edge/validation branches of src/messages.ts not exercised by messages.test.ts:
// reply-to id parsing, --file intake failures, stdin intake failures, positional
// bounds, and multi-message/short-preview human rendering. All driven through run().
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../../src/init.js';
import { run } from '../../../src/run.js';
import { captureIo } from '../../helpers/io.js';

const MAX_MESSAGE_BYTES = 100_000 * 4;

const made: string[] = [];

function workspace(clock: () => number = () => 0) {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-message-edge-'));
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

describe('Message command edge cases', () => {
  it('rejects reply-to ids that are not positive safe integers', async () => {
    const { io, err } = workspace();
    // Fail the shape regex (non-digit and leading zero) -> messageId regex guard.
    for (const bad of ['abc', '0']) {
      expect(
        await run(['send', 'worker', 'manager', 'reply', '--reply-to', bad, '--json'], io),
      ).toBe(2);
      expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'USAGE' } });
    }
    // Passes the regex but overflows the safe-integer range -> messageId safe-int guard.
    expect(
      await run(
        ['send', 'worker', 'manager', 'reply', '--reply-to', '99999999999999999999', '--json'],
        io,
      ),
    ).toBe(2);
    expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'USAGE' } });
  });

  it('maps --file stat, size, and empty-content failures to typed errors', async () => {
    const { cwd, io, err } = workspace();

    // Absolute path to a directory -> isAbsolute true + not-a-regular-file + CrewError rethrow.
    expect(await run(['send', 'manager', 'worker', '--file', cwd, '--json'], io)).toBe(2);
    expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'USAGE' } });

    // Absolute path with no file -> ENOENT mapped to NOT_FOUND.
    expect(
      await run(['send', 'manager', 'worker', '--file', join(cwd, 'missing.txt'), '--json'], io),
    ).toBe(1);
    expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'NOT_FOUND' } });

    // Regular file larger than the byte bound -> rejected on statSync size before decode.
    const huge = join(cwd, 'huge.bin');
    writeFileSync(huge, Buffer.alloc(MAX_MESSAGE_BYTES + 1));
    expect(await run(['send', 'manager', 'worker', '--file', huge, '--json'], io)).toBe(2);
    expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'USAGE' } });

    // Empty regular file -> decodeMessage rejects the zero-length window.
    const empty = join(cwd, 'empty.txt');
    writeFileSync(empty, '');
    expect(await run(['send', 'manager', 'worker', '--file', empty, '--json'], io)).toBe(2);
    expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'USAGE' } });
  });

  it('accepts string-mode stdin chunks and bounds oversize stdin', async () => {
    const { cwd, io } = workspace();
    await joinAgents(io, 'manager', 'worker');

    // Object/string-mode chunk exercises the non-Buffer intake branch and sends successfully.
    const strim = captureIo({ cwd, stdin: Readable.from(['hello world']) });
    expect(await run(['send', 'manager', 'worker', '--file', '-', '--json'], strim.io)).toBe(0);
    expect(records(strim.out)[0]?.content).toBe('hello world');

    // A single chunk beyond the byte bound fails mid-stream.
    const big = captureIo({ cwd, stdin: Readable.from([Buffer.alloc(MAX_MESSAGE_BYTES + 1)]) });
    expect(await run(['send', 'manager', 'worker', '--file', '-', '--json'], big.io)).toBe(2);
    expect(JSON.parse(big.err.pop()!)).toMatchObject({ error: { code: 'USAGE' } });
  });

  it('rejects invalid-UTF8 stdin and non-Error stream failures', async () => {
    const { cwd } = workspace();

    // Invalid UTF-8 reaches decode at end-of-stream and rejects from the onEnd catch.
    const bad = captureIo({ cwd, stdin: Readable.from([Buffer.from([0xc3, 0x28])]) });
    expect(await run(['send', 'manager', 'worker', '--file', '-', '--json'], bad.io)).toBe(2);
    expect(JSON.parse(bad.err.pop()!)).toMatchObject({ error: { code: 'USAGE' } });

    // A non-Error 'error' event is normalised into a generic failure via the fail() branch.
    let raised = false;
    const stdin = new Readable({
      read(): void {
        if (raised) return;
        raised = true;
        process.nextTick(() => {
          this.emit('error', 'stdin exploded');
        });
      },
    });
    const boom = captureIo({ cwd, stdin });
    expect(await run(['send', 'manager', 'worker', '--file', '-', '--json'], boom.io)).toBe(1);
    expect(JSON.parse(boom.err.pop()!)).toMatchObject({ error: { code: 'ERROR' } });
  });

  it('rejects positional content beyond the code-point bound', async () => {
    const { io, err } = workspace();
    expect(await run(['send', 'manager', 'worker', 'a'.repeat(100_001), '--json'], io)).toBe(2);
    expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'USAGE' } });
  });

  it('renders multiple short human history messages with a blank separator', async () => {
    const { io, out } = workspace();
    await joinAgents(io, 'manager', 'worker');
    out.length = 0;
    await run(['send', 'manager', 'worker', 'hello', '--json'], io);
    await run(['send', 'manager', 'worker', 'world', '--json'], io);
    out.length = 0;

    expect(await run(['history', '--agent', 'worker'], io)).toBe(0);
    const text = out.join('');
    expect(text).toContain('hello');
    expect(text).toContain('world');
    // index > 0 blank separator between rendered messages.
    expect(text).toContain('\n\n');
    // Short content is returned unchanged (no bounded-preview ellipsis).
    expect(text).not.toContain('…');
  });
});
