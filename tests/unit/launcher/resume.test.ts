import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** One realized launch, as observed through the fake adapter's semantic calls. */
interface RelaunchRecording {
  readonly adapter: TmuxAdapter;
  /** Every semantic tmux operation, in call order (`attach` included). */
  readonly ops: string[];
  /** Every invocation string pasted into a pane via the argv buffer. */
  readonly invocations: string[];
  /** Every window command started with `new-window` (the Relay). */
  readonly windowCommands: (readonly string[])[];
  /** Stdout lines already written when `attach` was called. */
  readonly outAtAttach: string[];
}

/**
 * A fake TmuxAdapter that actually completes a launch: pasting a pane's
 * invocation simulates that Participant running `crew join` against the REAL
 * Store, so `runLiveLaunch`'s stage-2 roster gate passes on genuine
 * registrations. Modeled on the fake in
 * `tests/integration/commands/team-launch-live.test.ts`, but resume-aware — the
 * pasted invocation carries `--resume`, and the simulated join therefore
 * reactivates the archived exact id instead of allocating a suffix, exactly as
 * `crew join --resume` does in a real pane.
 */
function relaunchingAdapter(cwd: string, out: readonly string[]): RelaunchRecording {
  const ops: string[] = [];
  const invocations: string[] = [];
  const windowCommands: (readonly string[])[] = [];
  const outAtAttach: string[] = [];
  let paneCounter = 0;
  let sessionOwner: string | null = null;
  let pending: { id: string; role: string; resume: boolean } | null = null;

  const join = (entry: { id: string; role: string; resume: boolean }): void => {
    const store = openWorkspaceStore(cwd, () => 20);
    try {
      store.joinAgent({
        id: entry.id,
        role: entry.role,
        platformId: 'codex-cli',
        ...(entry.resume ? { resume: true as const } : {}),
      });
    } finally {
      store.close();
    }
  };

  const adapter: TmuxAdapter = {
    isPresent: () => Promise.resolve(true),
    hasSession: () => Promise.resolve(false),
    sessionOwner: () => Promise.resolve(sessionOwner),
    newSession: () => {
      ops.push('newSession');
      return Promise.resolve(`%${paneCounter++}`);
    },
    splitPane: () => {
      ops.push('splitPane');
      return Promise.resolve(`%${paneCounter++}`);
    },
    tileLayout: () => {
      ops.push('tileLayout');
      return Promise.resolve();
    },
    paneCommand: () => Promise.resolve('codex'),
    setSessionOwner: (_session, token) => {
      ops.push('setSessionOwner');
      sessionOwner = token;
      return Promise.resolve();
    },
    capturePane: () => Promise.resolve(''),
    setBufferArg: (_buffer, content) => {
      ops.push('setBufferArg');
      invocations.push(content);
      // `$crew <role> <id>` with an optional trailing `--resume`; drop flags
      // before reading the positional pair.
      const tokens = content.trim().split(/\s+/);
      const positional = tokens.filter((token) => !token.startsWith('-'));
      if (positional.length >= 3 && positional[0]?.includes('crew')) {
        pending = {
          role: positional[positional.length - 2]!,
          id: positional[positional.length - 1]!,
          resume: tokens.includes('--resume'),
        };
      }
      return Promise.resolve();
    },
    loadBufferFile: () => {
      ops.push('loadBufferFile');
      return Promise.resolve();
    },
    pasteBuffer: () => {
      ops.push('pasteBuffer');
      return Promise.resolve();
    },
    sendEnter: () => {
      ops.push('sendEnter');
      if (pending !== null) {
        join(pending);
        pending = null;
      }
      return Promise.resolve();
    },
    newWindow: (o) => {
      ops.push('newWindow');
      windowCommands.push(o.command);
      return Promise.resolve(`%${paneCounter++}`);
    },
    killSession: () => {
      ops.push('killSession');
      return Promise.resolve();
    },
    attach: () => {
      ops.push('attach');
      outAtAttach.push(...out);
      return Promise.resolve(0);
    },
  };
  return { adapter, ops, invocations, windowCommands, outAtAttach };
}

/** Every Agent row (active and archived) in the workspace Store, by id. */
function agentStatuses(cwd: string): Map<string, string> {
  const store = openWorkspaceStore(cwd, () => 20);
  try {
    return new Map(store.listAgents({ includeArchived: true }).map((a) => [a.id, a.status]));
  } finally {
    store.close();
  }
}

/** The planned roster of `team` under the workspace's tracked config. */
function plannedRoster(cwd: string): { agent_id: string; role: string }[] {
  const { io } = captureIo({ cwd, env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') } });
  const config = mergeEffectiveConfig(loadLauncherConfig(cwd), {});
  return buildLaunchPlan(io, 'dev', config).plan.roster.map((entry) => ({
    agent_id: entry.agent_id,
    role: entry.role,
  }));
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

/**
 * The success path. Every case above is a refusal, so nothing proved that a
 * valid `crew team resume` reaches `runLiveLaunch` at all — the recovery verb
 * runs when something has already gone wrong, and is the path least likely to
 * be exercised by hand before a release.
 *
 * The fake adapter completes a real relaunch against the REAL Store, so these
 * assertions pin the behaviors that only the resume entrypoint can produce:
 * `resume: true` reaching the pane invocations, the preflight's planned-id
 * check being skipped so archived ids are reactivated instead of suffixed
 * (`src/launcher/session.ts` — the entire reason resume can reuse ids), the
 * retired clean-stop marker, and the `resume_result` record emitted BEFORE the
 * blocking attach.
 */
describe('runTeamResume — a valid resume relaunches the Crew', () => {
  /** Archive the planned roster, store the plan + clean-stop marker, resume it. */
  async function resumeCleanStop(json: boolean): Promise<{
    cwd: string;
    out: string[];
    recording: RelaunchRecording;
  }> {
    const cwd = workspace();
    archivePlannedAgents(cwd, 'dev');
    writeResumableSession(cwd, 'dev');
    const { io, out } = captureIo({
      cwd,
      env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') },
      clock: () => 20,
    });
    const recording = relaunchingAdapter(cwd, out);

    await runTeamResume(
      io,
      'crew-demo',
      { json },
      { adapter: recording.adapter, delay: () => Promise.resolve(), relayBin: ['node', 'crew'] },
    );
    return { cwd, out, recording };
  }

  it('builds the tmux session and starts the Relay window', async () => {
    const { recording } = await resumeCleanStop(true);

    // The session was genuinely created — not merely validated and abandoned.
    expect(recording.ops).toContain('newSession');
    expect(recording.ops).toContain('setSessionOwner');
    expect(recording.ops).toContain('newWindow');
    expect(recording.ops).not.toContain('killSession');
    expect(recording.windowCommands).toEqual([
      ['node', 'crew', 'relay', '--internal', '--session', 'crew-demo'],
    ]);
  });

  it('carries --resume into every pane invocation', async () => {
    const { cwd, recording } = await resumeCleanStop(true);
    const roster = plannedRoster(cwd);

    expect(recording.invocations).toEqual(
      roster.map((entry) => `$crew ${entry.role} ${entry.agent_id} --resume`),
    );
  });

  it('reactivates the archived exact ids instead of allocating suffixed ones', async () => {
    const { cwd } = await resumeCleanStop(true);
    const roster = plannedRoster(cwd);
    const agents = agentStatuses(cwd);

    // No `-2` twin anywhere: the planned ids are the ONLY rows, and each is
    // active again. A launch that did not set `resume` would have been refused
    // by the preflight's planned-id check instead.
    expect([...agents.keys()].sort()).toEqual(roster.map((entry) => entry.agent_id).sort());
    expect([...agents.values()]).toEqual(roster.map(() => 'active'));
  });

  it('retires the clean-stop marker so the session is not resumable twice', async () => {
    const { cwd } = await resumeCleanStop(true);

    expect(existsSync(join(cwd, '.crew', 'generated', 'crew-demo', 'resume.json'))).toBe(false);
    // The launch plan itself stays — only the clean-stop marker is retired.
    expect(existsSync(join(cwd, '.crew', 'generated', 'crew-demo', 'launch-plan.json'))).toBe(true);
  });

  it('emits exactly one resume_result record, before the blocking attach', async () => {
    const { cwd, out, recording } = await resumeCleanStop(true);

    const records = out
      .join('')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { type: string });
    expect(records).toEqual([
      {
        type: 'resume_result',
        schema_version: 1,
        session_name: 'crew-demo',
        // One pane per planned Agent — derived, like the sibling cases, so a
        // roster change does not silently redefine what this asserts.
        panes: plannedRoster(cwd).length,
        relay: true,
        attached: true,
      },
    ]);
    // `runLiveLaunch` attaches last; the record must already have been written
    // when it did, or a resumed-and-attached operator never sees it.
    expect(recording.ops).toContain('attach');
    expect(recording.outAtAttach.join('')).toContain('"type":"resume_result"');
  });

  it('renders the human summary when --json is not requested', async () => {
    const { out } = await resumeCleanStop(false);

    // Only that the human renderer is REACHED on this path. The exact wording is
    // pinned once, against `renderTeamResumeResult` itself, in
    // tests/unit/format.test.ts — asserting it byte-for-byte here would break two
    // tests on one copy edit.
    expect(out.join('')).toContain('Resumed session crew-demo');
  });
});
