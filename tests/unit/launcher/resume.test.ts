import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../../src/init.js';
import {
  type PaneMap,
  writePaneMap,
  writePlanArtifacts,
  writeResumeMarker,
} from '../../../src/launcher/artifacts.js';
import { loadLauncherConfig, mergeEffectiveConfig } from '../../../src/launcher/config.js';
import { buildLaunchPlan } from '../../../src/launcher/plan.js';
import { listResumableSessions, runTeamResume } from '../../../src/launcher/resume.js';
import type { TmuxAdapter } from '../../../src/launcher/tmux.js';
import type { ParticipantId } from '../../../src/participants.js';
import { openWorkspaceStore } from '../../../src/store/index.js';
import { captureIo } from '../../helpers/io.js';

const made: string[] = [];
const OWNER = '123e4567-e89b-42d3-a456-426614174000';
const LAUNCHER_YAML = `version: 1
project:
  name: crew-demo
  session_name: crew-demo
runtime:
  client: codex-cli
relay:
  enabled: true
  poll_seconds: 2
  reminder_seconds: 30
focus:
  files:
    - src
constraints:
  - keep tests green
`;

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-resume-'));
  made.push(dir);
  initWorkspace(captureIo({ cwd: dir }).io, { withGuides: false, json: false });
  writeFileSync(join(dir, '.crew', 'launcher.yaml'), LAUNCHER_YAML);
  mkdirSync(join(dir, 'fakebin'));
  writeFileSync(join(dir, 'fakebin', 'codex'), '#!/bin/sh\n');
  chmodSync(join(dir, 'fakebin', 'codex'), 0o755);
  return dir;
}

function archivePlannedAgents(cwd: string, team: string): void {
  const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });
  const config = mergeEffectiveConfig(loadLauncherConfig(cwd), {});
  const plan = buildLaunchPlan(io, team, config).plan;
  const store = openWorkspaceStore(cwd, () => 10);
  try {
    for (const entry of plan.roster) {
      store.joinAgent({ id: entry.agent_id, role: entry.role, platformId: plan.client });
      store.leaveAgent(entry.agent_id);
    }
  } finally {
    store.close();
  }
}

/** Join every planned Agent with a per-entry override (role/platform/archive). */
function joinPlannedAgentsWith(
  cwd: string,
  team: string,
  overrides: {
    readonly role?: (planned: string) => string;
    readonly platformId?: ParticipantId;
    readonly archive?: boolean;
  },
): void {
  const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });
  const config = mergeEffectiveConfig(loadLauncherConfig(cwd), {});
  const plan = buildLaunchPlan(io, team, config).plan;
  const store = openWorkspaceStore(cwd, () => 10);
  try {
    for (const entry of plan.roster) {
      store.joinAgent({
        id: entry.agent_id,
        role: overrides.role !== undefined ? overrides.role(entry.role) : entry.role,
        platformId: overrides.platformId ?? plan.client,
      });
      if (overrides.archive !== false) store.leaveAgent(entry.agent_id);
    }
  } finally {
    store.close();
  }
}

function writeResumableSession(cwd: string, team: string): void {
  const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });
  const config = mergeEffectiveConfig(loadLauncherConfig(cwd), {});
  const plan = buildLaunchPlan(io, team, config).plan;
  writePlanArtifacts(cwd, plan.session_name, {
    launchPlan: plan,
    managerPrompt: '# manager\n',
    inspectorPrompt: '# inspector\n',
    runSummary: '# summary\n',
  });
  writeResumeMarker(cwd, plan.session_name, {
    schema_version: 1,
    session_name: plan.session_name,
    stopped_at: 100,
    agents_archived: plan.roster.length,
    cleanly_stopped: true,
  });
}

function writeLiveOwnedSession(cwd: string, session: string): void {
  const paneMap: PaneMap = {
    schema_version: 1,
    session_name: session,
    ownership_token: OWNER,
    relay_window: { present: true, name: 'crew-relay', pane_id: '%99' },
    panes: [
      {
        pane_id: '%1',
        window: 'crew',
        agent_id: 'manager',
        role: 'manager',
        executable: 'codex',
        invocation: '$crew manager manager',
        readiness_names: ['codex'],
      },
    ],
  };
  writePaneMap(cwd, session, paneMap);
}

function fakeAdapter(options: {
  present?: boolean;
  live?: ReadonlySet<string>;
  owner?: (session: string) => string | null;
}): TmuxAdapter {
  const unused = () => Promise.reject(new Error('unexpected tmux operation'));
  return {
    isPresent: () => Promise.resolve(options.present ?? true),
    hasSession: (session) => Promise.resolve(options.live?.has(session) ?? false),
    sessionOwner: (session) => Promise.resolve(options.owner?.(session) ?? OWNER),
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
  };
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('listResumableSessions', () => {
  it('omits a clean-stop session after relay config drift, even when the roster still matches', async () => {
    const cwd = workspace();
    archivePlannedAgents(cwd, 'dev');
    writeResumableSession(cwd, 'dev');
    writeFileSync(
      join(cwd, '.crew', 'launcher.yaml'),
      LAUNCHER_YAML.replace('reminder_seconds: 30', 'reminder_seconds: 45'),
    );
    const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });

    await expect(
      listResumableSessions(io, { adapter: fakeAdapter({ present: false }) }),
    ).resolves.toEqual([]);
  });

  it('reports no resumable sessions while any crew-owned session is still live', async () => {
    const cwd = workspace();
    archivePlannedAgents(cwd, 'dev');
    writeResumableSession(cwd, 'dev');
    writeLiveOwnedSession(cwd, 'crew-live');
    const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });

    await expect(
      listResumableSessions(io, {
        adapter: fakeAdapter({ live: new Set(['crew-live']) }),
      }),
    ).resolves.toEqual([]);
  });

  it('lists a clean-stop session whose plan and archived roster still match (tmux absent)', async () => {
    const cwd = workspace();
    archivePlannedAgents(cwd, 'dev');
    writeResumableSession(cwd, 'dev');
    const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });

    const sessions = await listResumableSessions(io, { adapter: fakeAdapter({ present: false }) });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ sessionName: 'crew-demo', team: 'dev', stoppedAt: 100 });
    expect(sessions[0]!.agentsArchived).toBeGreaterThan(0);
  });

  it('lists the session when tmux is present but the session is not live', async () => {
    const cwd = workspace();
    archivePlannedAgents(cwd, 'dev');
    writeResumableSession(cwd, 'dev');
    const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });

    const sessions = await listResumableSessions(io, { adapter: fakeAdapter({ present: true }) });
    expect(sessions.map((s) => s.sessionName)).toEqual(['crew-demo']);
  });

  it('omits a session that is already live under its own name', async () => {
    const cwd = workspace();
    archivePlannedAgents(cwd, 'dev');
    writeResumableSession(cwd, 'dev');
    const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });

    await expect(
      listResumableSessions(io, {
        adapter: fakeAdapter({ present: true, live: new Set(['crew-demo']) }),
      }),
    ).resolves.toEqual([]);
  });

  it('omits a session when a planned Agent was never joined', async () => {
    const cwd = workspace();
    writeResumableSession(cwd, 'dev');
    const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });

    await expect(
      listResumableSessions(io, { adapter: fakeAdapter({ present: false }) }),
    ).resolves.toEqual([]);
  });

  it('omits a session when a planned Agent is still active, not archived', async () => {
    const cwd = workspace();
    joinPlannedAgentsWith(cwd, 'dev', { archive: false });
    writeResumableSession(cwd, 'dev');
    const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });

    await expect(
      listResumableSessions(io, { adapter: fakeAdapter({ present: false }) }),
    ).resolves.toEqual([]);
  });

  it('omits a session when an archived Agent carries a different Role', async () => {
    const cwd = workspace();
    joinPlannedAgentsWith(cwd, 'dev', {
      role: (planned) => (planned === 'manager' ? 'worker' : 'manager'),
    });
    writeResumableSession(cwd, 'dev');
    const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });

    await expect(
      listResumableSessions(io, { adapter: fakeAdapter({ present: false }) }),
    ).resolves.toEqual([]);
  });

  it('omits a session when an archived Agent joined under a different platform', async () => {
    const cwd = workspace();
    joinPlannedAgentsWith(cwd, 'dev', { platformId: 'claude-code' });
    writeResumableSession(cwd, 'dev');
    const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });

    await expect(
      listResumableSessions(io, { adapter: fakeAdapter({ present: false }) }),
    ).resolves.toEqual([]);
  });
});

describe('runTeamResume', () => {
  const deps = (adapter: TmuxAdapter) => ({
    adapter,
    delay: () => Promise.resolve(),
    relayBin: ['node', 'crew'] as const,
  });

  it('requires tmux to be present', async () => {
    const cwd = workspace();
    const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });

    await expect(
      runTeamResume(io, 'crew-demo', { json: false }, deps(fakeAdapter({ present: false }))),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_MISSING' });
  });

  it('maps a missing clean-stop marker to NOT_FOUND without leaking a filesystem path', async () => {
    const cwd = workspace();
    const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });

    await expect(
      runTeamResume(io, 'nope', { json: false }, deps(fakeAdapter({ present: true }))),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'no cleanly stopped crew-owned session named "nope"',
    });
  });

  it('maps a missing stored plan after a clean stop marker to NOT_FOUND', async () => {
    const cwd = workspace();
    writeResumeMarker(cwd, 'nope', {
      schema_version: 1,
      session_name: 'nope',
      stopped_at: 100,
      agents_archived: 0,
      cleanly_stopped: true,
    });
    const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });

    await expect(
      runTeamResume(io, 'nope', { json: false }, deps(fakeAdapter({ present: true }))),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a launch plan whose session name does not match the requested session', async () => {
    const cwd = workspace();
    const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });
    const config = mergeEffectiveConfig(loadLauncherConfig(cwd), {});
    const plan = buildLaunchPlan(io, 'dev', config).plan;
    // Store the crew-demo plan under a DIFFERENT generated-session directory.
    writePlanArtifacts(cwd, 'crew-other', {
      launchPlan: plan,
      managerPrompt: '# manager\n',
      inspectorPrompt: '# inspector\n',
      runSummary: '# summary\n',
    });
    writeResumeMarker(cwd, 'crew-other', {
      schema_version: 1,
      session_name: 'crew-other',
      stopped_at: 100,
      agents_archived: plan.roster.length,
      cleanly_stopped: true,
    });

    await expect(
      runTeamResume(io, 'crew-other', { json: false }, deps(fakeAdapter({ present: true }))),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('refuses to resume while a tmux session of the same name exists', async () => {
    const cwd = workspace();
    archivePlannedAgents(cwd, 'dev');
    writeResumableSession(cwd, 'dev');
    const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });

    await expect(
      runTeamResume(
        io,
        'crew-demo',
        { json: false },
        deps(fakeAdapter({ present: true, live: new Set(['crew-demo']) })),
      ),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('reports TEAM_DRIFT when the current config no longer matches the stored plan', async () => {
    const cwd = workspace();
    archivePlannedAgents(cwd, 'dev');
    writeResumableSession(cwd, 'dev');
    writeFileSync(
      join(cwd, '.crew', 'launcher.yaml'),
      LAUNCHER_YAML.replace('reminder_seconds: 30', 'reminder_seconds: 45'),
    );
    const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });

    await expect(
      runTeamResume(io, 'crew-demo', { json: false }, deps(fakeAdapter({ present: true }))),
    ).rejects.toMatchObject({ code: 'TEAM_DRIFT' });
  });

  it('reports TEAM_DRIFT when a planned Agent is not the archived exact match', async () => {
    const cwd = workspace();
    joinPlannedAgentsWith(cwd, 'dev', { archive: false });
    writeResumableSession(cwd, 'dev');
    const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });

    await expect(
      runTeamResume(io, 'crew-demo', { json: false }, deps(fakeAdapter({ present: true }))),
    ).rejects.toMatchObject({
      code: 'TEAM_DRIFT',
      message: expect.stringContaining('archived exact match') as string,
    });
  });
});
