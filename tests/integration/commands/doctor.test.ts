import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../../src/init.js';
import { run } from '../../../src/run.js';
import { captureIo } from '../../helpers/io.js';
import type { Io } from '../../../src/io.js';

const made: string[] = [];

/** A PATH dir holding empty executable stubs so dependency checks see them. */
function fakeBin(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-bin-'));
  made.push(dir);
  for (const name of names) {
    const file = join(dir, name);
    writeFileSync(file, '');
    chmodSync(file, 0o755);
  }
  return dir;
}

function workspace(clock: () => number = () => 0, env: NodeJS.ProcessEnv = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-doctor-'));
  made.push(cwd);
  const capture = captureIo({ cwd, clock, env });
  initWorkspace(capture.io, { withGuides: false, json: false });
  capture.out.length = 0;
  return { cwd, ...capture };
}

function records(output: readonly string[]): Array<Record<string, unknown>> {
  return output
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
  const id = records(out)[0]?.id as string;
  out.length = 0;
  return id;
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('crew doctor', () => {
  it('reports a healthy workspace with only a NO_STATE_STORE info and exits 0', async () => {
    const { io, out, err } = workspace(() => 0, {
      PATH: fakeBin('tmux', 'git', 'claude', 'codex', 'gemini', 'copilot', 'agy'),
    });
    expect(await run(['doctor', '--json'], io)).toBe(0);
    expect(err).toEqual([]);
    const recs = records(out);
    const summary = recs.at(-1)!;
    expect(summary).toEqual({
      type: 'health_summary',
      schema_version: 1,
      workspace: join(io.cwd, '.crew'),
      ok: true,
      info: 1,
      warn: 0,
      error: 0,
    });
    expect(recs[0]).toEqual({
      type: 'health_finding',
      schema_version: 1,
      severity: 'info',
      code: 'NO_STATE_STORE',
      message: 'No State Store yet; it is created on first use',
    });
  });

  it('emits a byte-stable DEPENDENCY_MISSING finding when a tool is absent', async () => {
    const { io, out } = workspace(() => 0, { PATH: fakeBin('git') });
    expect(await run(['doctor', '--json'], io)).toBe(0);
    const line = out.join('').split('\n').filter(Boolean)[0]!;
    expect(line).toBe(
      '{"type":"health_finding","schema_version":1,"severity":"info","code":"DEPENDENCY_MISSING","message":"tmux is not installed or not on PATH","details":{"dependency":"tmux"}}',
    );
  });

  it('runs --system without a Workspace and reports a null workspace', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'crew-nows-'));
    made.push(cwd);
    const { io, out } = captureIo({
      cwd,
      env: { PATH: fakeBin('tmux', 'git', 'claude', 'codex', 'gemini', 'copilot', 'agy') },
    });
    expect(await run(['doctor', '--system', '--json'], io)).toBe(0);
    const recs = records(out);
    expect(recs).toEqual([
      {
        type: 'health_summary',
        schema_version: 1,
        workspace: null,
        ok: true,
        info: 0,
        warn: 0,
        error: 0,
      },
    ]);
  });

  it('requires a Workspace in default mode', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'crew-nows-'));
    made.push(cwd);
    const { io, out, err } = captureIo({ cwd, env: { PATH: fakeBin('tmux', 'git') } });
    expect(await run(['doctor', '--json'], io)).toBe(1);
    expect(out).toEqual([]);
    expect(JSON.parse(err.join(''))).toMatchObject({ error: { code: 'NOT_WORKSPACE' } });
  });

  it('flags an expired Lease as a STALE_LEASE warning', async () => {
    let now = 0;
    const { io, out } = workspace(() => now, { PATH: fakeBin('tmux', 'git') });
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    now = 10;
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);
    out.length = 0;

    now = 100_000; // well past the 15-minute lease
    expect(await run(['doctor', '--json'], io)).toBe(0);
    const stale = records(out).find((r) => r.code === 'STALE_LEASE')!;
    expect(stale).toMatchObject({
      type: 'health_finding',
      severity: 'warn',
      code: 'STALE_LEASE',
      details: { task_id: id },
    });
  });

  it('flags an archived assignee as an ARCHIVED_OWNER warning', async () => {
    const { io, out } = workspace(() => 0, { PATH: fakeBin('tmux', 'git') });
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    expect(await run(['leave', 'worker', '--json'], io)).toBe(0);
    out.length = 0;

    expect(await run(['doctor', '--json'], io)).toBe(0);
    const finding = records(out).find((r) => r.code === 'ARCHIVED_OWNER')!;
    expect(finding).toMatchObject({
      severity: 'warn',
      code: 'ARCHIVED_OWNER',
      details: { task_id: id, agent_id: 'worker' },
    });
  });

  it('reports an edited built-in role as ROLE_DRIFT info', async () => {
    const { io, out, cwd } = workspace(() => 0, { PATH: fakeBin('tmux', 'git') });
    writeFileSync(join(cwd, '.crew', 'roles', 'manager.md'), '# Edited manager role\n');
    expect(await run(['doctor', '--json'], io)).toBe(0);
    const finding = records(out).find((r) => r.code === 'ROLE_DRIFT')!;
    expect(finding).toMatchObject({
      severity: 'info',
      code: 'ROLE_DRIFT',
      details: { role: 'manager' },
    });
  });

  it('reports schema drift as an error finding and exits 1 with a stderr envelope', async () => {
    const { io, out, err } = workspace(() => 0, { PATH: fakeBin('tmux', 'git') });
    await joinAgents(io, 'manager'); // create the store
    out.length = 0;
    const raw = new DatabaseSync(join(io.cwd, '.crew', 'state', 'crew.db'));
    raw.exec('DROP INDEX idx_messages_unread');
    raw.close();

    expect(await run(['doctor', '--json'], io)).toBe(1);
    const drift = records(out).find((r) => r.code === 'SCHEMA_DRIFT')!;
    expect(drift).toMatchObject({ severity: 'error', code: 'SCHEMA_DRIFT' });
    expect(records(out).at(-1)).toMatchObject({ type: 'health_summary', ok: false, error: 1 });
    expect(JSON.parse(err.join(''))).toMatchObject({ error: { code: 'INTEGRITY' } });
  });

  it('emits error findings before earlier collected info findings', async () => {
    const { io, out } = workspace(() => 0, { PATH: fakeBin('tmux', 'git') });
    await joinAgents(io, 'manager');
    out.length = 0;
    const raw = new DatabaseSync(join(io.cwd, '.crew', 'state', 'crew.db'));
    raw.exec('DROP INDEX idx_messages_unread');
    raw.close();

    expect(await run(['doctor', '--json'], io)).toBe(1);
    const findings = records(out).filter((record) => record.type === 'health_finding');
    expect(findings[0]).toMatchObject({ severity: 'error', code: 'SCHEMA_DRIFT' });
  });

  it('reports a symlinked project Role as a per-file UNSAFE_PATH warning', async () => {
    const { io, out, cwd } = workspace(() => 0, { PATH: fakeBin('tmux', 'git') });
    const target = join(cwd, 'shared-worker.md');
    writeFileSync(target, '# Shared worker\n');
    rmSync(join(cwd, '.crew', 'roles', 'worker.md'));
    symlinkSync(target, join(cwd, '.crew', 'roles', 'worker.md'));

    expect(await run(['doctor', '--json'], io)).toBe(0);
    expect(records(out).find((record) => record.code === 'UNSAFE_PATH')).toMatchObject({
      severity: 'warn',
      details: { config: 'roles', name: 'worker' },
    });
  });

  it('degrades an unreadable project role to a warning and still reports store integrity errors', async () => {
    const { io, out, err, cwd } = workspace(() => 0, { PATH: fakeBin('tmux', 'git') });
    await joinAgents(io, 'manager');
    out.length = 0;
    const raw = new DatabaseSync(join(cwd, '.crew', 'state', 'crew.db'));
    raw.exec('DROP INDEX idx_messages_unread');
    raw.close();
    writeFileSync(join(cwd, '.crew', 'roles', 'manager.md'), 'x'.repeat(300_000));

    expect(await run(['doctor', '--json'], io)).toBe(1);
    const recs = records(out);
    expect(recs.find((r) => r.code === 'INVALID_CONFIG')).toMatchObject({
      severity: 'warn',
      details: { config: 'roles' },
    });
    expect(recs.find((r) => r.code === 'SCHEMA_DRIFT')).toMatchObject({
      severity: 'error',
      code: 'SCHEMA_DRIFT',
    });
    expect(recs.at(-1)).toMatchObject({
      type: 'health_summary',
      ok: false,
      warn: 1,
      error: 1,
    });
    expect(JSON.parse(err.join(''))).toMatchObject({ error: { code: 'INTEGRITY' } });
  });

  it('degrades a non-UTF-8 project team file to a warning instead of aborting doctor', async () => {
    const { io, out, err, cwd } = workspace(() => 0, { PATH: fakeBin('tmux', 'git') });
    writeFileSync(join(cwd, '.crew', 'teams', 'dev.yaml'), Buffer.from([0xc3, 0x28]));

    expect(await run(['doctor', '--json'], io)).toBe(0);
    const recs = records(out);
    expect(recs.find((r) => r.code === 'INVALID_CONFIG')).toMatchObject({
      severity: 'warn',
      details: { config: 'teams' },
    });
    expect(recs.at(-1)).toMatchObject({
      type: 'health_summary',
      ok: true,
      warn: 1,
      error: 0,
    });
    expect(err).toEqual([]);
  });

  it('degrades a raw filesystem read failure in project roles instead of aborting doctor', async () => {
    const { io, out, err, cwd } = workspace(() => 0, { PATH: fakeBin('tmux', 'git') });
    const rolePath = join(cwd, '.crew', 'roles', 'manager.md');
    chmodSync(rolePath, 0o000);

    try {
      expect(await run(['doctor', '--json'], io)).toBe(0);
      const recs = records(out);
      expect(recs.find((r) => r.code === 'INVALID_CONFIG')).toMatchObject({
        severity: 'warn',
        details: { config: 'roles' },
      });
      expect(recs.at(-1)).toMatchObject({
        type: 'health_summary',
        ok: true,
        warn: 1,
        error: 0,
      });
      expect(err).toEqual([]);
    } finally {
      chmodSync(rolePath, 0o644);
    }
  });

  it('degrades one bad project role per file while still checking the remaining valid roles', async () => {
    const { io, out, err, cwd } = workspace(() => 0, { PATH: fakeBin('tmux', 'git') });
    // One oversized (unreadable) project role next to one valid edited built-in:
    // doctor must warn about the former and still detect drift on the latter.
    writeFileSync(join(cwd, '.crew', 'roles', 'broken.md'), 'x'.repeat(300_000));
    writeFileSync(join(cwd, '.crew', 'roles', 'worker.md'), '# Edited worker role\n');

    expect(await run(['doctor', '--json'], io)).toBe(0);
    const recs = records(out);
    expect(recs.find((r) => r.code === 'INVALID_CONFIG')).toMatchObject({
      severity: 'warn',
      details: { config: 'roles', name: 'broken' },
    });
    expect(recs.find((r) => r.code === 'ROLE_DRIFT')).toMatchObject({
      severity: 'info',
      details: { role: 'worker' },
    });
    expect(recs.at(-1)).toMatchObject({
      type: 'health_summary',
      ok: true,
      warn: 1,
      error: 0,
    });
    expect(err).toEqual([]);
  });

  it('degrades unreadable roles and teams directories to whole-listing warnings', async () => {
    const { io, out, err, cwd } = workspace(() => 0, { PATH: fakeBin('tmux', 'git') });
    const rolesDir = join(cwd, '.crew', 'roles');
    const teamsDir = join(cwd, '.crew', 'teams');
    chmodSync(rolesDir, 0o000);
    chmodSync(teamsDir, 0o000);

    try {
      expect(await run(['doctor', '--json'], io)).toBe(0);
      const recs = records(out);
      const failures = recs.filter((r) => r.code === 'INVALID_CONFIG');
      // Whole-listing failures carry no per-file name, only the config kind.
      expect(failures.map((r) => r.details)).toEqual([{ config: 'roles' }, { config: 'teams' }]);
      expect(recs.at(-1)).toMatchObject({
        type: 'health_summary',
        ok: true,
        warn: 2,
        error: 0,
      });
      expect(err).toEqual([]);
    } finally {
      chmodSync(rolesDir, 0o755);
      chmodSync(teamsDir, 0o755);
    }
  });

  it('reports a newer schema as UNSUPPORTED_SCHEMA and exits 1', async () => {
    const { io, out, err } = workspace(() => 0, { PATH: fakeBin('tmux', 'git') });
    await joinAgents(io, 'manager');
    out.length = 0;
    const raw = new DatabaseSync(join(io.cwd, '.crew', 'state', 'crew.db'));
    raw.exec('PRAGMA user_version = 8');
    raw.close();

    expect(await run(['doctor', '--json'], io)).toBe(1);
    expect(records(out).find((r) => r.code === 'UNSUPPORTED_SCHEMA')).toMatchObject({
      severity: 'error',
      details: { version: 8 },
    });
    expect(JSON.parse(err.join(''))).toMatchObject({ error: { code: 'UNSUPPORTED_SCHEMA' } });
  });

  it('reports an unopenable State Store as an INTEGRITY error and exits 1', async () => {
    const { io, out, err } = workspace(() => 0, { PATH: fakeBin('tmux', 'git') });
    writeFileSync(join(io.cwd, '.crew', 'state', 'crew.db'), 'not a database');
    expect(await run(['doctor', '--json'], io)).toBe(1);
    expect(records(out).find((r) => r.code === 'INTEGRITY')).toMatchObject({ severity: 'error' });
    expect(JSON.parse(err.join(''))).toMatchObject({ error: { code: 'INTEGRITY' } });
  });

  it('reports an edited built-in team as TEAM_DRIFT info', async () => {
    const { io, out, cwd } = workspace(() => 0, { PATH: fakeBin('tmux', 'git') });
    const teamsDir = join(cwd, '.crew', 'teams');
    const teamFile = readdirSync(teamsDir).find((name) => name.endsWith('.yaml'))!;
    writeFileSync(join(teamsDir, teamFile), '# locally edited team\n');
    expect(await run(['doctor', '--json'], io)).toBe(0);
    expect(records(out).find((r) => r.code === 'TEAM_DRIFT')).toMatchObject({
      severity: 'info',
      code: 'TEAM_DRIFT',
    });
  });

  it('renders findings with details on the human surface', async () => {
    let now = 0;
    const { io, out } = workspace(() => now, { PATH: fakeBin('tmux', 'git') });
    await joinAgents(io, 'manager', 'worker', 'inspector');
    const id = await createTask(io, out);
    now = 10;
    expect(await run(['task', 'start', 'worker', id, '--json'], io)).toBe(0);
    out.length = 0;
    now = 100_000;
    expect(await run(['doctor'], io)).toBe(0);
    expect(out.join('')).toContain('STALE_LEASE');
    expect(out.join('')).toContain(`task_id=${id}`);
  });

  it('treats an executable directory on PATH as a missing dependency', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'crew-nows-'));
    made.push(cwd);
    const binDir = mkdtempSync(join(tmpdir(), 'crew-bin-'));
    made.push(binDir);
    mkdirSync(join(binDir, 'tmux')); // a directory named like the command
    for (const name of ['git', 'claude', 'codex', 'gemini', 'copilot', 'agy']) {
      const file = join(binDir, name);
      writeFileSync(file, '');
      chmodSync(file, 0o755);
    }
    const { io, out } = captureIo({ cwd, env: { PATH: binDir } });
    expect(await run(['doctor', '--system', '--json'], io)).toBe(0);
    const codes = records(out)
      .filter((r) => r.type === 'health_finding')
      .map((r) => r.details);
    expect(codes).toEqual([{ dependency: 'tmux' }]); // git + participants (real files) are present
  });

  it('warns when a nested .crew workspace shadows an ancestor (FR-B02)', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'crew-outer-'));
    made.push(outer);
    initWorkspace(captureIo({ cwd: outer }).io, { withGuides: false, json: false });
    const inner = join(outer, 'inner');
    mkdirSync(inner);
    const innerInit = captureIo({ cwd: inner });
    initWorkspace(innerInit.io, { withGuides: false, json: false });
    const { io, out } = captureIo({ cwd: inner, env: { PATH: fakeBin('tmux', 'git') } });
    expect(await run(['doctor', '--json'], io)).toBe(0);
    expect(records(out).find((r) => r.code === 'NESTED_WORKSPACE')).toMatchObject({
      severity: 'warn',
      code: 'NESTED_WORKSPACE',
      details: { outer: join(outer, '.crew') },
    });
  });

  it('sanitizes ANSI/newlines from a corrupt store in human findings (FR-J08)', async () => {
    const { io, out } = workspace(() => 0, { PATH: fakeBin('tmux', 'git') });
    await joinAgents(io, 'manager'); // create the store
    out.length = 0;
    const evil = `${String.fromCharCode(27)}[31mPWNED${String.fromCharCode(27)}[0m\nFORGED`;
    const raw = new DatabaseSync(join(io.cwd, '.crew', 'state', 'crew.db'));
    raw.exec(`CREATE TABLE "${evil}" (a INTEGER)`);
    raw.close();

    expect(await run(['doctor'], io)).toBe(1); // schema drift = error
    const text = out.join('');
    expect(text).not.toContain(String.fromCharCode(27)); // no raw ESC reaches the terminal
    // the embedded newline is escaped, so no output line is a forged bare "FORGED"
    expect(text.split('\n')).not.toContain('FORGED');
  });

  it('renders a human summary and retention footer in default mode', async () => {
    const { io, out } = workspace(() => 0, { PATH: fakeBin('tmux', 'git') });
    expect(await run(['doctor'], io)).toBe(0);
    const text = out.join('');
    expect(text).toContain('Workspace ');
    expect(text).toContain('Findings  0 error');
    expect(text).toContain('Retention:');
    expect(text).toContain('at-most-once');
  });
});

describe('crew doctor — participant and setup findings (FR-K01)', () => {
  it('reports an absent Participant CLI as info DEPENDENCY_MISSING with its target', async () => {
    // Only claude present; the other four participants are absent.
    const { io, out } = workspace(() => 0, { PATH: fakeBin('tmux', 'git', 'claude') });
    expect(await run(['doctor', '--json'], io)).toBe(0);
    const recs = records(out).filter((r) => r.code === 'DEPENDENCY_MISSING');
    const targets = recs.map((r) => (r.details as Record<string, unknown>).target).filter(Boolean);
    expect(targets).toEqual(['codex-cli', 'gemini-cli', 'copilot-cli', 'antigravity-cli']);
    for (const r of recs) expect(r.severity).toBe('info');
  });

  it('flags an edited global artifact as a SETUP_DRIFT warning with a runnable remediation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'crew-home-'));
    made.push(home);
    // Only claude present, so the other participants do not add absent-global findings.
    const { io, out } = workspace(() => 0, { HOME: home, PATH: fakeBin('tmux', 'git', 'claude') });
    expect(await run(['setup', 'claude-code'], io)).toBe(0); // write the global artifact
    const artifact = join(home, '.claude/skills/crew/SKILL.md');
    writeFileSync(artifact, readFileSync(artifact, 'utf8') + '\nlocal edit\n');
    out.length = 0;
    expect(await run(['doctor', '--json'], io)).toBe(0);
    const drift = records(out).find((r) => r.code === 'SETUP_DRIFT')!;
    expect(drift).toMatchObject({
      severity: 'warn',
      code: 'SETUP_DRIFT',
      details: { target: 'claude-code', scope: 'global', drift: 'managed-edited' },
    });
    // The remediation command names the target + --force and is itself valid usage.
    expect(drift.message).toContain('crew setup claude-code --force');
  });

  it('flags an installed CLI with no global artifact as an absent SETUP_DRIFT info', async () => {
    const home = mkdtempSync(join(tmpdir(), 'crew-home-'));
    made.push(home);
    // claude is installed but `crew setup claude-code` has not been run.
    const { io, out } = workspace(() => 0, { HOME: home, PATH: fakeBin('tmux', 'git', 'claude') });
    expect(await run(['doctor', '--json'], io)).toBe(0);
    const drift = records(out).find(
      (r) =>
        r.code === 'SETUP_DRIFT' && (r.details as Record<string, unknown>).target === 'claude-code',
    )!;
    expect(drift).toMatchObject({
      severity: 'info',
      details: { target: 'claude-code', scope: 'global', drift: 'absent' },
    });
    expect(drift.message).toContain('crew setup claude-code');
  });

  it('does NOT flag an absent global artifact when the CLI is not installed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'crew-home-'));
    made.push(home);
    // No participant CLIs on PATH → absent artifacts are the normal pre-setup state.
    const { io, out } = workspace(() => 0, { HOME: home, PATH: fakeBin('tmux', 'git') });
    expect(await run(['doctor', '--json'], io)).toBe(0);
    expect(records(out).some((r) => r.code === 'SETUP_DRIFT')).toBe(false);
  });

  it('flags an outdated global artifact as a SETUP_DRIFT info', async () => {
    const home = mkdtempSync(join(tmpdir(), 'crew-home-'));
    made.push(home);
    const { io, out } = workspace(() => 0, {
      HOME: home,
      PATH: fakeBin('tmux', 'git', 'claude', 'codex', 'gemini', 'copilot', 'agy'),
    });
    // An internally-consistent artifact from an older registry revision.
    const blanked =
      '<!-- generated-by: crew setup; registry-revision: 0; content-hash: sha256: -->\nbody\n';
    const digest = createHash('sha256').update(blanked, 'utf8').digest('hex');
    const dir = join(home, '.claude/skills/crew');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      blanked.replace('content-hash: sha256:', `content-hash: sha256:${digest}`),
    );
    expect(await run(['doctor', '--json'], io)).toBe(0);
    const drift = records(out).find((r) => r.code === 'SETUP_DRIFT')!;
    expect(drift).toMatchObject({ severity: 'info', details: { drift: 'managed-outdated' } });
  });

  it('flags an unmanaged project artifact as a SETUP_DRIFT warning only in workspace mode', async () => {
    const home = mkdtempSync(join(tmpdir(), 'crew-home-'));
    made.push(home);
    const { io, out, cwd } = workspace(() => 0, {
      HOME: home,
      PATH: fakeBin('tmux', 'git', 'claude', 'codex', 'gemini', 'copilot', 'agy'),
    });
    // A non-crew file squats the project copilot path.
    const squat = join(cwd, '.github/agents/crew.agent.md');
    mkdirSync(join(cwd, '.github/agents'), { recursive: true });
    writeFileSync(squat, 'hand-written agent\n');

    expect(await run(['doctor', '--json'], io)).toBe(0);
    const wsDrift = records(out).find(
      (r) => r.code === 'SETUP_DRIFT' && (r.details as Record<string, unknown>).scope === 'project',
    );
    expect(wsDrift).toMatchObject({ severity: 'warn', details: { drift: 'unmanaged' } });

    // --system mode must NOT check project artifacts.
    out.length = 0;
    expect(await run(['doctor', '--system', '--json'], io)).toBe(0);
    const sysDrift = records(out).find(
      (r) => r.code === 'SETUP_DRIFT' && (r.details as Record<string, unknown>).scope === 'project',
    );
    expect(sysDrift).toBeUndefined();
  });

  it('deduplicates a shared project artifact into one SETUP_DRIFT finding', async () => {
    const { io, out, cwd } = workspace(() => 0, {
      PATH: fakeBin('tmux', 'git', 'claude', 'codex', 'gemini', 'copilot', 'agy'),
    });
    const shared = join(cwd, '.agents', 'skills', 'crew', 'SKILL.md');
    mkdirSync(join(cwd, '.agents', 'skills', 'crew'), { recursive: true });
    writeFileSync(shared, 'hand-written shared skill\n');

    expect(await run(['doctor', '--json'], io)).toBe(0);
    const projectDrifts = records(out).filter(
      (r) => r.code === 'SETUP_DRIFT' && (r.details as Record<string, unknown>).scope === 'project',
    );
    expect(projectDrifts).toHaveLength(1);
    expect(projectDrifts[0]).toMatchObject({
      severity: 'warn',
      details: {
        target: 'codex-cli',
        targets: ['codex-cli', 'antigravity-cli'],
        scope: 'project',
        path: '.agents/skills/crew/SKILL.md',
        drift: 'unmanaged',
      },
    });
    expect(projectDrifts[0]?.message).toContain('crew setup codex-cli --project --force');
  });
});

describe('doctor Participant version floor', () => {
  it('warns (warn, exit 0) when an installed Participant CLI is below its verified floor', async () => {
    const { io, out } = captureIo({
      env: { PATH: fakeBin('claude') },
      clock: () => 0,
      runProcess: () => Promise.resolve({ status: 0, stdout: '1.0.0 (Claude Code)', stderr: '' }),
    });
    expect(await run(['doctor', '--system', '--json'], io)).toBe(0);
    const recs = records(out);
    expect(recs.find((r) => r.code === 'VERSION_FLOOR')).toMatchObject({
      severity: 'warn',
      details: { target: 'claude-code', detected: '1.0.0', minimum: '2.1.197' },
    });
    // A version warning never fails doctor — the floor is advisory (crew coordinates
    // whatever a Participant CLI is), so the run still exits 0 with ok: true.
    expect(recs.at(-1)).toMatchObject({ type: 'health_summary', ok: true });
  });

  it('does not warn at/above the floor or when --version is unparseable', async () => {
    for (const stdout of ['9.9.9 (Claude Code)', 'claude (no version here)']) {
      const { io, out } = captureIo({
        env: { PATH: fakeBin('claude') },
        clock: () => 0,
        runProcess: () => Promise.resolve({ status: 0, stdout, stderr: '' }),
      });
      expect(await run(['doctor', '--system', '--json'], io)).toBe(0);
      expect(records(out).some((r) => r.code === 'VERSION_FLOOR')).toBe(false);
    }
  });
});
