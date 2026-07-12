import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../../src/init.js';
import { run } from '../../../src/run.js';
import { captureIo } from '../../helpers/io.js';
import type { Io } from '../../../src/io.js';

const made: string[] = [];

function workspace(clock: () => number = () => 0) {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-clean-'));
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

describe('crew clean', () => {
  it('is a no-op with an empty removed list when no store exists', async () => {
    const { io, out, err } = workspace();
    expect(await run(['clean', '--json'], io)).toBe(0);
    expect(err).toEqual([]);
    expect(record(out)).toEqual({
      type: 'clean_result',
      schema_version: 1,
      removed: [],
      forced: false,
    });
  });

  it('refuses while an Agent is active', async () => {
    const { io, out, err } = workspace();
    await joinAgents(io, 'manager');
    out.length = 0;
    expect(await run(['clean', '--json'], io)).toBe(1);
    expect(out).toEqual([]);
    expect(JSON.parse(err.join(''))).toMatchObject({ error: { code: 'ACTIVE_AGENTS' } });
    expect(existsSync(join(io.cwd, '.crew', 'state', 'crew.db'))).toBe(true);
  });

  it('removes the State Store when no Agent is active', async () => {
    const { io, out } = workspace();
    await joinAgents(io, 'manager');
    expect(await run(['leave', 'manager', '--json'], io)).toBe(0);
    out.length = 0;
    expect(await run(['clean', '--json'], io)).toBe(0);
    expect((record(out).removed as string[]).includes('crew.db')).toBe(true);
    expect(existsSync(join(io.cwd, '.crew', 'state', 'crew.db'))).toBe(false);
  });

  it('removes orphaned WAL/SHM sidecars without --force', async () => {
    const { io, out, cwd } = workspace();
    writeFileSync(join(cwd, '.crew', 'state', 'crew.db-wal'), 'wal');
    writeFileSync(join(cwd, '.crew', 'state', 'crew.db-shm'), 'shm');

    expect(await run(['clean', '--json'], io)).toBe(0);
    expect(record(out)).toEqual({
      type: 'clean_result',
      schema_version: 1,
      removed: ['crew.db', 'crew.db-wal', 'crew.db-shm'],
      forced: false,
    });
    expect(existsSync(join(cwd, '.crew', 'state', 'crew.db'))).toBe(false);
    expect(existsSync(join(cwd, '.crew', 'state', 'crew.db-wal'))).toBe(false);
    expect(existsSync(join(cwd, '.crew', 'state', 'crew.db-shm'))).toBe(false);
  });

  it('--force removes State Store files even when the database is corrupt', async () => {
    const { io, out, cwd } = workspace();
    // Write a non-SQLite file at the db path: a normal open would fail.
    writeFileSync(join(cwd, '.crew', 'state', 'crew.db'), 'not a database');
    out.length = 0;
    expect(await run(['clean', '--force', '--json'], io)).toBe(0);
    expect(record(out)).toMatchObject({ type: 'clean_result', forced: true });
    expect((record(out).removed as string[]).includes('crew.db')).toBe(true);
    expect(existsSync(join(cwd, '.crew', 'state', 'crew.db'))).toBe(false);
  });

  it('refuses a corrupt db without --force and leaves it in place', async () => {
    const { io, err, cwd } = workspace();
    writeFileSync(join(cwd, '.crew', 'state', 'crew.db'), 'not a database');
    expect(await run(['clean', '--json'], io)).toBe(1);
    expect(JSON.parse(err.join(''))).toMatchObject({ error: { code: 'ACTIVE_AGENTS' } });
    expect(existsSync(join(cwd, '.crew', 'state', 'crew.db'))).toBe(true);
  });

  it('never removes tracked config (roles/teams)', async () => {
    const { io, cwd } = workspace();
    await joinAgents(io, 'manager');
    expect(await run(['leave', 'manager'], io)).toBe(0);
    expect(await run(['clean', '--force'], io)).toBe(0);
    expect(readdirSync(join(cwd, '.crew', 'roles')).length).toBeGreaterThan(0);
    expect(readdirSync(join(cwd, '.crew', 'teams')).length).toBeGreaterThan(0);
  });
});
