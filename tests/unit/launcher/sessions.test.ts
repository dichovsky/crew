/**
 * Unit tests for listOwnedSessions: the Console Operations view lists exactly
 * the crew-owned tmux sessions that are live and owner-token-matched right now.
 * A stale artifact (session gone), a same-name session with a different owner,
 * a malformed pane-map, and an absent tmux all resolve to "not listed" — the
 * listing never invents a session the Console could not actually stop.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../../src/init.js';
import { type PaneMap, writePaneMap } from '../../../src/launcher/artifacts.js';
import { listOwnedSessions } from '../../../src/launcher/sessions.js';
import { createTmuxAdapter, type TmuxAdapter } from '../../../src/launcher/tmux.js';
import { captureIo } from '../../helpers/io.js';

const made: string[] = [];
const OWNER = '123e4567-e89b-42d3-a456-426614174000';

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-sessions-'));
  made.push(dir);
  initWorkspace(captureIo({ cwd: dir }).io, { withGuides: false, json: false });
  return dir;
}

function writeMap(cwd: string, session: string, agentIds: readonly string[]): void {
  const map: PaneMap = {
    schema_version: 1,
    session_name: session,
    ownership_token: OWNER,
    relay_window: { present: true, name: 'crew-relay', pane_id: '%99' },
    panes: agentIds.map((agentId, index) => ({
      pane_id: `%${index + 1}`,
      window: 'crew',
      agent_id: agentId,
      role: 'worker',
      executable: 'codex',
      invocation: `$crew worker ${agentId}`,
      readiness_names: ['codex'],
    })),
  };
  writePaneMap(cwd, session, map);
}

/** A fake adapter answering only the three reads listOwnedSessions makes. */
function fakeAdapter(options: {
  present?: boolean;
  live?: ReadonlySet<string>;
  owner?: (session: string) => string | null;
}): { adapter: TmuxAdapter; ops: string[] } {
  const ops: string[] = [];
  const unused = () => Promise.reject(new Error('unexpected tmux operation'));
  return {
    ops,
    adapter: {
      isPresent: () => Promise.resolve(options.present ?? true),
      hasSession: (session) => {
        ops.push(`hasSession:${session}`);
        return Promise.resolve(options.live?.has(session) ?? true);
      },
      sessionOwner: (session) => {
        ops.push(`sessionOwner:${session}`);
        return Promise.resolve(options.owner ? options.owner(session) : OWNER);
      },
      newSession: unused,
      splitPane: unused,
      tileLayout: unused,
      paneCommand: unused,
      setSessionOwner: unused,
      capturePane: unused,
      setBufferArg: unused,
      loadBufferFile: unused,
      pasteBuffer: unused,
      sendEnter: unused,
      newWindow: unused,
      killSession: unused,
      attach: unused,
    },
  };
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('listOwnedSessions', () => {
  it('returns [] when the generated directory does not exist', async () => {
    const cwd = workspace();
    const { io } = captureIo({ cwd });
    const fake = fakeAdapter({});
    await expect(listOwnedSessions(io, { adapter: fake.adapter })).resolves.toEqual([]);
    // Never asked tmux anything: there was nothing on disk to verify.
    expect(fake.ops).toEqual([]);
  });

  it('lists a live, owner-matched session with pane and agent counts', async () => {
    const cwd = workspace();
    writeMap(cwd, 'crew-dev', ['ada', 'linus']);
    const { io } = captureIo({ cwd });
    const [session, ...rest] = await listOwnedSessions(io, { adapter: fakeAdapter({}).adapter });
    expect(rest).toEqual([]);
    expect(session).toMatchObject({
      sessionName: 'crew-dev',
      paneCount: 3, // 2 agent panes + the Relay pane
      agentCount: 2,
    });
    expect(typeof session!.startedAt).toBe('number');
  });

  it('omits a session whose live owner token does not match the pane map', async () => {
    const cwd = workspace();
    writeMap(cwd, 'crew-dev', ['ada']);
    const { io } = captureIo({ cwd });
    const fake = fakeAdapter({ owner: () => 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    await expect(listOwnedSessions(io, { adapter: fake.adapter })).resolves.toEqual([]);
  });

  it('omits a session whose tmux session is no longer live', async () => {
    const cwd = workspace();
    writeMap(cwd, 'crew-dev', ['ada']);
    const { io } = captureIo({ cwd });
    const fake = fakeAdapter({ live: new Set() });
    await expect(listOwnedSessions(io, { adapter: fake.adapter })).resolves.toEqual([]);
  });

  it('skips a malformed pane map instead of failing the whole listing', async () => {
    const cwd = workspace();
    writeMap(cwd, 'good', ['ada']);
    // A second generated dir whose pane-map is not valid JSON.
    writeMap(cwd, 'bad', ['linus']);
    writeFileSync(join(cwd, '.crew', 'generated', 'bad', 'pane-map.json'), 'not json {');
    const { io } = captureIo({ cwd });
    const names = (await listOwnedSessions(io, { adapter: fakeAdapter({}).adapter })).map(
      (s) => s.sessionName,
    );
    expect(names).toEqual(['good']);
  });

  it('reports nothing when tmux is not present to verify liveness', async () => {
    const cwd = workspace();
    writeMap(cwd, 'crew-dev', ['ada']);
    const { io } = captureIo({ cwd });
    const fake = fakeAdapter({ present: false });
    await expect(listOwnedSessions(io, { adapter: fake.adapter })).resolves.toEqual([]);
    expect(fake.ops).toEqual([]);
  });

  it('surfaces a killed availability probe as a generic ERROR, never an empty listing', async () => {
    const cwd = workspace();
    writeMap(cwd, 'crew-dev', ['ada']);
    const { io } = captureIo({
      cwd,
      runProcess: () =>
        Promise.resolve({ status: null, stdout: '', stderr: '', killed: true, signal: 'SIGTERM' }),
    });
    await expect(listOwnedSessions(io, { adapter: createTmuxAdapter(io) })).rejects.toMatchObject({
      code: 'ERROR',
      message: 'the tmux availability probe (tmux -V) did not exit cleanly (signal SIGTERM)',
    });
  });

  it('surfaces a killed liveness check as a generic ERROR, not LAUNCH_FAILED', async () => {
    const cwd = workspace();
    writeMap(cwd, 'crew-dev', ['ada']);
    const { io } = captureIo({
      cwd,
      // The probe succeeds; the per-session has-session check is killed.
      runProcess: (_file, args) =>
        args[0] === '-V'
          ? Promise.resolve({ status: 0, stdout: 'tmux 3.5a\n', stderr: '' })
          : Promise.resolve({
              status: null,
              stdout: '',
              stderr: '',
              killed: true,
              signal: 'SIGTERM',
            }),
    });
    await expect(listOwnedSessions(io, { adapter: createTmuxAdapter(io) })).rejects.toMatchObject({
      code: 'ERROR',
      message: 'tmux has-session did not exit cleanly (signal SIGTERM)',
    });
  });

  it('orders multiple live sessions newest-launch-first', async () => {
    const cwd = workspace();
    writeMap(cwd, 'older', ['ada']);
    writeMap(cwd, 'newer', ['linus']);
    // Force a deterministic ordering by stamping distinct pane-map mtimes.
    const { utimesSync } = await import('node:fs');
    utimesSync(join(cwd, '.crew', 'generated', 'older', 'pane-map.json'), 1000, 1000);
    utimesSync(join(cwd, '.crew', 'generated', 'newer', 'pane-map.json'), 2000, 2000);
    const { io } = captureIo({ cwd });
    const names = (await listOwnedSessions(io, { adapter: fakeAdapter({}).adapter })).map(
      (s) => s.sessionName,
    );
    expect(names).toEqual(['newer', 'older']);
  });

  it('ignores non-directory entries under the generated directory', async () => {
    const cwd = workspace();
    writeMap(cwd, 'crew-dev', ['ada']);
    // A stray file next to the session directories must not be treated as one.
    writeFileSync(join(cwd, '.crew', 'generated', 'stray.txt'), 'not a session\n');
    const { io } = captureIo({ cwd });
    const names = (await listOwnedSessions(io, { adapter: fakeAdapter({}).adapter })).map(
      (s) => s.sessionName,
    );
    expect(names).toEqual(['crew-dev']);
  });
});
