import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../../src/init.js';
import { run } from '../../../src/run.js';
import { Store } from '../../../src/store/index.js';
import { captureIo } from '../../helpers/io.js';
import type { Io } from '../../../src/io.js';

const made: string[] = [];

function workspace(clock: () => number) {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-prune-'));
  made.push(cwd);
  const capture = captureIo({ cwd, clock });
  initWorkspace(capture.io, { withGuides: false, json: false });
  capture.out.length = 0;
  return { cwd, ...capture };
}

function record(output: readonly string[]): Record<string, unknown> {
  const lines = output.join('').split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

async function joinAgents(io: Io, ...ids: string[]): Promise<void> {
  for (const id of ids) expect(await run(['join', id, '--json'], io)).toBe(0);
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('crew prune', () => {
  it('emits a zero-count prune_result on an empty store', async () => {
    const { io, out, err } = workspace(() => 0);
    expect(await run(['prune', '--json'], io)).toBe(0);
    expect(err).toEqual([]);
    expect(record(out)).toEqual({
      type: 'prune_result',
      schema_version: 1,
      messages_deleted: 0,
      tasks_deleted: 0,
      vacuumed: false,
    });
  });

  it('deletes read Messages older than the cutoff (strict boundary)', async () => {
    let now = 0;
    const { io, out } = workspace(() => now);
    await joinAgents(io, 'manager', 'worker');
    now = 100;
    expect(await run(['send', 'manager', 'worker', 'hi', '--json'], io)).toBe(0);
    now = 150;
    expect(await run(['receive', 'worker', '--json'], io)).toBe(0);
    out.length = 0;

    now = 1000;
    // cutoff 1000 - 900 = 100; created_at 100 is NOT < 100 -> retained
    expect(await run(['prune', '--messages-before', '900s', '--json'], io)).toBe(0);
    expect(record(out)).toMatchObject({ messages_deleted: 0 });
    out.length = 0;

    // cutoff 1000 - 899 = 101; created_at 100 < 101 -> deleted
    expect(await run(['prune', '--messages-before', '899s', '--json'], io)).toBe(0);
    expect(record(out)).toMatchObject({ messages_deleted: 1 });
  });

  it('rejects an invalid duration as USAGE before touching the store', async () => {
    const { io, err } = workspace(() => 0);
    expect(await run(['prune', '--messages-before', '1d12h', '--json'], io)).toBe(2);
    expect(JSON.parse(err.join(''))).toMatchObject({ error: { code: 'USAGE' } });
  });

  it('refuses --vacuum while active Agents exist and still emits prune_result', async () => {
    const { io, out, err } = workspace(() => 0);
    await joinAgents(io, 'manager');
    out.length = 0;
    expect(await run(['prune', '--vacuum', '--json'], io)).toBe(1);
    expect(record(out)).toMatchObject({ type: 'prune_result', vacuumed: false });
    expect(JSON.parse(err.join(''))).toMatchObject({ error: { code: 'ACTIVE_AGENTS' } });
  });

  it('vacuums when no Agent is active', async () => {
    const { io, out } = workspace(() => 0);
    await joinAgents(io, 'manager');
    expect(await run(['leave', 'manager', '--json'], io)).toBe(0);
    out.length = 0;
    expect(await run(['prune', '--vacuum', '--json'], io)).toBe(0);
    expect(record(out)).toMatchObject({ type: 'prune_result', vacuumed: true });
  });

  it('still emits prune_result when VACUUM fails after the prune commits', async () => {
    const { io, out, err } = workspace(() => 0);
    await joinAgents(io, 'manager');
    expect(await run(['leave', 'manager', '--json'], io)).toBe(0); // 0 active -> vacuum proceeds
    out.length = 0;
    const spy = vi.spyOn(Store.prototype, 'vacuum').mockImplementation(() => {
      throw new Error('disk full');
    });
    try {
      expect(await run(['prune', '--vacuum', '--json'], io)).toBe(1);
      expect(record(out)).toMatchObject({ type: 'prune_result', vacuumed: false });
      expect(err.join('')).not.toBe('');
    } finally {
      spy.mockRestore();
    }
  });

  it('renders a human prune summary', async () => {
    const { io, out } = workspace(() => 0);
    expect(await run(['prune'], io)).toBe(0);
    expect(out.join('')).toContain('Pruned 0 message(s) and 0 task(s).');
  });
});
