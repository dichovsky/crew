import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../../src/init.js';
import { writePlanArtifacts, writeResumeMarker } from '../../../src/launcher/artifacts.js';
import { loadLauncherConfig, mergeEffectiveConfig } from '../../../src/launcher/config.js';
import { buildLaunchPlan } from '../../../src/launcher/plan.js';
import { run } from '../../../src/run.js';
import { openWorkspaceStore } from '../../../src/store/index.js';
import { captureIo } from '../../helpers/io.js';

// A toggle for a scoped `node:fs.statfsSync` fake: everything else stays the real
// module. Only doctor's network-filesystem probe reads statfsSync, so flipping this
// exercises the NETWORK_FILESYSTEM branch (line 217) without a real network mount.
const fsState = vi.hoisted(() => ({ networkFs: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const statfsSync = ((path: string) =>
    fsState.networkFs
      ? // 0x6969 is the NFS f_type magic in doctor's NETWORK_FS_TYPES set.
        { type: 0x6969, bsize: 4096, blocks: 0, bfree: 0, bavail: 0, files: 0, ffree: 0 }
      : actual.statfsSync(path)) as unknown as typeof actual.statfsSync;
  return { ...actual, statfsSync };
});

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
  const cwd = mkdtempSync(join(tmpdir(), 'crew-doctor-edge-'));
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

afterEach(() => {
  fsState.networkFs = false;
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('crew doctor — uncovered diagnostic and rendering branches', () => {
  // Lines 202 (state absent -> probe the .crew root) + 209 (target not writable -> STATE_PATH).
  it.skipIf(process.getuid?.() === 0)(
    'falls back to the .crew root for the writability probe and warns when it is unwritable',
    async () => {
      const { io, out, cwd } = workspace(() => 0, { PATH: fakeBin('tmux', 'git') });
      const crew = join(cwd, '.crew');
      // Remove state/ so existsSync(paths.state) is false and the probe target is paths.crew.
      rmSync(join(crew, 'state'), { recursive: true, force: true });
      // Make the fallback target unwritable so accessSync(W_OK) throws.
      chmodSync(crew, 0o500);
      try {
        expect(await run(['doctor', '--json'], io)).toBe(0);
        const statePath = records(out).find((r) => r.code === 'STATE_PATH')!;
        expect(statePath).toMatchObject({
          severity: 'warn',
          code: 'STATE_PATH',
          message: 'State directory is not writable',
          details: { path: crew },
        });
      } finally {
        chmodSync(crew, 0o700);
      }
    },
  );

  // Line 217: detectNetworkFilesystem(target) true -> NETWORK_FILESYSTEM warning.
  it('warns when the State directory appears to be on a network filesystem', async () => {
    const { io, out, cwd } = workspace(() => 0, { PATH: fakeBin('tmux', 'git') });
    fsState.networkFs = true;
    try {
      expect(await run(['doctor', '--json'], io)).toBe(0);
      const finding = records(out).find((r) => r.code === 'NETWORK_FILESYSTEM')!;
      expect(finding).toMatchObject({
        severity: 'warn',
        code: 'NETWORK_FILESYSTEM',
        details: { path: join(cwd, '.crew', 'state') },
      });
    } finally {
      fsState.networkFs = false;
    }
  });

  // Line 255: facts.nonEmptyV0 true -> UNSUPPORTED_SCHEMA error (objects at user_version 0).
  it('reports a non-empty version-0 store as UNSUPPORTED_SCHEMA and exits 1', async () => {
    const { io, out, err, cwd } = workspace(() => 0, { PATH: fakeBin('tmux', 'git') });
    const raw = new DatabaseSync(join(cwd, '.crew', 'state', 'crew.db'));
    raw.exec('CREATE TABLE junk (a INTEGER)'); // an application object while user_version stays 0
    raw.close();

    expect(await run(['doctor', '--json'], io)).toBe(1);
    expect(records(out).find((r) => r.code === 'UNSUPPORTED_SCHEMA')).toMatchObject({
      severity: 'error',
      message: 'State Store has unrecognized objects at schema version 0',
    });
    expect(JSON.parse(err.join(''))).toMatchObject({ error: { code: 'UNSUPPORTED_SCHEMA' } });
  });

  // Line 269: facts.foreignKeyOk false -> INTEGRITY error from the foreign-key check.
  it('reports a foreign-key violation as an INTEGRITY error and exits 1', async () => {
    const { io, out, cwd } = workspace(() => 0, { PATH: fakeBin('tmux', 'git') });
    const raw = new DatabaseSync(join(cwd, '.crew', 'state', 'crew.db'));
    raw.exec('PRAGMA foreign_keys = OFF');
    raw.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)');
    raw.exec('CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id))');
    raw.exec('INSERT INTO child (id, pid) VALUES (1, 42)'); // 42 references no parent row
    raw.close();

    expect(await run(['doctor', '--json'], io)).toBe(1);
    expect(
      records(out).find(
        (r) => r.code === 'INTEGRITY' && r.message === 'State Store failed its foreign-key check',
      ),
    ).toMatchObject({ severity: 'error' });
  });

  // Lines 421 ("No findings."), 424 (workspace === null -> "(system check only)"),
  // and 429 (--system skips the retention footer) on the human surface.
  it('prints "No findings.", a system-only workspace line, and no footer in --system human mode', async () => {
    const home = mkdtempSync(join(tmpdir(), 'crew-home-'));
    made.push(home);
    const cwd = mkdtempSync(join(tmpdir(), 'crew-sys-'));
    made.push(cwd);
    const { io, out } = captureIo({
      cwd,
      clock: () => 0,
      env: {
        HOME: home,
        PATH: fakeBin('tmux', 'git', 'claude', 'codex', 'gemini', 'copilot', 'agy'),
      },
      // Above every participant floor, so no VERSION_FLOOR finding is produced.
      runProcess: () => Promise.resolve({ status: 0, stdout: '9.9.9', stderr: '' }),
    });
    // Write every current global artifact so no SETUP_DRIFT (absent) finding remains.
    for (const id of ['claude-code', 'codex-cli', 'gemini-cli', 'copilot-cli', 'antigravity-cli']) {
      expect(await run(['setup', id], io)).toBe(0);
    }
    out.length = 0;

    expect(await run(['doctor', '--system'], io)).toBe(0);
    const text = out.join('');
    expect(text).toContain('No findings.');
    expect(text).toContain('Workspace (system check only)');
    expect(text).toContain('Findings  0 error, 0 warn, 0 info — ok');
    expect(text).not.toContain('Retention:');
  });

  // Lines 402,407,409,410: the resume scan enters .crew/generated, skips plain
  // files and marker-less directories, and reports RESUME_DRIFT for a stopped
  // session that is no longer resumable.
  it('warns RESUME_DRIFT for a stopped session that is no longer resumable, skipping non-sessions', async () => {
    const { io, out, cwd } = workspace(() => 0, { HOME: '/home/u', PATH: fakeBin('git') });
    const generated = join(cwd, '.crew', 'generated');
    mkdirSync(join(generated, 'crew-dead'), { recursive: true });
    // An unreadable marker: listResumableSessions omits the session, but the
    // scan still sees resume.json on disk — that is the drift being reported.
    writeFileSync(join(generated, 'crew-dead', 'resume.json'), '{}');
    mkdirSync(join(generated, 'no-marker'), { recursive: true }); // no resume.json -> skipped
    writeFileSync(join(generated, 'stray.txt'), ''); // not a directory -> skipped

    expect(await run(['doctor', '--json'], io)).toBe(0);
    const drift = records(out).filter((r) => r.code === 'RESUME_DRIFT');
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      severity: 'warn',
      message: 'Stopped session "crew-dead" is no longer resumable',
    });
  });

  // Line 410 (still resumable -> continue): a resumable session produces no finding.
  it('does not report RESUME_DRIFT for a session that is still cleanly resumable', async () => {
    const { io, out, cwd } = workspace(() => 0, {
      HOME: '/home/u',
      PATH: fakeBin('git', 'codex'),
    });
    writeFileSync(
      join(cwd, '.crew', 'launcher.yaml'),
      [
        'version: 1',
        'project:',
        '  name: crew-demo',
        '  session_name: crew-demo',
        'runtime:',
        '  client: codex-cli',
        '',
      ].join('\n'),
    );
    const config = mergeEffectiveConfig(loadLauncherConfig(cwd), {});
    const plan = buildLaunchPlan(io, 'dev', config).plan;
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
    const store = openWorkspaceStore(cwd, () => 10);
    try {
      for (const entry of plan.roster) {
        store.joinAgent({ id: entry.agent_id, role: entry.role, platformId: plan.client });
        store.leaveAgent(entry.agent_id);
      }
    } finally {
      store.close();
    }
    out.length = 0;

    expect(await run(['doctor', '--json'], io)).toBe(0);
    expect(records(out).filter((r) => r.code === 'RESUME_DRIFT')).toEqual([]);
  });
});
