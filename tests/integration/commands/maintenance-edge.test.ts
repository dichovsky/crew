import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../../src/init.js';
import { run } from '../../../src/run.js';
import { captureIo } from '../../helpers/io.js';
import type { Io } from '../../../src/io.js';

const made: string[] = [];

function workspace(clock: () => number = () => 0) {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-maint-'));
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

describe('crew prune edge branches', () => {
  // Line 66: options.tasksBefore !== undefined -> parseDuration(tasksBefore).
  // The template only ever passes --messages-before, so the tasks-before parse
  // branch is otherwise never taken.
  it('parses --tasks-before and emits a prune_result', async () => {
    const { io, out, err } = workspace();
    expect(await run(['prune', '--tasks-before', '900s', '--json'], io)).toBe(0);
    expect(err).toEqual([]);
    expect(record(out)).toEqual({
      type: 'prune_result',
      schema_version: 1,
      messages_deleted: 0,
      tasks_deleted: 0,
      vacuumed: false,
    });
  });

  // Line 55: the vacuumed === true arm of the human summary ternary
  // (`; reclaimed free space`). The template's vacuum-true case uses --json;
  // its only human case is vacuumed === false.
  it('renders the reclaimed-space human summary when vacuuming', async () => {
    const { io, out } = workspace();
    await joinAgents(io, 'manager');
    expect(await run(['leave', 'manager', '--json'], io)).toBe(0); // 0 active -> vacuum proceeds
    out.length = 0;
    expect(await run(['prune', '--vacuum'], io)).toBe(0);
    expect(out.join('')).toBe('Pruned 0 message(s) and 0 task(s); reclaimed free space.\n');
  });
});

describe('crew clean edge branches', () => {
  // Line 109: the removed.length === 0 arm of the human clean summary
  // (`Nothing to remove.`). The template's empty-removed cases all use --json.
  it('renders the nothing-to-remove human summary when no store exists', async () => {
    const { io, out, err } = workspace();
    expect(await run(['clean'], io)).toBe(0);
    expect(err).toEqual([]);
    expect(out.join('')).toBe('Nothing to remove.\n');
  });

  // Line 121: a non-ENOENT unlink error is rethrown. Placing a directory at the
  // db path makes unlinkSync fail with EPERM/EISDIR (not ENOENT), so the guard's
  // rethrow arm fires instead of the already-absent (ENOENT) skip arm.
  it('rethrows a non-ENOENT unlink failure under --force', async () => {
    const { io, out, err, cwd } = workspace();
    mkdirSync(join(cwd, '.crew', 'state', 'crew.db'), { recursive: true });
    out.length = 0;
    expect(await run(['clean', '--force'], io)).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('')).toContain('[ERROR]');
  });
});
