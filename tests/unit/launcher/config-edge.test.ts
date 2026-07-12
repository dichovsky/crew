import { describe, expect, it } from 'vitest';
import { mergeEffectiveConfig, parseLauncherConfig } from '../../../src/launcher/config.js';
import { CrewError } from '../../../src/errors.js';

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable(`should have thrown ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(CrewError);
    expect((err as CrewError).code).toBe(code);
  }
}

const DEFAULT_FILE = parseLauncherConfig('version: 1\n', 'l');

describe('parseLauncherConfig — uncovered validation branches', () => {
  it('rejects a section value that is not a mapping', () => {
    // null (empty value), scalar, and array all fail the mapping() guard.
    for (const src of [
      'version: 1\nproject:\n',
      'version: 1\nruntime: hi\n',
      'version: 1\nrelay:\n  - 1\n',
    ]) {
      expectCode(() => parseLauncherConfig(src, 'l'), 'INVALID_CONFIG');
    }
  });

  it('rejects a non-string value for a string field', () => {
    expectCode(
      () => parseLauncherConfig('version: 1\nproject:\n  name: 123\n', 'l'),
      'INVALID_CONFIG',
    );
  });

  it('rejects a non-boolean value for a boolean field', () => {
    expectCode(
      () => parseLauncherConfig('version: 1\nrelay:\n  enabled: 5\n', 'l'),
      'INVALID_CONFIG',
    );
  });

  it('defaults omitted relay integers when the relay section is present', () => {
    const cfg = parseLauncherConfig('version: 1\nrelay:\n  enabled: true\n', 'l');
    expect(cfg.relay).toEqual({ enabled: true, pollSeconds: 2, reminderSeconds: 30 });
  });

  it('rejects a non-sequence value for a list field', () => {
    expectCode(() => parseLauncherConfig('version: 1\nconstraints: nope\n', 'l'), 'INVALID_CONFIG');
  });

  it('rejects a list that exceeds the maximum entry count', () => {
    const src = `version: 1\nconstraints:\n${Array.from(
      { length: 101 },
      (_, i) => `  - c${i}`,
    ).join('\n')}\n`;
    expectCode(() => parseLauncherConfig(src, 'l'), 'INVALID_CONFIG');
  });

  it('rejects a non-string entry within a list field', () => {
    expectCode(
      () => parseLauncherConfig('version: 1\nconstraints:\n  - 5\n', 'l'),
      'INVALID_CONFIG',
    );
  });

  it('rejects an over-long project name', () => {
    const name = 'x'.repeat(81);
    expectCode(
      () => parseLauncherConfig(`version: 1\nproject:\n  name: ${name}\n`, 'l'),
      'INVALID_CONFIG',
    );
  });

  it('defaults the worktree when workspace is present but worktree is omitted', () => {
    const cfg = parseLauncherConfig('version: 1\nworkspace: {}\n', 'l');
    expect(cfg.worktree).toEqual({ enabled: false, branch: null, baseRef: 'HEAD' });
  });
});

describe('mergeEffectiveConfig — uncovered flag branches', () => {
  it('rejects an empty --worktree branch with USAGE', () => {
    expectCode(() => mergeEffectiveConfig(DEFAULT_FILE, { worktree: '' }), 'USAGE');
  });
});
