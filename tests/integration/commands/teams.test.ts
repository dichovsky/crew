import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../../src/init.js';
import {
  expandRoster,
  listTeams,
  loadTeam,
  parseTeam,
  runTeamShow,
  runTeamsList,
} from '../../../src/teams.js';
import { run } from '../../../src/run.js';
import { CrewError } from '../../../src/errors.js';
import { captureIo } from '../../helpers/io.js';

const made: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-teams-'));
  made.push(dir);
  const { io } = captureIo({ cwd: dir });
  initWorkspace(io, { withGuides: false, json: false });
  return dir;
}

function teamPath(cwd: string, name: string): string {
  return join(cwd, '.crew', 'teams', `${name}.yaml`);
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`should have thrown ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(CrewError);
    expect((err as CrewError).code).toBe(code);
  }
}

afterEach(() => {
  while (made.length) {
    rmSync(made.pop()!, { recursive: true, force: true });
  }
});

const DEV = `version: 1
name: dev
members:
  - id: manager
    role: manager
  - id: worker
    role: worker
    replicas: 2
  - id: inspector
    role: inspector
`;

describe('parseTeam', () => {
  it('accepts the dev team', () => {
    const team = parseTeam(DEV, 'dev', 'team "dev"');
    expect(team.name).toBe('dev');
    expect(team.members).toHaveLength(3);
    expect(team.members[1]).toMatchObject({ id: 'worker', role: 'worker', replicas: 2 });
  });

  it('rejects the reserved team name stop with USAGE', () => {
    const stop = 'version: 1\nname: stop\nmembers:\n  - id: worker\n    role: worker\n';
    expectCode(() => parseTeam(stop, 'stop', 'team "stop"'), 'USAGE');
  });

  it('rejects the reserved team name resume with USAGE', () => {
    const resume = 'version: 1\nname: resume\nmembers:\n  - id: worker\n    role: worker\n';
    expectCode(() => parseTeam(resume, 'resume', 'team "resume"'), 'USAGE');
  });

  it('rejects version other than 1', () => {
    expectCode(
      () => parseTeam('version: 2\nname: dev\nmembers:\n  - id: a\n    role: worker\n', 'dev', 'd'),
      'INVALID_CONFIG',
    );
  });

  it('rejects unknown top-level keys', () => {
    expectCode(() => parseTeam(`${DEV}extra: nope\n`, 'dev', 'd'), 'INVALID_CONFIG');
  });

  it('rejects a name that does not match the filename stem', () => {
    expectCode(() => parseTeam(DEV, 'other', 'd'), 'INVALID_CONFIG');
  });

  it('rejects unknown member keys', () => {
    expectCode(
      () =>
        parseTeam(
          'version: 1\nname: t\nmembers:\n  - id: a\n    role: worker\n    bogus: 1\n',
          't',
          'd',
        ),
      'INVALID_CONFIG',
    );
  });

  it('rejects out-of-range replicas', () => {
    expectCode(
      () =>
        parseTeam(
          'version: 1\nname: t\nmembers:\n  - id: a\n    role: worker\n    replicas: 99\n',
          't',
          'd',
        ),
      'INVALID_CONFIG',
    );
  });

  it('rejects an unknown platform hint', () => {
    expectCode(
      () =>
        parseTeam(
          'version: 1\nname: t\nmembers:\n  - id: a\n    role: worker\n    platform: emacs\n',
          't',
          'd',
        ),
      'INVALID_CONFIG',
    );
  });

  it('accepts Little Coder as a platform hint', () => {
    const team = parseTeam(
      'version: 1\nname: local\nmembers:\n  - id: worker\n    role: worker\n    platform: little-coder\n',
      'local',
      'team "local"',
    );
    expect(team.members[0]?.platform).toBe('little-coder');
  });

  it('rejects a member id of @all (reserved, fails the grammar)', () => {
    expectCode(
      () =>
        parseTeam('version: 1\nname: t\nmembers:\n  - id: "@all"\n    role: worker\n', 't', 'd'),
      'INVALID_CONFIG',
    );
  });
});

describe('expandRoster', () => {
  it('expands replicas deterministically', () => {
    const roster = expandRoster(parseTeam(DEV, 'dev', 'd'), 'd');
    expect(roster.map((r) => r.agentId)).toEqual(['manager', 'worker', 'worker-2', 'inspector']);
  });

  it('detects collisions across templates', () => {
    const src =
      'version: 1\nname: t\nmembers:\n  - id: worker\n    role: worker\n    replicas: 2\n  - id: worker-2\n    role: worker\n';
    expectCode(() => expandRoster(parseTeam(src, 't', 'd'), 'd'), 'INVALID_CONFIG');
  });

  it('rejects expansion beyond 64 agents', () => {
    const src = `version: 1\nname: t\nmembers:\n  - id: a\n    role: worker\n    replicas: 32\n  - id: b\n    role: worker\n    replicas: 32\n  - id: c\n    role: worker\n    replicas: 1\n`;
    expectCode(() => expandRoster(parseTeam(src, 't', 'd'), 'd'), 'INVALID_CONFIG');
  });

  it('rejects an expanded id that overflows the agent-id grammar', () => {
    // a 64-char base is a valid id, but the `-2` suffix makes a 66-char id
    const base = 'a'.repeat(64);
    const src = `version: 1\nname: t\nmembers:\n  - id: ${base}\n    role: worker\n    replicas: 2\n`;
    expectCode(() => expandRoster(parseTeam(src, 't', 'd'), 'd'), 'INVALID_CONFIG');
  });
});

describe('loadTeam / listTeams', () => {
  it('loads the seeded dev team', () => {
    const { io } = captureIo({ cwd: workspace() });
    expect(loadTeam(io, 'dev').name).toBe('dev');
  });

  it('lists the dev team', () => {
    const { io } = captureIo({ cwd: workspace() });
    expect(listTeams(io).map((t) => t.name)).toContain('dev');
  });

  it('falls back to the packaged team list when the teams directory is missing', () => {
    const cwd = workspace();
    rmSync(join(cwd, '.crew', 'teams'), { recursive: true, force: true });
    const { io } = captureIo({ cwd });
    expect(listTeams(io)).toEqual([{ name: 'dev', builtin: true, source: 'packaged' }]);
  });

  it('reports NOT_FOUND for an unknown team', () => {
    const { io } = captureIo({ cwd: workspace() });
    expectCode(() => loadTeam(io, 'ghost'), 'NOT_FOUND');
  });

  it('rejects an invalid team name argument with USAGE', () => {
    const { io } = captureIo({ cwd: workspace() });
    expectCode(() => loadTeam(io, 'Bad Name'), 'USAGE');
  });

  it('rejects loading the reserved team name stop with USAGE', () => {
    const { io } = captureIo({ cwd: workspace() });
    expectCode(() => loadTeam(io, 'stop'), 'USAGE');
  });

  it('rejects loading the reserved team name resume with USAGE', () => {
    const { io } = captureIo({ cwd: workspace() });
    expectCode(() => loadTeam(io, 'resume'), 'USAGE');
  });

  it('requires a workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-teams-'));
    made.push(dir);
    const { io } = captureIo({ cwd: dir });
    expectCode(() => listTeams(io), 'NOT_WORKSPACE');
  });

  it('lets a project Team override the packaged one', () => {
    const cwd = workspace();
    writeFileSync(
      teamPath(cwd, 'dev'),
      'version: 1\nname: dev\nmembers:\n  - id: solo\n    role: manager\n',
    );
    const { io } = captureIo({ cwd });
    expect(loadTeam(io, 'dev').members.map((m) => m.id)).toEqual(['solo']);
  });

  it('rejects a Team whose member role does not resolve (FR-F08)', () => {
    const cwd = workspace();
    writeFileSync(
      teamPath(cwd, 'dev'),
      'version: 1\nname: dev\nmembers:\n  - id: a\n    role: ghostrole\n',
    );
    const { io } = captureIo({ cwd });
    expectCode(() => loadTeam(io, 'dev'), 'INVALID_CONFIG');
  });

  it('rejects reading a symlinked Team file (UNSAFE_PATH)', () => {
    const cwd = workspace();
    const outsideDir = mkdtempSync(join(tmpdir(), 'crew-out-'));
    made.push(outsideDir);
    const outside = join(outsideDir, 'evil.yaml');
    writeFileSync(outside, 'version: 1\nname: dev\nmembers:\n  - id: a\n    role: worker\n');
    rmSync(teamPath(cwd, 'dev'));
    symlinkSync(outside, teamPath(cwd, 'dev'));
    const { io } = captureIo({ cwd });
    expectCode(() => loadTeam(io, 'dev'), 'UNSAFE_PATH');
  });

  it('does not mask a symlinked project Team with its packaged variant', () => {
    const cwd = workspace();
    const target = join(cwd, 'shared-dev.yaml');
    writeFileSync(target, DEV);
    rmSync(teamPath(cwd, 'dev'));
    symlinkSync(target, teamPath(cwd, 'dev'));
    expectCode(() => listTeams(captureIo({ cwd }).io), 'UNSAFE_PATH');
  });

  it('skips invalid and reserved team-name stems when enumerating', () => {
    const cwd = workspace();
    writeFileSync(join(cwd, '.crew', 'teams', 'Bad Name.yaml'), 'x');
    writeFileSync(join(cwd, '.crew', 'teams', 'stop.yaml'), 'x');
    writeFileSync(join(cwd, '.crew', 'teams', 'resume.yaml'), 'x');
    mkdirSync(join(cwd, '.crew', 'teams', 'dir.yaml'));
    const { io } = captureIo({ cwd });
    const names = listTeams(io).map((t) => t.name);
    expect(names).not.toContain('Bad Name');
    expect(names).not.toContain('stop');
    expect(names).not.toContain('resume');
    expect(names).not.toContain('dir');
    expect(names).toContain('dev');
  });

  it('classifies the seeded dev team as packaged and an edited one as project', () => {
    const cwd = workspace();
    expect(listTeams(captureIo({ cwd }).io).find((t) => t.name === 'dev')?.source).toBe('packaged');
    writeFileSync(
      teamPath(cwd, 'dev'),
      'version: 1\nname: dev\nmembers:\n  - id: solo\n    role: manager\n',
    );
    expect(listTeams(captureIo({ cwd }).io).find((t) => t.name === 'dev')?.source).toBe('project');
  });

  it('rethrows the first per-file failure from the strict listing', () => {
    const cwd = workspace();
    // The tolerant lister collects the oversized file as a per-file failure;
    // the strict `listTeams` wrapper rethrows it, so `crew teams` still aborts.
    writeFileSync(teamPath(cwd, 'broken'), 'x'.repeat(300_000));
    const { io } = captureIo({ cwd });
    expectCode(() => listTeams(io), 'INVALID_CONFIG');
  });
});

describe('team display output', () => {
  it('emits one team_member record per expanded agent', () => {
    const { io, out } = captureIo({ cwd: workspace() });
    runTeamShow(io, 'dev', { json: true });
    const records = out
      .join('')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; agent_id: string; join_command: string });
    expect(records.map((r) => r.agent_id)).toEqual(['manager', 'worker', 'worker-2', 'inspector']);
    expect(records[0]!.join_command).toBe('crew join manager --role manager');
  });

  it('--client overrides the platform hint in join commands', () => {
    const { io, out } = captureIo({ cwd: workspace() });
    runTeamShow(io, 'dev', { client: 'codex-cli', json: true });
    const first = JSON.parse(out.join('').trim().split('\n')[0]!) as {
      platform: string;
      join_command: string;
    };
    expect(first.platform).toBe('codex-cli');
    expect(first.join_command).toContain('--platform codex-cli');
  });

  it('renders Little Coder platform and invocation under --client', () => {
    const { io, out } = captureIo({ cwd: workspace() });
    runTeamShow(io, 'dev', { client: 'little-coder', json: true });
    const first = JSON.parse(out.join('').trim().split('\n')[0]!) as {
      platform: string;
      join_command: string;
      invocation: string;
    };
    expect(first).toMatchObject({
      platform: 'little-coder',
      join_command: 'crew join manager --role manager --platform little-coder',
      invocation: '/crew manager manager',
    });
  });

  it('rejects an invalid --client with USAGE', () => {
    const { io } = captureIo({ cwd: workspace() });
    expectCode(() => runTeamShow(io, 'dev', { client: 'emacs', json: true }), 'USAGE');
  });

  it('adds the registry invocation when a platform resolves, omits it otherwise (FR-F13)', () => {
    const { io, out } = captureIo({ cwd: workspace() });
    runTeamShow(io, 'dev', { json: true });
    const noPlatform = JSON.parse(out.join('').trim().split('\n')[0]!) as { invocation?: string };
    expect(noPlatform.invocation).toBeUndefined();

    const withClient = captureIo({ cwd: workspace() });
    runTeamShow(withClient.io, 'dev', { client: 'codex-cli', json: true });
    const first = JSON.parse(withClient.out.join('').trim().split('\n')[0]!) as {
      invocation?: string;
    };
    expect(first.invocation).toBe('$crew manager manager');
  });

  it('renders the invocation in the human roster under --client', () => {
    const { io, out } = captureIo({ cwd: workspace() });
    runTeamShow(io, 'dev', { client: 'claude-code', json: false });
    expect(out.join('')).toContain('invoke=/crew manager manager');
  });

  it('prints a human roster by default', () => {
    const { io, out } = captureIo({ cwd: workspace() });
    runTeamsList(io, { json: false });
    expect(out.join('')).toContain('dev');
  });
});

describe('through the program', () => {
  it('crew teams and crew team dev exit 0', async () => {
    const cwd = workspace();
    expect(await run(['teams'], captureIo({ cwd }).io)).toBe(0);
    expect(await run(['team', 'dev'], captureIo({ cwd }).io)).toBe(0);
  });

  it('runs teams list with --json through the program', async () => {
    const cwd = workspace();
    const { io, out } = captureIo({ cwd });
    expect(await run(['teams', '--json'], io)).toBe(0);
    expect(JSON.parse(out.join('').trim())).toMatchObject({
      type: 'team',
      name: 'dev',
      source: 'packaged',
    });
  });

  it('runs team show with client override and --json through the program', async () => {
    const cwd = workspace();
    const { io, out } = captureIo({ cwd });
    expect(await run(['team', 'dev', '--client', 'codex-cli', '--json'], io)).toBe(0);
    const lines = out.join('').trim().split('\n');
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'team_member', platform: 'codex-cli' });
  });

  it('loads and lists packaged team when file is deleted', () => {
    const cwd = workspace();
    rmSync(teamPath(cwd, 'dev'));
    const { io } = captureIo({ cwd });
    expect(loadTeam(io, 'dev').name).toBe('dev');

    const teams = listTeams(io);
    const dev = teams.find((t) => t.name === 'dev');
    expect(dev).toMatchObject({ name: 'dev', source: 'packaged' });
  });

  it('yields control-free stderr when team config has control-bearing unknown key', async () => {
    const cwd = workspace();
    const badKey = 'x\x1b[31m\x1b]0;PWNED\x07y';
    const evilYaml = `version: 1
name: evil
members:
  - id: manager
    role: manager
"${badKey}": 1
`;
    writeFileSync(teamPath(cwd, 'evil'), evilYaml, 'utf8');

    const { io, err } = captureIo({ cwd });
    const code = await run(['team', 'evil'], io);
    expect(code).toBe(2); // INVALID_CONFIG exits 2

    const stderrStr = err.join('');
    expect(stderrStr).toContain('unknown key(s)');
    expect(stderrStr).not.toContain('\x1b');
    expect(stderrStr).not.toContain('\x07');
    expect(stderrStr).toContain('xy');
  });
});
