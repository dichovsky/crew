import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../../src/init.js';
import { run } from '../../../src/run.js';
import { captureIo } from '../../helpers/io.js';

const made: string[] = [];

function workspace(clock: () => number = () => 0) {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-agent-command-'));
  made.push(cwd);
  const capture = captureIo({ cwd, clock });
  initWorkspace(capture.io, { withGuides: false, json: false });
  capture.out.length = 0;
  return { cwd, ...capture };
}

function record(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('Agent lifecycle commands', () => {
  it('joins and emits the complete Agent NDJSON record', async () => {
    const { io, out, err } = workspace();
    expect(
      await run(['join', 'worker', '--role', 'worker', '--platform', 'codex-cli', '--json'], io),
    ).toBe(0);
    expect(err).toEqual([]);
    expect(JSON.parse(out.join(''))).toEqual({
      type: 'agent',
      schema_version: 1,
      id: 'worker',
      role: 'worker',
      platform_id: 'codex-cli',
      status: 'active',
      activity: 'recent',
      joined_at: 0,
      last_seen: 0,
      archived_at: null,
      stale_lease_count: 0,
    });
  });

  it('stamps CREW_LAUNCH_TOKEN into the row but never renders it', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'crew-agent-command-'));
    made.push(cwd);
    const token = 'a'.repeat(64);
    const capture = captureIo({ cwd, clock: () => 0, env: { CREW_LAUNCH_TOKEN: token } });
    initWorkspace(capture.io, { withGuides: false, json: false });
    capture.out.length = 0;
    const { io, out } = capture;

    expect(await run(['join', 'worker', '--json'], io)).toBe(0);
    expect(out.join('')).not.toContain(token);
    expect(record(out.join(''))).not.toHaveProperty('launch_token');

    // The token is persisted as provenance for the launch-teardown reap...
    const db = new DatabaseSync(join(cwd, '.crew', 'state', 'crew.db'));
    const stored = db.prepare("SELECT launch_token FROM agents WHERE id = 'worker'").get() as {
      launch_token: string | null;
    };
    db.close();
    expect(stored.launch_token).toBe(token);

    // ...but neither the human nor the JSON agent listing ever echoes it.
    out.length = 0;
    await run(['agents'], io);
    expect(out.join('')).not.toContain(token);
    out.length = 0;
    await run(['agents', '--json'], io);
    expect(out.join('')).not.toContain(token);
  });

  it('uses the requested id as the default Role and renders human output', async () => {
    const { io, out } = workspace();
    expect(await run(['join', 'worker'], io)).toBe(0);
    expect(out.join('')).toMatch(/^ID\s+ROLE\s+PLATFORM\s+ACTIVITY\s+LAST SEEN/m);
    expect(out.join('')).toContain('worker');
    expect(out.join('')).toContain('recent');
    // LAST SEEN renders trimmed UTC ISO-8601 (no always-zero .000 millis) so the
    // agents surface stays consistent with tasks/messages (commit-4 fix).
    expect(out.join('')).toContain('1970-01-01T00:00:00Z');
    expect(out.join('')).not.toContain('.000Z');
  });

  it('lists active rows by default, includes archived with --all, and emits empty NDJSON', async () => {
    const empty = workspace();
    expect(await run(['agents', '--json'], empty.io)).toBe(0);
    expect(empty.out).toEqual([]);

    const { io, out } = workspace();
    await run(['join', 'worker', '--json'], io);
    await run(['join', 'manager', '--json'], io);
    await run(['leave', 'worker', '--json'], io);
    out.length = 0;
    expect(await run(['agents', '--json'], io)).toBe(0);
    expect(out.map((line) => record(line).id)).toEqual(['manager']);
    out.length = 0;
    expect(await run(['agents', '--all', '--json'], io)).toBe(0);
    expect(out.map((line) => record(line).id)).toEqual(['manager', 'worker']);
    expect(record(out[1]!).activity).toBe('archived');
  });

  it('leaves once, preserves last_seen, and rejects repeated leave', async () => {
    let now = 10;
    const { io, out, err } = workspace(() => now);
    await run(['join', 'worker', '--json'], io);
    now = 20;
    out.length = 0;
    expect(await run(['leave', 'worker', '--json'], io)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({
      status: 'archived',
      activity: 'archived',
      last_seen: 10,
      archived_at: 20,
    });
    out.length = 0;
    expect(await run(['leave', 'worker', '--json'], io)).toBe(1);
    expect(JSON.parse(err.at(-1)!)).toMatchObject({ error: { code: 'AGENT_INACTIVE' } });
  });

  it('leaves an active agent and prints human output', async () => {
    const { io, out } = workspace();
    await run(['join', 'worker'], io);
    out.length = 0;
    expect(await run(['leave', 'worker'], io)).toBe(0);
    const human = out.join('');
    expect(human).toContain('worker');
    expect(human).toContain('archived');
  });

  it('resumes exactly, preserves Role/platform, and supports explicit platform replacement', async () => {
    const { io, out, err } = workspace();
    await run(['join', 'worker', '--platform', 'codex-cli', '--json'], io);
    await run(['leave', 'worker', '--json'], io);
    out.length = 0;
    expect(await run(['join', 'worker', '--resume', '--json'], io)).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({ role: 'worker', platform_id: 'codex-cli' });
    expect(await run(['leave', 'worker', '--json'], io)).toBe(0);
    out.length = 0;
    expect(
      await run(['join', 'worker', '--resume', '--platform', 'gemini-cli', '--json'], io),
    ).toBe(0);
    expect(record(out[0]!).platform_id).toBe('gemini-cli');
    expect(await run(['join', 'worker', '--resume', '--json'], io)).toBe(1);
    expect(JSON.parse(err.at(-1)!)).toMatchObject({ error: { code: 'ALREADY_EXISTS' } });
  });

  it('maps Role conflict, missing Agent, and missing Role to domain errors', async () => {
    const { io, err } = workspace();
    expect(await run(['join', 'unknown-role', '--json'], io)).toBe(1);
    expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(await run(['leave', 'worker', '--json'], io)).toBe(1);
    expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'NOT_FOUND' } });
    await run(['join', 'worker', '--json'], io);
    await run(['leave', 'worker', '--json'], io);
    expect(await run(['join', 'worker', '--resume', '--role', 'manager', '--json'], io)).toBe(1);
    expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'ALREADY_EXISTS' } });
  });

  it('does not resume an archived Agent whose custom Role no longer resolves', async () => {
    const { cwd, io, err } = workspace();
    const rolePath = join(cwd, '.crew', 'roles', 'custom.md');
    writeFileSync(rolePath, 'Custom Role\n');
    expect(await run(['join', 'worker', '--role', 'custom', '--json'], io)).toBe(0);
    expect(await run(['leave', 'worker', '--json'], io)).toBe(0);
    rmSync(rolePath);
    expect(await run(['join', 'worker', '--resume', '--json'], io)).toBe(1);
    expect(JSON.parse(err.at(-1)!)).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('rejects malformed ids and unsupported platforms before creating a State Store', async () => {
    const first = workspace();
    expect(await run(['join', '@all', '--role', 'worker', '--json'], first.io)).toBe(2);
    expect(JSON.parse(first.err[0]!)).toMatchObject({ error: { code: 'USAGE' } });
    expect(existsSync(join(first.cwd, '.crew', 'state', 'crew.db'))).toBe(false);

    const second = workspace();
    expect(await run(['join', 'worker', '--platform', 'unsupported', '--json'], second.io)).toBe(1);
    expect(JSON.parse(second.err[0]!)).toMatchObject({
      error: { code: 'UNSUPPORTED_PLATFORM' },
    });
    expect(existsSync(join(second.cwd, '.crew', 'state', 'crew.db'))).toBe(false);
  });

  it('keeps success on stdout and errors on stderr', async () => {
    const { io, out, err } = workspace();
    expect(await run(['join', 'worker', '--json'], io)).toBe(0);
    expect(out).toHaveLength(1);
    expect(err).toEqual([]);
    out.length = 0;
    expect(await run(['leave', 'missing', '--json'], io)).toBe(1);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
  });

  it('sanitizes persisted table cells while preserving NDJSON fidelity', async () => {
    const { cwd, io, out } = workspace();
    expect(await run(['agents'], io)).toBe(0); // initialize schema v1
    const role = '\u001b[31mworker\nROLE\tvalue';
    const platform = '\u001b]0;owned\u0007codex-cli';
    const db = new DatabaseSync(join(cwd, '.crew', 'state', 'crew.db'));
    db.prepare(
      `INSERT INTO agents
        (id, role, platform_id, joined_at, last_seen, status, archived_at)
       VALUES ('worker', ?, ?, 0, 0, 'active', NULL)`,
    ).run(role, platform);
    db.close();

    out.length = 0;
    expect(await run(['agents'], io)).toBe(0);
    const human = out.join('');
    expect(human).not.toContain('\u001b');
    expect(human).toContain('worker\\nROLE\\tvalue');
    expect(human).toContain('codex-cli');

    out.length = 0;
    expect(await run(['agents', '--json'], io)).toBe(0);
    expect(record(out[0]!)).toMatchObject({ role, platform_id: platform });
  });
});

describe('Agent command parsing', () => {
  it('advertises join, leave, and agents in help', async () => {
    const { io, out } = workspace();
    expect(await run(['--help'], io)).toBe(0);
    expect(out.join('')).toMatch(/join \[options\] <id>/);
    expect(out.join('')).toMatch(/leave \[options\] <id>/);
    expect(out.join('')).toMatch(/agents/);
  });

  it('rejects invalid option combinations and extra operands as USAGE', async () => {
    const { io, err } = workspace();
    expect(await run(['agents', '--resume', '--json'], io)).toBe(2);
    expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'USAGE' } });
    expect(await run(['leave', 'worker', 'extra', '--json'], io)).toBe(2);
    expect(JSON.parse(err.pop()!)).toMatchObject({ error: { code: 'USAGE' } });
  });
});
