import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isExecutableOnPath, resolveExecutableOnPath } from '../../src/which.js';

const root = mkdtempSync(join(tmpdir(), 'crew-which-'));

afterAll(() => {
  // best-effort; the OS temp dir is reclaimed regardless
});

describe('isExecutableOnPath', () => {
  it('finds an executable regular file on the injected PATH', () => {
    const dir = join(root, 'bin');
    mkdirSync(dir, { recursive: true });
    const exe = join(dir, 'crewtool');
    writeFileSync(exe, '#!/bin/sh\necho hi\n');
    chmodSync(exe, 0o755);
    expect(isExecutableOnPath({ PATH: dir }, 'crewtool')).toBe(true);
  });

  it('returns false when PATH is empty or unset', () => {
    expect(isExecutableOnPath({ PATH: '' }, 'crewtool')).toBe(false);
    expect(isExecutableOnPath({}, 'crewtool')).toBe(false);
  });

  it('does not treat an executable directory as a command', () => {
    const dir = join(root, 'bin2');
    mkdirSync(join(dir, 'notacmd'), { recursive: true });
    chmodSync(join(dir, 'notacmd'), 0o755);
    expect(isExecutableOnPath({ PATH: dir }, 'notacmd')).toBe(false);
  });

  it('follows a symlink to a real executable', () => {
    const realDir = join(root, 'real');
    const linkDir = join(root, 'linked');
    mkdirSync(realDir, { recursive: true });
    mkdirSync(linkDir, { recursive: true });
    const realExe = join(realDir, 'target');
    writeFileSync(realExe, '#!/bin/sh\n');
    chmodSync(realExe, 0o755);
    symlinkSync(realExe, join(linkDir, 'linkcmd'));
    expect(isExecutableOnPath({ PATH: linkDir }, 'linkcmd')).toBe(true);
  });

  it('scans every PATH entry', () => {
    const a = join(root, 'a');
    const b = join(root, 'b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const exe = join(b, 'second');
    writeFileSync(exe, '#!/bin/sh\n');
    chmodSync(exe, 0o755);
    expect(isExecutableOnPath({ PATH: [a, b].join(delimiter) }, 'second')).toBe(true);
  });
});

describe('resolveExecutableOnPath', () => {
  /** Create a PATH dir under `root` holding an executable named `name`. */
  function binDir(sub: string, name: string): { dir: string; exe: string } {
    const dir = join(root, sub);
    mkdirSync(dir, { recursive: true });
    const exe = join(dir, name);
    writeFileSync(exe, '#!/bin/sh\n');
    chmodSync(exe, 0o755);
    return { dir, exe };
  }

  it('returns the absolute path of the first matching executable', () => {
    const { dir, exe } = binDir('resolve-bin', 'crewres');
    expect(resolveExecutableOnPath({ PATH: dir }, 'crewres')).toBe(exe);
  });

  it('returns null when nothing matches', () => {
    expect(resolveExecutableOnPath({ PATH: join(root, 'resolve-bin') }, 'missing')).toBeNull();
    expect(resolveExecutableOnPath({}, 'missing')).toBeNull();
  });

  it('[security] never resolves through the CWD: empty, ".", and relative PATH elements are skipped', () => {
    const { dir, exe } = binDir('resolve-real', 'crewhijack');
    // A same-named executable planted at the process CWD (an untrusted repo root).
    const cwdTrap = mkdtempSync(join(tmpdir(), 'crew-cwdtrap-'));
    const planted = join(cwdTrap, 'crewhijack');
    writeFileSync(planted, '#!/bin/sh\necho HIJACKED\n');
    chmodSync(planted, 0o755);
    const previousCwd = process.cwd();
    process.chdir(cwdTrap);
    try {
      // execvp would treat the empty and `.` elements as the CWD; crew must not.
      for (const pathVar of [
        `${delimiter}${dir}`, // leading empty element
        `${dir}${delimiter}`, // trailing empty element
        ['.', dir].join(delimiter), // explicit `.`
        ['relative/bin', dir].join(delimiter), // relative element
      ]) {
        expect(resolveExecutableOnPath({ PATH: pathVar }, 'crewhijack')).toBe(exe);
      }
      // Only CWD-resolving elements: the planted binary is never validated.
      expect(resolveExecutableOnPath({ PATH: `${delimiter}.` }, 'crewhijack')).toBeNull();
      expect(isExecutableOnPath({ PATH: `${delimiter}.` }, 'crewhijack')).toBe(false);
    } finally {
      process.chdir(previousCwd);
    }
  });
});
