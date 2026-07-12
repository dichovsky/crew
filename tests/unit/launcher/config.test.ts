import { describe, expect, it } from 'vitest';
import {
  mergeEffectiveConfig,
  parseLauncherConfig,
  type LauncherFile,
} from '../../../src/launcher/config.js';
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

const FULL = `version: 1
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

describe('parseLauncherConfig', () => {
  it('parses the configuration.md example with all fields', () => {
    const cfg = parseLauncherConfig(FULL, 'launcher.yaml');
    expect(cfg.project.sessionName).toBe('crew-demo');
    expect(cfg.runtime.client).toBe('codex-cli');
    expect(cfg.worktree).toEqual({ enabled: false, branch: 'crew/demo', baseRef: 'HEAD' });
    expect(cfg.relay).toEqual({ enabled: true, pollSeconds: 2, reminderSeconds: 30 });
    expect(cfg.focus).toEqual({ files: ['src/'], docs: ['docs/design/architecture.md'] });
    expect(cfg.constraints).toEqual(['Do not modify generated files.']);
  });

  it('accepts a bare version-only document with defaults', () => {
    const cfg = parseLauncherConfig('version: 1\n', 'launcher.yaml');
    expect(cfg.runtime.client).toBeNull();
    expect(cfg.worktree).toEqual({ enabled: false, branch: null, baseRef: 'HEAD' });
    expect(cfg.relay).toEqual({ enabled: true, pollSeconds: 2, reminderSeconds: 30 });
    expect(cfg.focus).toEqual({ files: [], docs: [] });
    expect(cfg.constraints).toEqual([]);
  });

  it('rejects a missing or wrong version', () => {
    expectCode(() => parseLauncherConfig('project:\n  name: x\n', 'l'), 'INVALID_CONFIG');
    expectCode(() => parseLauncherConfig('version: 2\n', 'l'), 'INVALID_CONFIG');
  });

  it('rejects unknown top-level keys', () => {
    expectCode(() => parseLauncherConfig('version: 1\nbogus: 1\n', 'l'), 'INVALID_CONFIG');
  });

  it('rejects unknown nested keys', () => {
    expectCode(() => parseLauncherConfig('version: 1\nrelay:\n  nope: 1\n', 'l'), 'INVALID_CONFIG');
  });

  it('rejects a forbidden executable field (security.md)', () => {
    expectCode(
      () => parseLauncherConfig('version: 1\nruntime:\n  executable: /bin/sh\n', 'l'),
      'INVALID_CONFIG',
    );
  });

  it('rejects a forbidden worktree filesystem-location field', () => {
    expectCode(
      () => parseLauncherConfig('version: 1\nworkspace:\n  worktree:\n    path: /tmp/evil\n', 'l'),
      'INVALID_CONFIG',
    );
  });

  it('rejects an unknown runtime.client id', () => {
    expectCode(
      () => parseLauncherConfig('version: 1\nruntime:\n  client: emacs\n', 'l'),
      'INVALID_CONFIG',
    );
  });

  it('rejects an option-injecting or malformed worktree branch (ref syntax)', () => {
    for (const branch of ['--upload-pack=evil', 'bad..name', 'a b']) {
      expectCode(
        () =>
          parseLauncherConfig(
            `version: 1\nworkspace:\n  worktree:\n    branch: "${branch}"\n`,
            'l',
          ),
        'INVALID_CONFIG',
      );
    }
  });

  it('rejects an option-injecting worktree base_ref', () => {
    expectCode(
      () =>
        parseLauncherConfig(
          'version: 1\nworkspace:\n  worktree:\n    base_ref: "--output=/tmp/x"\n',
          'l',
        ),
      'INVALID_CONFIG',
    );
  });

  it('rejects a Windows drive-letter absolute focus path', () => {
    expectCode(
      () => parseLauncherConfig('version: 1\nfocus:\n  files:\n    - C:\\secrets\n', 'l'),
      'INVALID_CONFIG',
    );
  });

  it('rejects an out-of-range poll_seconds', () => {
    expectCode(
      () => parseLauncherConfig('version: 1\nrelay:\n  poll_seconds: 61\n', 'l'),
      'INVALID_CONFIG',
    );
  });

  it('rejects reminder_seconds below the poll interval', () => {
    expectCode(
      () =>
        parseLauncherConfig(
          'version: 1\nrelay:\n  poll_seconds: 40\n  reminder_seconds: 30\n',
          'l',
        ),
      'INVALID_CONFIG',
    );
  });

  it('rejects a focus path that escapes the workspace', () => {
    expectCode(
      () => parseLauncherConfig('version: 1\nfocus:\n  files:\n    - ../secret\n', 'l'),
      'INVALID_CONFIG',
    );
    expectCode(
      () => parseLauncherConfig('version: 1\nfocus:\n  files:\n    - /etc/passwd\n', 'l'),
      'INVALID_CONFIG',
    );
  });

  it('rejects an over-long constraint', () => {
    const long = 'x'.repeat(2001);
    expectCode(
      () => parseLauncherConfig(`version: 1\nconstraints:\n  - ${long}\n`, 'l'),
      'INVALID_CONFIG',
    );
  });

  it('rejects an invalid session_name', () => {
    expectCode(
      () => parseLauncherConfig('version: 1\nproject:\n  session_name: "bad name"\n', 'l'),
      'INVALID_CONFIG',
    );
  });
});

const DEFAULT_FILE = parseLauncherConfig('version: 1\n', 'l');

describe('mergeEffectiveConfig', () => {
  function file(overrides: Partial<LauncherFile> = {}): LauncherFile {
    return { ...DEFAULT_FILE, ...overrides };
  }

  it('defaults the client to claude-code with default provenance', () => {
    const eff = mergeEffectiveConfig(DEFAULT_FILE, {});
    expect(eff.client).toBe('claude-code');
    expect(eff.clientSource).toBe('default');
  });

  it('takes runtime.client with config provenance', () => {
    const eff = mergeEffectiveConfig(file({ runtime: { client: 'codex-cli' } }), {});
    expect(eff.client).toBe('codex-cli');
    expect(eff.clientSource).toBe('config');
  });

  it('lets --client win over runtime.client with flag provenance', () => {
    const eff = mergeEffectiveConfig(file({ runtime: { client: 'codex-cli' } }), {
      client: 'gemini-cli',
    });
    expect(eff.client).toBe('gemini-cli');
    expect(eff.clientSource).toBe('flag');
  });

  it('rejects an invalid --client with USAGE', () => {
    expectCode(() => mergeEffectiveConfig(DEFAULT_FILE, { client: 'emacs' }), 'USAGE');
  });

  it('rejects --workers outside 1-32 with USAGE', () => {
    expectCode(() => mergeEffectiveConfig(DEFAULT_FILE, { workers: '0' }), 'USAGE');
    expectCode(() => mergeEffectiveConfig(DEFAULT_FILE, { workers: '33' }), 'USAGE');
    expectCode(() => mergeEffectiveConfig(DEFAULT_FILE, { workers: 'x' }), 'USAGE');
  });

  it('parses a valid --workers', () => {
    expect(mergeEffectiveConfig(DEFAULT_FILE, { workers: '4' }).workers).toBe(4);
  });

  it('rejects an empty --task-file with USAGE', () => {
    expectCode(() => mergeEffectiveConfig(DEFAULT_FILE, { taskFile: '' }), 'USAGE');
  });

  it('enables the worktree from --worktree <branch>', () => {
    const eff = mergeEffectiveConfig(DEFAULT_FILE, { worktree: 'feature/x' });
    expect(eff.worktree).toMatchObject({ enabled: true, branch: 'feature/x' });
  });

  it('lets --no-worktree disable a config-enabled worktree', () => {
    const eff = mergeEffectiveConfig(
      file({ worktree: { enabled: true, branch: 'crew/demo', baseRef: 'HEAD' } }),
      { worktree: false },
    );
    expect(eff.worktree.enabled).toBe(false);
  });

  it('reflects --no-relay and --no-attach', () => {
    const eff = mergeEffectiveConfig(DEFAULT_FILE, { noRelay: true, noAttach: true });
    expect(eff.relay.enabled).toBe(false);
    expect(eff.relay.attach).toBe(false);
  });

  it('defaults relay enabled and attached', () => {
    const eff = mergeEffectiveConfig(DEFAULT_FILE, {});
    expect(eff.relay).toMatchObject({ enabled: true, attach: true });
  });
});
