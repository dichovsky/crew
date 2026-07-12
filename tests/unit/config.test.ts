import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspaceConfig, parseWorkspaceConfig } from '../../src/config.js';
import { CrewError } from '../../src/errors.js';

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`should have thrown ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(CrewError);
    expect((err as CrewError).code).toBe(code);
  }
}

describe('parseWorkspaceConfig', () => {
  it('accepts a bare version-only document with defaults (worktrees disabled, HEAD base ref)', () => {
    const cfg = parseWorkspaceConfig('version: 1\n', 'config.yaml');
    expect(cfg.workerWorktrees).toEqual({ enabled: false, baseRef: 'HEAD' });
  });

  it('parses worker_worktrees.enabled and base_ref when both are set', () => {
    const cfg = parseWorkspaceConfig(
      'version: 1\nworker_worktrees:\n  enabled: true\n  base_ref: main\n',
      'config.yaml',
    );
    expect(cfg.workerWorktrees).toEqual({ enabled: true, baseRef: 'main' });
  });

  it('defaults base_ref to HEAD when only enabled is set', () => {
    const cfg = parseWorkspaceConfig(
      'version: 1\nworker_worktrees:\n  enabled: true\n',
      'config.yaml',
    );
    expect(cfg.workerWorktrees).toEqual({ enabled: true, baseRef: 'HEAD' });
  });

  it('defaults enabled to false when only base_ref is set', () => {
    const cfg = parseWorkspaceConfig(
      'version: 1\nworker_worktrees:\n  base_ref: develop\n',
      'config.yaml',
    );
    expect(cfg.workerWorktrees).toEqual({ enabled: false, baseRef: 'develop' });
  });

  it('rejects a missing or wrong version', () => {
    expectCode(
      () => parseWorkspaceConfig('worker_worktrees:\n  enabled: true\n', 'c'),
      'INVALID_CONFIG',
    );
    expectCode(() => parseWorkspaceConfig('version: 2\n', 'c'), 'INVALID_CONFIG');
  });

  it('rejects unknown top-level keys', () => {
    expectCode(() => parseWorkspaceConfig('version: 1\nbogus: 1\n', 'c'), 'INVALID_CONFIG');
  });

  it('rejects unknown worker_worktrees keys', () => {
    expectCode(
      () => parseWorkspaceConfig('version: 1\nworker_worktrees:\n  nope: 1\n', 'c'),
      'INVALID_CONFIG',
    );
  });

  it('rejects a non-boolean enabled and a non-string base_ref', () => {
    expectCode(
      () => parseWorkspaceConfig('version: 1\nworker_worktrees:\n  enabled: yes-please\n', 'c'),
      'INVALID_CONFIG',
    );
    expectCode(
      () => parseWorkspaceConfig('version: 1\nworker_worktrees:\n  base_ref: 1\n', 'c'),
      'INVALID_CONFIG',
    );
  });

  it('rejects a worker_worktrees value that is not a mapping', () => {
    expectCode(
      () => parseWorkspaceConfig('version: 1\nworker_worktrees: true\n', 'c'),
      'INVALID_CONFIG',
    );
  });

  it('rejects an option-injecting, revision-only, or malformed base_ref (branch syntax)', () => {
    for (const baseRef of ['--upload-pack=evil', 'bad..name', 'a b', 'main~1', 'x.lock']) {
      expectCode(
        () =>
          parseWorkspaceConfig(`version: 1\nworker_worktrees:\n  base_ref: "${baseRef}"\n`, 'c'),
        'INVALID_CONFIG',
      );
    }
  });

  it('rejects malformed YAML and an oversized document', () => {
    expectCode(() => parseWorkspaceConfig('version: 1\n  bad indent: [\n', 'c'), 'INVALID_CONFIG');
    expectCode(() => parseWorkspaceConfig('x'.repeat(300_000), 'c'), 'INVALID_CONFIG');
  });
});

describe('loadWorkspaceConfig', () => {
  const made: string[] = [];

  afterEach(() => {
    while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
  });

  function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), 'crew-config-'));
    made.push(dir);
    mkdirSync(join(dir, '.crew'), { recursive: true });
    return dir;
  }

  it('returns defaults when .crew/config.yaml is absent', () => {
    const root = workspace();
    expect(loadWorkspaceConfig(root)).toEqual({
      workerWorktrees: { enabled: false, baseRef: 'HEAD' },
    });
  });

  it('loads worker_worktrees settings from an existing .crew/config.yaml', () => {
    const root = workspace();
    writeFileSync(
      join(root, '.crew', 'config.yaml'),
      'version: 1\nworker_worktrees:\n  enabled: true\n  base_ref: main\n',
    );
    expect(loadWorkspaceConfig(root)).toEqual({
      workerWorktrees: { enabled: true, baseRef: 'main' },
    });
  });

  it('surfaces INVALID_CONFIG for a malformed .crew/config.yaml', () => {
    const root = workspace();
    writeFileSync(join(root, '.crew', 'config.yaml'), 'version: 1\nbogus: true\n');
    expectCode(() => loadWorkspaceConfig(root), 'INVALID_CONFIG');
  });
});
