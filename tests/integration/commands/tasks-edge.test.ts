import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../../src/init.js';
import { run } from '../../../src/run.js';
import { captureIo } from '../../helpers/io.js';
import type { Io } from '../../../src/io.js';

const made: string[] = [];

function workspace(clock: () => number) {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-task-edge-'));
  made.push(cwd);
  const capture = captureIo({ cwd, clock });
  initWorkspace(capture.io, { withGuides: false, json: false });
  capture.out.length = 0;
  return { cwd, ...capture };
}

async function joinAgents(io: Io, ...ids: string[]): Promise<void> {
  for (const id of ids) expect(await run(['join', id, '--json'], io)).toBe(0);
}

async function createTask(io: Io, out: string[]): Promise<string> {
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
        'Add X',
        '--json',
      ],
      io,
    ),
  ).toBe(0);
  const record = out
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((r) => r.type === 'task')!;
  return record.id as string;
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('crew task show/list — human Lease rendering', () => {
  it('renders an active Lease, then a stale one in show and list', async () => {
    let now = 0;
    const { io, out } = workspace(() => now);
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    // Worker starts the Task, taking a Lease that expires at now + 15 minutes.
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);

    // Active Lease: the else-branch renders "Lease <owner> until <ts>", no (stale).
    out.length = 0;
    expect(await run(['task', 'show', id], io)).toBe(0);
    const active = out.join('');
    // The Lease timestamp renders trimmed UTC ISO-8601 (start at now=0, the
    // 15-minute Lease expires at 900s) — no always-zero .000 millis (commit-4 fix).
    expect(active).toContain('Lease   worker until 1970-01-01T00:15:00Z');
    expect(active).not.toContain('.000Z');
    expect(active).not.toContain('(stale)');

    // Advance the clock past the Lease expiry so the same reads report it stale.
    now = 1_000_000;
    out.length = 0;
    expect(await run(['task', 'show', id], io)).toBe(0);
    expect(out.join('')).toContain('(stale)');

    out.length = 0;
    expect(await run(['task', 'list'], io)).toBe(0);
    expect(out.join('')).toContain('(stale)');
  });

  it('renders body, submission, and review blocks in a human task show', async () => {
    const { io, out } = workspace(() => 0);
    await joinAgents(io, 'manager', 'worker', 'inspector');
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
          'Add X',
          '--body',
          'do the thing',
          '--json',
        ],
        io,
      ),
    ).toBe(0);
    const id = out
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r.type === 'task')!.id as string;

    // Human-mode mutations exercise writeTaskMutation's non-JSON line.
    expect(await run(['task', 'start', 'worker', id], io)).toBe(0);
    expect(await run(['task', 'submit', 'worker', id, '--summary', 'implemented'], io)).toBe(0);
    expect(await run(['task', 'approve', 'inspector', id, '--summary', 'LGTM'], io)).toBe(0);

    out.length = 0;
    expect(await run(['task', 'show', id], io)).toBe(0);
    const shown = out.join('');
    expect(shown).toContain('Body');
    expect(shown).toContain('Submission');
    expect(shown).toContain('Review');
  });
});
