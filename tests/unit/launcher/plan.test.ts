import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../../src/init.js';
import { buildLaunchPlan } from '../../../src/launcher/plan.js';
import { mergeEffectiveConfig, parseLauncherConfig } from '../../../src/launcher/config.js';
import { CrewError } from '../../../src/errors.js';
import { captureIo } from '../../helpers/io.js';
import type { Io } from '../../../src/io.js';

const made: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-plan-'));
  made.push(dir);
  initWorkspace(captureIo({ cwd: dir }).io, { withGuides: false, json: false });
  return dir;
}

function io(cwd: string, env: NodeJS.ProcessEnv = { HOME: '/home/u' }): Io {
  return captureIo({ cwd, env }).io;
}

const DEFAULT_CONFIG = mergeEffectiveConfig(parseLauncherConfig('version: 1\n', 'l'), {});

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
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('buildLaunchPlan', () => {
  it('assembles the dev roster, default client, and disabled worktree', () => {
    const cwd = workspace();
    const { plan } = buildLaunchPlan(io(cwd), 'dev', DEFAULT_CONFIG);
    expect(plan.team).toBe('dev');
    expect(plan.client).toBe('claude-code');
    expect(plan.executable).toBe('claude');
    expect(plan.roster.map((r) => r.agent_id)).toEqual([
      'manager',
      'worker',
      'worker-2',
      'inspector',
    ]);
    expect(plan.worktree).toEqual({ enabled: false, path: null, branch: null, base_ref: 'HEAD' });
    expect(plan.artifacts).toEqual([
      'pane-map.json',
      'manager-prompt.md',
      'inspector-prompt.md',
      'run-summary.md',
    ]);
  });

  it('uses the operation clock for created_at', () => {
    const cwd = workspace();
    const clockIo = captureIo({ cwd, env: { HOME: '/home/u' }, clock: () => 12345 }).io;
    expect(buildLaunchPlan(clockIo, 'dev', DEFAULT_CONFIG).plan.created_at).toBe(12345);
  });

  it('overrides the worker replica count with --workers', () => {
    const cwd = workspace();
    const config = mergeEffectiveConfig(parseLauncherConfig('version: 1\n', 'l'), { workers: '3' });
    const { plan } = buildLaunchPlan(io(cwd), 'dev', config);
    expect(plan.roster.filter((r) => r.role === 'worker').map((r) => r.agent_id)).toEqual([
      'worker',
      'worker-2',
      'worker-3',
    ]);
  });

  it('derives a contained worktree path when enabled', () => {
    const cwd = workspace();
    const config = mergeEffectiveConfig(parseLauncherConfig('version: 1\n', 'l'), {
      worktree: 'feature/x',
    });
    const { plan } = buildLaunchPlan(io(cwd, { XDG_DATA_HOME: '/data' }), 'dev', config);
    expect(plan.worktree.enabled).toBe(true);
    expect(plan.worktree.branch).toBe('feature/x');
    expect(plan.worktree.path).toMatch(
      /^\/data\/crew\/worktrees\/[0-9a-f]{12}\/feature-x-[0-9a-f]{8}$/,
    );
  });

  it('refuses a mixed-platform-hint team with USAGE when no client override is set', () => {
    const cwd = workspace();
    writeFileSync(
      join(cwd, '.crew', 'teams', 'mixed.yaml'),
      'version: 1\nname: mixed\nmembers:\n' +
        '  - id: manager\n    role: manager\n    platform: claude-code\n' +
        '  - id: worker\n    role: worker\n    platform: codex-cli\n',
    );
    expectCode(() => buildLaunchPlan(io(cwd), 'mixed', DEFAULT_CONFIG), 'USAGE');
  });

  it('accepts a mixed-platform-hint team once --client supplies a homogeneous override', () => {
    const cwd = workspace();
    writeFileSync(
      join(cwd, '.crew', 'teams', 'mixed.yaml'),
      'version: 1\nname: mixed\nmembers:\n' +
        '  - id: manager\n    role: manager\n    platform: claude-code\n' +
        '  - id: worker\n    role: worker\n    platform: codex-cli\n',
    );
    const config = mergeEffectiveConfig(parseLauncherConfig('version: 1\n', 'l'), {
      client: 'gemini-cli',
    });
    const { plan } = buildLaunchPlan(io(cwd), 'mixed', config);
    expect(plan.client).toBe('gemini-cli');
  });

  it('plans Little Coder as the homogeneous Participant executable', () => {
    const cwd = workspace();
    const config = mergeEffectiveConfig(parseLauncherConfig('version: 1\n', 'l'), {
      client: 'little-coder',
    });
    const { plan } = buildLaunchPlan(io(cwd), 'dev', config);
    expect(plan.client).toBe('little-coder');
    expect(plan.executable).toBe('little-coder');
  });

  it('marks task_brief present when .crew/run-task.md exists, body excluded', () => {
    const cwd = workspace();
    writeFileSync(join(cwd, '.crew', 'run-task.md'), '# Task\n\nDo the thing.\n');
    const { plan, brief } = buildLaunchPlan(io(cwd), 'dev', DEFAULT_CONFIG);
    expect(plan.task_brief).toEqual({ present: true, target_role: 'manager' });
    expect(brief.lineCount).toBe(3);
    expect(JSON.stringify(plan)).not.toContain('Do the thing');
  });

  it('marks task_brief absent when no brief exists', () => {
    const cwd = workspace();
    const { plan } = buildLaunchPlan(io(cwd), 'dev', DEFAULT_CONFIG);
    expect(plan.task_brief).toEqual({ present: false, target_role: 'manager' });
  });

  it('reads an explicit --task-file anywhere readable without serializing its path', () => {
    const cwd = workspace();
    const outside = mkdtempSync(join(tmpdir(), 'crew-brief-'));
    made.push(outside);
    const briefPath = join(outside, 'brief.md');
    writeFileSync(briefPath, 'one\ntwo\n');
    const config = mergeEffectiveConfig(parseLauncherConfig('version: 1\n', 'l'), {
      taskFile: briefPath,
    });
    const { plan, brief } = buildLaunchPlan(io(cwd), 'dev', config);
    expect(plan.task_brief).toEqual({ present: true, target_role: 'manager' });
    expect(brief.path).toBe(briefPath);
  });

  it('resolves a relative explicit --task-file path for the human summary metadata', () => {
    const cwd = workspace();
    const relative = join('briefs', 'relative.md');
    const resolved = join(cwd, relative);
    mkdirSync(join(cwd, 'briefs'));
    writeFileSync(resolved, 'one\ntwo\n');
    const config = mergeEffectiveConfig(parseLauncherConfig('version: 1\n', 'l'), {
      taskFile: relative,
    });
    const { plan, brief } = buildLaunchPlan(io(cwd), 'dev', config);
    expect(plan.task_brief).toEqual({ present: true, target_role: 'manager' });
    expect(brief.path).toBe(resolved);
  });

  it('reports NOT_FOUND for an unreadable --task-file', () => {
    const cwd = workspace();
    const config = mergeEffectiveConfig(parseLauncherConfig('version: 1\n', 'l'), {
      taskFile: join(cwd, 'does-not-exist.md'),
    });
    expectCode(() => buildLaunchPlan(io(cwd), 'dev', config), 'NOT_FOUND');
  });

  it('names the resolved absolute path in a relative --task-file error message', () => {
    const cwd = workspace();
    const relative = join('briefs', 'missing.md');
    const config = mergeEffectiveConfig(parseLauncherConfig('version: 1\n', 'l'), {
      taskFile: relative,
    });
    expect(() => buildLaunchPlan(io(cwd), 'dev', config)).toThrowError(
      `no readable task brief at "${join(cwd, relative)}"`,
    );
  });

  it('names the resolved path when a relative --task-file is not valid UTF-8', () => {
    const cwd = workspace();
    const relative = join('briefs', 'binary.md');
    mkdirSync(join(cwd, 'briefs'));
    writeFileSync(join(cwd, relative), Buffer.from([0xff, 0xfe, 0xfd]));
    const config = mergeEffectiveConfig(parseLauncherConfig('version: 1\n', 'l'), {
      taskFile: relative,
    });
    expect(() => buildLaunchPlan(io(cwd), 'dev', config)).toThrowError(
      `task brief "${join(cwd, relative)}" is not valid UTF-8`,
    );
  });

  it('rejects a config that enables the worktree without a branch', () => {
    const cwd = workspace();
    const config = mergeEffectiveConfig(
      parseLauncherConfig('version: 1\nworkspace:\n  worktree:\n    enabled: true\n', 'l'),
      {},
    );
    expectCode(() => buildLaunchPlan(io(cwd), 'dev', config), 'INVALID_CONFIG');
  });

  it('rejects a config that enables the worktree with an empty branch (at parse time)', () => {
    // The empty branch is now rejected during launcher.yaml validation (ref syntax),
    // before the plan is assembled.
    expectCode(
      () =>
        parseLauncherConfig(
          'version: 1\nworkspace:\n  worktree:\n    enabled: true\n    branch: ""\n',
          'l',
        ),
      'INVALID_CONFIG',
    );
  });

  it('reports NOT_FOUND when --task-file points at a directory', () => {
    const cwd = workspace();
    const config = mergeEffectiveConfig(parseLauncherConfig('version: 1\n', 'l'), {
      taskFile: join(cwd, '.crew'),
    });
    expectCode(() => buildLaunchPlan(io(cwd), 'dev', config), 'NOT_FOUND');
  });
});
