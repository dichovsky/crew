import { describe, expect, it } from 'vitest';
import { assertValidBranch, assertValidRevision } from '../../../src/launcher/ref.js';
import { CrewError } from '../../../src/errors.js';

function reason(fn: () => void): string {
  try {
    fn();
    return 'ok';
  } catch (err) {
    expect(err).toBeInstanceOf(CrewError);
    expect((err as CrewError).code).toBe('INVALID_CONFIG');
    return (err as CrewError).message;
  }
}

const WITH_CONTROL = `a${String.fromCharCode(1)}b`;

describe('assertValidBranch', () => {
  it('accepts ordinary branch names', () => {
    for (const ok of ['main', 'feature/x', 'crew/demo', 'release-1.2', 'a/b/c']) {
      expect(reason(() => assertValidBranch(ok, 'b'))).toBe('ok');
    }
  });

  it('rejects option-injecting names (leading dash)', () => {
    expect(reason(() => assertValidBranch('--upload-pack=evil', 'b'))).toContain(
      'option injection',
    );
    expect(reason(() => assertValidBranch('-x', 'b'))).toContain('option injection');
  });

  it('rejects malformed git ref syntax', () => {
    const bad = [
      'bad..name',
      'a b',
      'x.lock',
      'foo/',
      '/foo',
      'a^b',
      'a:b',
      'a~b',
      'a?b',
      '@',
      'a//b',
      'a@{0}',
      'end.',
      '.foo',
      'foo/.bar',
      'foo/./bar',
      'foo.lock/bar',
    ];
    for (const name of bad) {
      expect(reason(() => assertValidBranch(name, 'b'))).not.toBe('ok');
    }
  });

  it('rejects control characters and empty', () => {
    expect(reason(() => assertValidBranch(WITH_CONTROL, 'b'))).toContain('control');
    expect(reason(() => assertValidBranch('', 'b'))).toContain('empty');
  });
});

describe('assertValidRevision', () => {
  it('accepts revisions, tags, SHAs, and HEAD', () => {
    for (const ok of ['HEAD', 'main', 'origin/main', 'v1.2.0', 'deadbeef']) {
      expect(reason(() => assertValidRevision(ok, 'r'))).toBe('ok');
    }
  });

  it('rejects option-looking, range, and reflog forms', () => {
    expect(reason(() => assertValidRevision('--foo', 'r'))).toContain('option injection');
    expect(reason(() => assertValidRevision('a..b', 'r'))).not.toBe('ok');
    expect(reason(() => assertValidRevision('HEAD@{1}', 'r'))).not.toBe('ok');
  });
});
