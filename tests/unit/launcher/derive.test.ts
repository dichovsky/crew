import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  branchSlug,
  deriveSessionName,
  managedWorktreeBase,
  repoHash,
  worktreePath,
} from '../../../src/launcher/derive.js';
import { CrewError } from '../../../src/errors.js';

describe('deriveSessionName', () => {
  it('prefers session_name, then project name, then the workspace dir', () => {
    expect(deriveSessionName('crew-demo', 'ignored', 'dir')).toBe('crew-demo');
    expect(deriveSessionName(null, 'My Project', 'dir')).toBe('my-project');
    expect(deriveSessionName(null, null, 'My Repo')).toBe('my-repo');
  });

  it('lower-cases and keeps underscores', () => {
    expect(deriveSessionName('My_Session', null, 'd')).toBe('my_session');
  });

  it('collapses disallowed runs, trims, and truncates to 80', () => {
    expect(deriveSessionName('  a  b  ', null, 'd')).toBe('a-b');
    expect(deriveSessionName('a'.repeat(100), null, 'd')).toHaveLength(80);
  });

  it('falls back to crew when empty', () => {
    expect(deriveSessionName('!!!', null, '!!!')).toBe('crew');
  });
});

describe('branchSlug', () => {
  it('collapses slashes and disallowed characters to a single dash', () => {
    expect(branchSlug('crew/demo')).toBe('crew-demo');
    expect(branchSlug('Feature/My_Branch')).toBe('feature-my-branch');
    expect(branchSlug('a//b')).toBe('a-b');
  });

  it('trims leading and trailing dashes', () => {
    expect(branchSlug('/foo/')).toBe('foo');
    expect(branchSlug('café')).toBe('caf');
  });

  it('falls back to crew when empty and truncates to 64', () => {
    expect(branchSlug('')).toBe('crew');
    expect(branchSlug('###')).toBe('crew');
    expect(branchSlug('a'.repeat(100))).toHaveLength(64);
  });
});

describe('repoHash', () => {
  it('is the first 12 lower-hex chars of the SHA-256 of the path', () => {
    const path = '/canonical/repo/root';
    const expected = createHash('sha256').update(path, 'utf8').digest('hex').slice(0, 12);
    expect(repoHash(path)).toBe(expected);
    expect(repoHash(path)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is deterministic and path-sensitive', () => {
    expect(repoHash('/a')).toBe(repoHash('/a'));
    expect(repoHash('/a')).not.toBe(repoHash('/b'));
  });
});

describe('managedWorktreeBase', () => {
  it('honors XDG_DATA_HOME when set', () => {
    expect(managedWorktreeBase({ XDG_DATA_HOME: '/data' })).toBe('/data/crew/worktrees');
  });

  it('falls back to ~/.local/share', () => {
    expect(managedWorktreeBase({ HOME: '/home/u' })).toBe('/home/u/.local/share/crew/worktrees');
  });

  it('ignores a relative XDG_DATA_HOME per the XDG specification', () => {
    expect(managedWorktreeBase({ XDG_DATA_HOME: 'relative-data', HOME: '/home/u' })).toBe(
      '/home/u/.local/share/crew/worktrees',
    );
  });

  it('falls back to USERPROFILE when HOME is unset (Windows)', () => {
    expect(managedWorktreeBase({ USERPROFILE: '/users/u' })).toBe(
      '/users/u/.local/share/crew/worktrees',
    );
  });

  it('throws when neither XDG_DATA_HOME, HOME, nor USERPROFILE is set', () => {
    try {
      managedWorktreeBase({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CrewError);
    }
  });
});

describe('worktreePath', () => {
  const refHash = (b: string): string =>
    createHash('sha256').update(b, 'utf8').digest('hex').slice(0, 8);

  it('joins base/<repo-hash>/<branch-slug>-<ref-hash>', () => {
    const env = { XDG_DATA_HOME: '/data' };
    const root = '/repo';
    expect(worktreePath(env, root, 'crew/demo')).toBe(
      `/data/crew/worktrees/${repoHash(root)}/crew-demo-${refHash('crew/demo')}`,
    );
  });

  it('places branches that slugify identically at DISTINCT paths (configuration.md)', () => {
    // The readable slug collides (both -> feature-x); the appended ref-hash of the
    // full branch keeps distinct refs at distinct worktree paths.
    const env = { XDG_DATA_HOME: '/data' };
    const a = worktreePath(env, '/repo', 'Feature/X');
    const b = worktreePath(env, '/repo', 'feature-x');
    expect(a).not.toBe(b);
    expect(a).toMatch(/\/feature-x-[0-9a-f]{8}$/);
    expect(b).toMatch(/\/feature-x-[0-9a-f]{8}$/);
  });
});
