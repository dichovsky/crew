import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initWorkspace } from '../../../src/init.js';
import { renderLaunchResult } from '../../../src/launcher/index.js';
import { run } from '../../../src/run.js';
import { captureIo } from '../../helpers/io.js';
import type { Io } from '../../../src/io.js';

const made: string[] = [];
const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/launch-plan.dev.json'),
  'utf8',
);

const LAUNCHER_YAML = `version: 1
project:
  name: crew-demo
  session_name: crew-demo
runtime:
  client: codex-cli
workspace:
  worktree:
    enabled: false
    branch: crew/demo
    base_ref: HEAD
relay:
  enabled: true
  poll_seconds: 2
  reminder_seconds: 30
focus:
  files:
    - src/
  docs:
    - docs/design/architecture.md
constraints:
  - Do not modify generated files.
`;

/** A workspace seeded with the configuration.md launcher.yaml example and a Task brief. */
function demoWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-launch-'));
  made.push(dir);
  initWorkspace(captureIo({ cwd: dir }).io, { withGuides: false, json: false });
  writeFileSync(join(dir, '.crew', 'launcher.yaml'), LAUNCHER_YAML);
  writeFileSync(join(dir, '.crew', 'run-task.md'), '# Task\n\nDo the thing.\n');
  return dir;
}

function io(cwd: string, overrides: Partial<Io> = {}): { io: Io; out: string[]; err: string[] } {
  return captureIo({ cwd, env: { HOME: '/home/u' }, clock: () => 0, ...overrides });
}

afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('crew team <name> --launch --print', () => {
  it('emits JSON byte-identical to the stable launch-plan fixture', async () => {
    const cwd = demoWorkspace();
    const { io: testIo, out } = io(cwd);
    expect(await run(['team', 'dev', '--launch', '--print', '--json'], testIo)).toBe(0);
    expect(out.join('')).toBe(FIXTURE);
  });

  it('renders a compact human summary with provenance and brief metadata', async () => {
    const cwd = demoWorkspace();
    const { io: testIo, out } = io(cwd);
    expect(await run(['team', 'dev', '--launch', '--print'], testIo)).toBe(0);
    const text = out.join('');
    expect(text).toContain('LAUNCH PLAN dev (session crew-demo)');
    expect(text).toContain('Client: codex-cli (codex) [source: runtime.client]');
    expect(text).toContain('Worktree: disabled');
    expect(text).toContain('Panes: 1 manager + 2 worker + 1 inspector = 4');
    expect(text).toContain('→ Manager, under guard');
    // metadata only: the brief body is never printed
    expect(text).not.toContain('Do the thing.');
  });

  it('bare --launch with no tmux returns DEPENDENCY_MISSING and manual-launch guidance (FR-H02)', async () => {
    const cwd = demoWorkspace();
    // captureIo's default runProcess reports "could not spawn" (status null), so the
    // adapter sees tmux as absent — the live launch must refuse cleanly before any
    // session is created.
    const { io: testIo, err } = io(cwd);
    expect(await run(['team', 'dev', '--launch'], testIo)).toBe(1);
    expect(err.join('')).toContain('[DEPENDENCY_MISSING]');
    expect(err.join('')).toContain('tmux');
    expect(err.join('')).toContain('crew team dev');
  });

  it('a worktree-enabled LIVE launch now resolves the worktree, but --print stays pure', async () => {
    const cwd = demoWorkspace();
    const { io: liveIo, err } = io(cwd, { env: { HOME: '/home/u', XDG_DATA_HOME: '/data' } });
    // Live (no --print) + worktree: the refusal is gone (ADR-0011). This
    // test environment has no tmux, so preflight's tmux-presence check (which
    // runs before worktree resolution) fails first — proving the launch reaches
    // real preflight instead of the old blanket USAGE refusal.
    expect(await run(['team', 'dev', '--launch', '--worktree', 'crew/x'], liveIo)).toBe(1);
    expect(err.join('')).toContain('[DEPENDENCY_MISSING]');
    expect(err.join('')).toContain('tmux');
    // --print with the same worktree still emits a plan (side-effect-free).
    const { io: printIo, out } = io(cwd, { env: { HOME: '/home/u', XDG_DATA_HOME: '/data' } });
    expect(await run(['team', 'dev', '--launch', '--worktree', 'crew/x', '--print'], printIo)).toBe(
      0,
    );
    expect(out.join('')).toContain('LAUNCH PLAN dev');
  });

  it('refuses a mixed-platform-hint team with USAGE', async () => {
    const cwd = demoWorkspace();
    writeFileSync(
      join(cwd, '.crew', 'teams', 'mixed.yaml'),
      'version: 1\nname: mixed\nmembers:\n' +
        '  - id: manager\n    role: manager\n    platform: claude-code\n' +
        '  - id: worker\n    role: worker\n    platform: codex-cli\n',
    );
    // a launcher.yaml without runtime.client so neither flag nor config supplies one
    writeFileSync(join(cwd, '.crew', 'launcher.yaml'), 'version: 1\n');
    const { io: testIo, err } = io(cwd);
    expect(await run(['team', 'mixed', '--launch', '--print', '--json'], testIo)).toBe(2);
    expect(err.join('')).toContain('mixed platform hints');
  });

  it('threads every launch flag through and plans an enabled worktree', async () => {
    const cwd = demoWorkspace();
    const { io: testIo, out } = io(cwd, { env: { XDG_DATA_HOME: '/data', HOME: '/home/u' } });
    const code = await run(
      [
        'team',
        'dev',
        '--launch',
        '--print',
        '--json',
        '--workers',
        '3',
        '--task-file',
        join(cwd, '.crew', 'run-task.md'),
        '--no-relay',
        '--no-attach',
        '--worktree',
        'feature/x',
      ],
      testIo,
    );
    expect(code).toBe(0);
    const plan = JSON.parse(out.join('')) as {
      roster: { role: string }[];
      worktree: { enabled: boolean; branch: string; path: string };
      relay: { enabled: boolean; attach: boolean };
      task_brief: { present: boolean; target_role: string };
    };
    expect(plan.roster.filter((r) => r.role === 'worker')).toHaveLength(3);
    expect(plan.worktree).toMatchObject({ enabled: true, branch: 'feature/x' });
    expect(plan.worktree.path).toMatch(
      /^\/data\/crew\/worktrees\/[0-9a-f]{12}\/feature-x-[0-9a-f]{8}$/,
    );
    expect(plan.relay).toMatchObject({ enabled: false, attach: false });
    expect(plan.task_brief).toEqual({ present: true, target_role: 'manager' });
  });

  it('human summary renders an enabled worktree, absent brief, and empty config', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'crew-launch-'));
    made.push(cwd);
    initWorkspace(captureIo({ cwd }).io, { withGuides: false, json: false });
    writeFileSync(join(cwd, '.crew', 'launcher.yaml'), 'version: 1\n');
    const { io: testIo, out } = io(cwd, { env: { XDG_DATA_HOME: '/data', HOME: '/home/u' } });
    expect(
      await run(['team', 'dev', '--launch', '--print', '--worktree', 'feature/x'], testIo),
    ).toBe(0);
    const text = out.join('');
    expect(text).toMatch(
      /Worktree: \/data\/crew\/worktrees\/[0-9a-f]{12}\/feature-x-[0-9a-f]{8} branch=feature\/x base=HEAD/,
    );
    expect(text).toContain('Task brief: none');
    expect(text).toContain('Client: claude-code (claude) [source: default]');
    expect(text).toContain('(none)');
  });

  it('makes zero process, file-write, or tmux calls under --print', async () => {
    const cwd = demoWorkspace();
    const { io: testIo, out } = io(cwd, {
      runProcess: () => {
        throw new Error('runProcess must not be called under --print');
      },
    });
    expect(await run(['team', 'dev', '--launch', '--print', '--json'], testIo)).toBe(0);
    expect(out.join('')).toBe(FIXTURE);
    // --print writes nothing: the (init-created) generated dir stays empty and no
    // session subtree or launcher.yaml mutation appears.
    const generated = join(cwd, '.crew', 'generated');
    expect(existsSync(generated) ? readdirSync(generated) : []).toEqual([]);
  });

  it('rejects an oversized --task-file (256 KiB cap) with INVALID_CONFIG', async () => {
    const cwd = demoWorkspace();
    const big = join(cwd, 'big-brief.md');
    writeFileSync(big, 'x'.repeat(256 * 1024 + 1));
    const { io: testIo, err } = io(cwd);
    expect(
      await run(['team', 'dev', '--launch', '--print', '--json', '--task-file', big], testIo),
    ).toBe(2);
    expect(err.join('')).toContain('"code":"INVALID_CONFIG"');
  });

  it('rejects a non-UTF-8 --task-file with INVALID_CONFIG', async () => {
    const cwd = demoWorkspace();
    const bad = join(cwd, 'bad-brief.md');
    writeFileSync(bad, Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    const { io: testIo, err } = io(cwd);
    expect(
      await run(['team', 'dev', '--launch', '--print', '--json', '--task-file', bad], testIo),
    ).toBe(2);
    expect(err.join('')).toContain('"code":"INVALID_CONFIG"');
  });

  it('reads a --task-file from outside the workspace without serializing its path (Q7)', async () => {
    const cwd = demoWorkspace();
    const outside = mkdtempSync(join(tmpdir(), 'crew-brief-'));
    made.push(outside);
    const brief = join(outside, 'external.md');
    writeFileSync(brief, '# External\n\nLine two.\n');
    const { io: testIo, out } = io(cwd);
    expect(
      await run(['team', 'dev', '--launch', '--print', '--json', '--task-file', brief], testIo),
    ).toBe(0);
    const plan = JSON.parse(out.join('')) as {
      task_brief: { present: boolean; target_role: string };
    };
    expect(plan.task_brief).toEqual({ present: true, target_role: 'manager' });
  });

  it('renders the resolved path for a relative explicit --task-file in human --print output', async () => {
    const cwd = demoWorkspace();
    const relativeDir = join(cwd, 'briefs');
    const relative = join('briefs', 'relative.md');
    const resolved = join(cwd, relative);
    mkdirSync(relativeDir);
    writeFileSync(resolved, '# Relative\n\nLine two.\n');
    const { io: testIo, out } = io(cwd);
    expect(await run(['team', 'dev', '--launch', '--print', '--task-file', relative], testIo)).toBe(
      0,
    );
    expect(out.join('')).toContain(`Task brief: ${resolved} (3 lines)`);
  });

  it('surfaces a killed tmux probe as a generic ERROR instead of DEPENDENCY_MISSING', async () => {
    const cwd = demoWorkspace();
    const { io: testIo, err } = io(cwd, {
      runProcess: () =>
        Promise.resolve({
          status: null,
          stdout: '',
          stderr: '',
          killed: true,
          signal: 'SIGTERM',
        }),
    });
    expect(await run(['team', 'dev', '--launch'], testIo)).toBe(1);
    expect(err.join('')).toContain('[ERROR]');
    expect(err.join('')).toContain('the tmux availability probe (tmux -V) did not exit cleanly');
    expect(err.join('')).not.toContain(
      'tmux is required for an automatic launch but was not found',
    );
  });

  it('builds the plan when --print is given without --launch (implies --launch)', async () => {
    const cwd = demoWorkspace();
    const { io: testIo, out } = io(cwd);
    expect(await run(['team', 'dev', '--print', '--json'], testIo)).toBe(0);
    const text = out.join('');
    expect(text).toContain('"schema_version": 1');
    expect(text).toContain('"team": "dev"');
  });

  it('rejects --worktree combined with --no-worktree as a USAGE conflict', async () => {
    const cwd = demoWorkspace();
    const { io: testIo, err } = io(cwd);
    expect(
      await run(
        ['team', 'dev', '--launch', '--print', '--worktree', 'feature/x', '--no-worktree'],
        testIo,
      ),
    ).toBe(2);
    expect(err.join('')).toContain('[USAGE]');
    expect(err.join('')).toContain('--no-worktree');
  });

  it('rejects an option-injecting / malformed --worktree branch', async () => {
    const cwd = demoWorkspace();
    for (const bad of ['--upload-pack=evil', 'bad..name']) {
      const { io: testIo, err } = io(cwd);
      expect(await run(['team', 'dev', '--launch', '--print', '--worktree', bad], testIo)).toBe(2);
      expect(err.join('')).toContain('[INVALID_CONFIG]');
    }
  });
});

describe('launch_result output (both contracts)', () => {
  const result = { sessionName: 'crew-demo', panes: 4, relay: true, attached: false } as const;

  it('emits the launch_result NDJSON envelope under --json', () => {
    const { io: testIo, out } = captureIo({});
    renderLaunchResult(testIo, result, true);
    expect(JSON.parse(out.join(''))).toEqual({
      type: 'launch_result',
      schema_version: 1,
      session_name: 'crew-demo',
      panes: 4,
      relay: true,
      attached: false,
    });
  });

  it('renders a human summary, adding the attach hint only when not attached', () => {
    const detached = captureIo({});
    renderLaunchResult(detached.io, result, false);
    expect(detached.out.join('')).toContain('Launched session crew-demo (4 panes, relay on).');
    expect(detached.out.join('')).toContain('Attach with: tmux attach -t crew-demo');

    const attached = captureIo({});
    renderLaunchResult(attached.io, { ...result, attached: true }, false);
    expect(attached.out.join('')).not.toContain('Attach with:');
  });
});
