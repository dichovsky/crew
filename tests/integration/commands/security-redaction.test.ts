/**
 * [security] Output-leak acceptance (security.md item 9, FR-J13) at the program
 * layer. crew emits NO *credential* environment value on its command surfaces:
 * `doctor`/`setup` report only what they probe, by name; record commands render
 * stored fields, not the environment. This proves that even with an environment full
 * of secret-shaped values, none reach stdout or stderr — across `join`/`agents`/
 * `doctor` AND the env-consuming `team --launch --print` — and that the launch token
 * (stamped into the Store by a live launch) is never rendered. The one env-derived
 * value crew does emit, the worktree base path (from `XDG_DATA_HOME`/`HOME`), is a
 * non-secret filesystem location and is covered by `team-launch.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../../src/init.js';
import { run } from '../../../src/run.js';
import { captureIo } from '../../helpers/io.js';
import type { Io } from '../../../src/io.js';

const made: string[] = [];

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

const LAUNCH_TOKEN = 'a'.repeat(64);

/** Every secret VALUE seeded into the environment; none may appear in output. */
const SECRET_VALUES: readonly string[] = [
  LAUNCH_TOKEN,
  'AKIA0000000000000000',
  `sk-${'X'.repeat(30)}`,
  'hunter2supersecret',
  `ghp_${'Y'.repeat(36)}`,
];

/** A workspace whose environment is stuffed with credential-named secret values. */
function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-sec-'));
  made.push(cwd);
  const env: NodeJS.ProcessEnv = {
    HOME: '/home/u',
    PATH: fakeBin('tmux', 'git'),
    CREW_LAUNCH_TOKEN: LAUNCH_TOKEN,
    AWS_SECRET_ACCESS_KEY: 'AKIA0000000000000000',
    MY_API_TOKEN: `sk-${'X'.repeat(30)}`,
    DB_PASSWORD: 'hunter2supersecret',
    GH_PAT: `ghp_${'Y'.repeat(36)}`,
  };
  const capture = captureIo({ cwd, clock: () => 0, env });
  initWorkspace(capture.io, { withGuides: false, json: false });
  capture.out.length = 0;
  return { cwd, ...capture };
}

const LAUNCHER_YAML = `version: 1
project:
  name: crew-sec
  session_name: crew-sec
runtime:
  client: codex-cli
workspace:
  worktree:
    enabled: false
    branch: crew/sec
    base_ref: HEAD
relay:
  enabled: true
  poll_seconds: 2
  reminder_seconds: 30
focus:
  files:
    - src/
constraints:
  - Do not modify generated files.
`;

/** Same credential-stuffed workspace, plus the launcher config so `team --launch
 * --print` (which consumes the environment to derive the worktree base path) runs. */
function launchableWorkspace() {
  const w = workspace();
  writeFileSync(join(w.cwd, '.crew', 'launcher.yaml'), LAUNCHER_YAML);
  writeFileSync(join(w.cwd, '.crew', 'run-task.md'), '# Task\n\nDo the thing.\n');
  return w;
}

function assertNoSecret(text: string): void {
  for (const secret of SECRET_VALUES) {
    expect(text).not.toContain(secret);
  }
}

async function drive(io: Io, argvs: readonly string[][]): Promise<void> {
  for (const argv of argvs) await run(argv, io);
}

afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('program output never leaks environment secrets [security]', () => {
  it('emits no env-secret value across join/agents/doctor (human and JSON)', async () => {
    const { io, out, err } = workspace();
    await drive(io, [
      ['join', 'worker'],
      ['join', 'manager', '--json'],
      ['agents'],
      ['agents', '--json'],
      ['doctor'],
      ['doctor', '--json'],
      ['doctor', '--system', '--json'],
    ]);
    assertNoSecret(out.join(''));
    assertNoSecret(err.join(''));
  });

  it('never renders the stamped launch token on any surface (stdout or stderr)', async () => {
    const { io, out, err } = workspace();
    // The token is injected via CREW_LAUNCH_TOKEN and stamped onto the new Agent.
    expect(await run(['join', 'worker'], io)).toBe(0);
    out.length = 0;
    err.length = 0;
    await drive(io, [['agents'], ['agents', '--all', '--json'], ['doctor', '--json']]);
    expect(out.join('')).not.toContain(LAUNCH_TOKEN);
    expect(err.join('')).not.toContain(LAUNCH_TOKEN);
  });

  it('leaks no credential env value through the env-consuming launch plan (--print) [security]', async () => {
    // `team --launch --print` renders the managed worktree base path, which is derived
    // from XDG_DATA_HOME/HOME — so it is the one env-consuming command. Prove that even
    // there, only the non-secret path is env-derived: no credential VALUE reaches the
    // human or JSON launch-plan output.
    const { io, out, err } = launchableWorkspace();
    expect(await run(['team', 'dev', '--launch', '--print'], io)).toBe(0);
    expect(await run(['team', 'dev', '--launch', '--print', '--json'], io)).toBe(0);
    assertNoSecret(out.join(''));
    assertNoSecret(err.join(''));
  });
});
