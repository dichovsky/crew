import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../../src/init.js';
import { type PaneMap, writePaneMap } from '../../../src/launcher/artifacts.js';
import { runTeamStop } from '../../../src/launcher/stop.js';
import type { TmuxAdapter } from '../../../src/launcher/tmux.js';
import { run } from '../../../src/run.js';
import { openWorkspaceStore } from '../../../src/store/index.js';
import { captureIo, recordingRunProcess } from '../../helpers/io.js';

const made: string[] = [];
const SESSION = 'crew-demo';
const OWNER = '123e4567-e89b-42d3-a456-426614174000';

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-stop-'));
  made.push(dir);
  initWorkspace(captureIo({ cwd: dir }).io, { withGuides: false, json: false });
  return dir;
}

function paneMap(agentIds: readonly string[]): PaneMap {
  return {
    schema_version: 1,
    session_name: SESSION,
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
}

function joinAgent(cwd: string, id: string): void {
  const store = openWorkspaceStore(cwd, () => 10);
  try {
    store.joinAgent({ id, role: 'worker' });
  } finally {
    store.close();
  }
}

function archiveAgent(cwd: string, id: string): void {
  const store = openWorkspaceStore(cwd, () => 20);
  try {
    store.leaveAgent(id);
  } finally {
    store.close();
  }
}

function agentStatuses(cwd: string): Map<string, string> {
  const store = openWorkspaceStore(cwd, () => 30);
  try {
    return new Map(store.listAgents({ includeArchived: true }).map((a) => [a.id, a.status]));
  } finally {
    store.close();
  }
}

function fakeAdapter(
  options: { present?: boolean; exists?: boolean; owner?: string | null } = {},
): {
  adapter: TmuxAdapter;
  ops: string[];
} {
  const ops: string[] = [];
  const unused = () => Promise.reject(new Error('unexpected tmux operation'));
  return {
    ops,
    adapter: {
      isPresent: () => {
        ops.push('isPresent');
        return Promise.resolve(options.present ?? true);
      },
      hasSession: (session) => {
        ops.push(`hasSession:${session}`);
        return Promise.resolve(options.exists ?? true);
      },
      killSession: (session) => {
        ops.push(`killSession:${session}`);
        return Promise.resolve();
      },
      newSession: unused,
      splitPane: unused,
      tileLayout: unused,
      paneCommand: unused,
      setSessionOwner: unused,
      sessionOwner: (session) => {
        ops.push(`sessionOwner:${session}`);
        return Promise.resolve(options.owner === undefined ? OWNER : options.owner);
      },
      capturePane: unused,
      setBufferArg: unused,
      loadBufferFile: unused,
      pasteBuffer: unused,
      sendEnter: unused,
      newWindow: unused,
      attach: () => Promise.reject(new Error('unexpected tmux operation')),
    },
  };
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('runTeamStop', () => {
  it('requires ownership proof before probing for tmux', async () => {
    const cwd = workspace();
    const { io } = captureIo({ cwd });
    const fake = fakeAdapter({ present: false });

    await expect(
      runTeamStop(io, SESSION, { json: false }, { adapter: fake.adapter }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: `no crew-owned session named "${SESSION}"`,
    });
    expect(fake.ops).toEqual([]);
  });

  it('requires tmux after validating the ownership proof', async () => {
    const cwd = workspace();
    writePaneMap(cwd, SESSION, paneMap([]));
    const { io } = captureIo({ cwd });
    const fake = fakeAdapter({ present: false });

    await expect(
      runTeamStop(io, SESSION, { json: false }, { adapter: fake.adapter }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_MISSING' });
    expect(fake.ops).toEqual(['isPresent']);
  });

  it('kills a live owned session and archives only active mapped Agents', async () => {
    const cwd = workspace();
    joinAgent(cwd, 'manager');
    joinAgent(cwd, 'worker');
    archiveAgent(cwd, 'worker');
    writePaneMap(cwd, SESSION, paneMap(['manager', 'worker', 'missing']));
    const { io, out } = captureIo({ cwd, clock: () => 40 });
    const fake = fakeAdapter({ exists: true });

    const result = await runTeamStop(io, SESSION, { json: false }, { adapter: fake.adapter });

    expect(result).toEqual({ sessionName: SESSION, killed: true, agentsArchived: 1 });
    expect(fake.ops).toEqual([
      'isPresent',
      `hasSession:${SESSION}`,
      `sessionOwner:${SESSION}`,
      `killSession:${SESSION}`,
    ]);
    expect(agentStatuses(cwd)).toEqual(
      new Map([
        ['manager', 'archived'],
        ['worker', 'archived'],
      ]),
    );
    expect(out).toEqual([`Stopped ${SESSION}; archived 1 Agents.\n`]);
    expect(existsSync(join(cwd, '.crew', 'generated', SESSION, 'pane-map.json'))).toBe(false);
  });

  it('refuses a same-name session whose live ownership marker does not match', async () => {
    const cwd = workspace();
    joinAgent(cwd, 'worker');
    writePaneMap(cwd, SESSION, {
      ...paneMap(['worker']),
      relay_window: { present: false, name: 'crew-relay', pane_id: null },
    });
    const { io } = captureIo({ cwd });
    const fake = fakeAdapter({ exists: true, owner: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });

    await expect(
      runTeamStop(io, SESSION, { json: false }, { adapter: fake.adapter }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fake.ops).toEqual(['isPresent', `hasSession:${SESSION}`, `sessionOwner:${SESSION}`]);
    expect(agentStatuses(cwd).get('worker')).toBe('active');
  });

  it('continues when the owned session is already gone and emits one JSON record', async () => {
    const cwd = workspace();
    joinAgent(cwd, 'worker');
    writePaneMap(cwd, SESSION, paneMap(['worker']));
    const { io, out } = captureIo({ cwd, clock: () => 40 });
    const fake = fakeAdapter({ exists: false });

    const result = await runTeamStop(io, SESSION, { json: true }, { adapter: fake.adapter });

    expect(result).toEqual({ sessionName: SESSION, killed: false, agentsArchived: 1 });
    expect(fake.ops).toEqual(['isPresent', `hasSession:${SESSION}`]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual({
      type: 'stop_result',
      schema_version: 1,
      session_name: SESSION,
      killed: false,
      agents_archived: 1,
    });
    expect(existsSync(join(cwd, '.crew', 'generated', SESSION, 'pane-map.json'))).toBe(false);
  });

  it('uses the real adapter seam when no dependency override is supplied', async () => {
    const cwd = workspace();
    writePaneMap(cwd, SESSION, paneMap([]));
    const process = recordingRunProcess([
      { status: 0, stdout: 'tmux 3.5a\n', stderr: '' },
      { status: 1, stdout: '', stderr: '' },
    ]);
    const { io } = captureIo({ cwd, runProcess: process.runProcess });

    await expect(runTeamStop(io, SESSION, { json: false })).resolves.toMatchObject({
      killed: false,
      agentsArchived: 0,
    });
    expect(process.calls.map((call) => call.args)).toEqual([
      ['-V'],
      ['has-session', '-t', `=${SESSION}`],
    ]);
  });

  it('rejects malformed pane-map JSON without probing tmux', async () => {
    const cwd = workspace();
    writePaneMap(cwd, SESSION, paneMap([]));
    writeFileSync(join(cwd, '.crew', 'generated', SESSION, 'pane-map.json'), '{');
    const { io } = captureIo({ cwd });
    const fake = fakeAdapter();

    await expect(
      runTeamStop(io, SESSION, { json: false }, { adapter: fake.adapter }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(fake.ops).toEqual([]);
  });

  it('rejects a non-file pane-map as INVALID_CONFIG, not NOT_FOUND, without probing tmux', async () => {
    const cwd = workspace();
    // A directory at the pane-map path: it exists but is not a readable file, so
    // this is a corrupt-workspace INVALID_CONFIG — distinct from the missing-file
    // NOT_FOUND case, and never a misleading "not valid JSON".
    mkdirSync(join(cwd, '.crew', 'generated', SESSION, 'pane-map.json'), { recursive: true });
    const { io } = captureIo({ cwd });
    const fake = fakeAdapter();

    await expect(
      runTeamStop(io, SESSION, { json: false }, { adapter: fake.adapter }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(fake.ops).toEqual([]);
  });

  it.each([
    ['a null document', null],
    ['the wrong schema', { schema_version: 2, session_name: SESSION, panes: [] }],
    ['the wrong session', { schema_version: 1, session_name: 'other', panes: [] }],
    ['a missing panes array', { schema_version: 1, session_name: SESSION }],
    ['a missing ownership marker', { ...paneMap([]), ownership_token: undefined }],
    ['an invalid ownership marker', { ...paneMap([]), ownership_token: 'not-a-uuid' }],
    ['a null pane', { ...paneMap([]), panes: [null] }],
    ['a pane without an Agent id', { ...paneMap([]), panes: [{ pane_id: '%1', window: 'crew' }] }],
    [
      'a pane with an invalid Agent id',
      {
        ...paneMap([]),
        panes: [{ agent_id: 'bad id', pane_id: '%1', window: 'crew' }],
      },
    ],
    [
      'a pane with a non-pane tmux target',
      { ...paneMap(['worker']), panes: [{ ...paneMap(['worker']).panes[0], pane_id: 'other:0' }] },
    ],
    [
      'a present Relay without its realized pane id',
      { ...paneMap([]), relay_window: { present: true, name: 'crew-relay', pane_id: null } },
    ],
    [
      'duplicate realized pane ids',
      {
        ...paneMap(['worker']),
        relay_window: { present: true, name: 'crew-relay', pane_id: '%1' },
      },
    ],
  ])('rejects %s without probing tmux', async (_label, body) => {
    const cwd = workspace();
    writePaneMap(cwd, SESSION, paneMap([]));
    writeFileSync(join(cwd, '.crew', 'generated', SESSION, 'pane-map.json'), JSON.stringify(body));
    const { io } = captureIo({ cwd });
    const fake = fakeAdapter();

    await expect(
      runTeamStop(io, SESSION, { json: false }, { adapter: fake.adapter }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(fake.ops).toEqual([]);
  });
});

describe('team stop command wiring', () => {
  it('dispatches team stop <session> and forwards --json', async () => {
    const cwd = workspace();
    writePaneMap(cwd, SESSION, paneMap([]));
    const process = recordingRunProcess([
      { status: 0, stdout: 'tmux 3.5a\n', stderr: '' },
      { status: 1, stdout: '', stderr: '' },
    ]);
    const { io, out, err } = captureIo({ cwd, runProcess: process.runProcess });

    expect(await run(['team', 'stop', SESSION, '--json'], io)).toBe(0);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual({
      type: 'stop_result',
      schema_version: 1,
      session_name: SESSION,
      killed: false,
      agents_archived: 0,
    });
  });

  it('fails with a generic ERROR when the availability probe is killed, never "tmux missing"', async () => {
    const cwd = workspace();
    writePaneMap(cwd, SESSION, paneMap([]));
    const { io, err } = captureIo({
      cwd,
      runProcess: () =>
        Promise.resolve({ status: null, stdout: '', stderr: '', killed: true, signal: 'SIGTERM' }),
    });

    expect(await run(['team', 'stop', SESSION], io)).toBe(1);
    const text = err.join('');
    expect(text).toContain('[ERROR] the tmux availability probe (tmux -V) did not exit cleanly');
    expect(text).not.toContain('tmux is required to stop');
    expect(text).not.toContain('[DEPENDENCY_MISSING]');
    expect(text).not.toContain('[LAUNCH_FAILED]');
  });

  it('fails with a generic ERROR when a control command is killed mid-stop, never LAUNCH_FAILED', async () => {
    const cwd = workspace();
    writePaneMap(cwd, SESSION, paneMap([]));
    const process = recordingRunProcess([
      { status: 0, stdout: 'tmux 3.5a\n', stderr: '' }, // tmux -V probe succeeds
      { status: null, stdout: '', stderr: '', killed: true, signal: 'SIGTERM' }, // has-session killed
    ]);
    const { io, err } = captureIo({ cwd, runProcess: process.runProcess });

    expect(await run(['team', 'stop', SESSION], io)).toBe(1);
    const text = err.join('');
    expect(text).toContain('[ERROR] tmux has-session did not exit cleanly (signal SIGTERM)');
    // A stop is not a launch: the surfaced class must never point at one.
    expect(text).not.toContain('[LAUNCH_FAILED]');
    expect(text).not.toMatch(/launch/i);
  });

  it('rejects team stop without a session, including through help validation', async () => {
    const missing = captureIo({ cwd: workspace() });
    expect(await run(['team', 'stop'], missing.io)).toBe(2);
    expect(missing.err.join('')).toContain('[USAGE] team stop requires a session name');

    const help = captureIo({ cwd: workspace() });
    expect(await run(['team', 'stop', '--help'], help.io)).toBe(2);
    expect(help.out).toEqual([]);
  });

  it('rejects team resume without a session, including through help validation', async () => {
    const missing = captureIo({ cwd: workspace() });
    expect(await run(['team', 'resume'], missing.io)).toBe(2);
    expect(missing.err.join('')).toContain('[USAGE] team resume requires a session name');

    const help = captureIo({ cwd: workspace() });
    expect(await run(['team', 'resume', '--help'], help.io)).toBe(2);
    expect(help.out).toEqual([]);
  });

  it('rejects a second positional for ordinary Team names', async () => {
    const normal = captureIo({ cwd: workspace() });
    expect(await run(['team', 'dev', 'unexpected'], normal.io)).toBe(2);
    expect(normal.err.join('')).toContain('[USAGE] team "dev" does not accept a session argument');

    const help = captureIo({ cwd: workspace() });
    expect(await run(['team', 'dev', 'unexpected', '--help'], help.io)).toBe(2);
    expect(help.out).toEqual([]);
  });

  it('preserves ordinary team display behavior', async () => {
    const { io, out, err } = captureIo({ cwd: workspace() });
    expect(await run(['team', 'dev', '--json'], io)).toBe(0);
    expect(err).toEqual([]);
    expect(JSON.parse(out[0]!)).toMatchObject({
      type: 'team_member',
      team: 'dev',
      agent_id: 'manager',
    });
  });
});
