import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertRealParentWithin,
  assertWithin,
  ensureDir,
  ensureManagedDir,
  readManagedFile,
  resolveManagedTarget,
  writeFileAtomic,
} from '../../src/fs-safe.js';
import { CrewError } from '../../src/errors.js';

const made: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-fs-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  while (made.length) {
    rmSync(made.pop()!, { recursive: true, force: true });
  }
});

function expectUnsafe(fn: () => unknown): void {
  try {
    fn();
    expect.unreachable('should have thrown UNSAFE_PATH');
  } catch (err) {
    expect(err).toBeInstanceOf(CrewError);
    expect((err as CrewError).code).toBe('UNSAFE_PATH');
  }
}

describe('assertWithin', () => {
  it('accepts a path inside the root', () => {
    expect(assertWithin('/repo/.crew', 'roles/manager.md')).toBe('/repo/.crew/roles/manager.md');
  });

  it('rejects parent traversal', () => {
    expectUnsafe(() => assertWithin('/repo/.crew', '../escape'));
    expectUnsafe(() => assertWithin('/repo/.crew', 'roles/../../escape'));
  });

  it('rejects an absolute path outside the root', () => {
    expectUnsafe(() => assertWithin('/repo/.crew', '/etc/passwd'));
  });

  it('rejects the root itself', () => {
    expectUnsafe(() => assertWithin('/repo/.crew', '.'));
  });
});

describe('resolveManagedTarget', () => {
  it('resolves a normal managed path', () => {
    const root = tmp();
    expect(resolveManagedTarget(root, 'roles/manager.md')).toBe(join(root, 'roles', 'manager.md'));
  });

  it('rejects an existing symlink at the target', () => {
    const root = tmp();
    const outside = join(tmp(), 'outside.md');
    writeFileSync(outside, 'x');
    symlinkSync(outside, join(root, 'link.md'));
    expectUnsafe(() => resolveManagedTarget(root, 'link.md'));
  });

  it('rejects a target reached through a symlinked directory that escapes the root', () => {
    const root = tmp();
    const outsideDir = join(tmp(), 'sub');
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(root, 'linkdir'));
    expectUnsafe(() => resolveManagedTarget(root, 'linkdir/file.md'));
  });

  it('rejects traversal', () => {
    const root = tmp();
    expectUnsafe(() => resolveManagedTarget(root, '../escape.md'));
  });

  it('rejects a symlinked component even when it points back inside the root', () => {
    const root = tmp();
    mkdirSync(join(root, 'real'));
    // .crew/roles -> ../alternate style: a symlink whose target is inside root
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expectUnsafe(() => resolveManagedTarget(root, 'link/file.md'));
  });
});

describe('readManagedFile', () => {
  it('reads a contained regular UTF-8 file', () => {
    const root = tmp();
    writeFileSync(join(root, 'a.txt'), 'hello');
    expect(readManagedFile(root, 'a.txt')).toBe('hello');
  });

  it('rejects a file larger than the limit before reading', () => {
    const root = tmp();
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(100));
    try {
      readManagedFile(root, 'big.txt', 10);
      expect.unreachable('should reject oversize');
    } catch (err) {
      expect((err as CrewError).code).toBe('INVALID_CONFIG');
    }
  });

  it('rejects a non-regular file', () => {
    const root = tmp();
    mkdirSync(join(root, 'dir'));
    try {
      readManagedFile(root, 'dir');
      expect.unreachable('should reject directory');
    } catch (err) {
      expect((err as CrewError).code).toBe('INVALID_CONFIG');
    }
  });

  it('rejects a symlinked file (UNSAFE_PATH)', () => {
    const root = tmp();
    const outside = join(tmp(), 'secret');
    writeFileSync(outside, 'sensitive');
    symlinkSync(outside, join(root, 'link.txt'));
    expectUnsafe(() => readManagedFile(root, 'link.txt'));
  });

  it('rejects invalid UTF-8', () => {
    const root = tmp();
    writeFileSync(join(root, 'bad.bin'), Buffer.from([0xff, 0xfe, 0x00]));
    try {
      readManagedFile(root, 'bad.bin');
      expect.unreachable('should reject invalid utf-8');
    } catch (err) {
      expect((err as CrewError).code).toBe('INVALID_CONFIG');
    }
  });
});

describe('ensureManagedDir', () => {
  it('creates a managed directory', () => {
    const root = tmp();
    ensureManagedDir(root, join('.crew', 'roles'));
    expect(readdirSync(join(root, '.crew'))).toContain('roles');
  });

  it('refuses to create through a symlinked component', () => {
    const root = tmp();
    const outside = join(tmp(), 'target');
    mkdirSync(outside);
    symlinkSync(outside, join(root, '.crew'));
    expectUnsafe(() => ensureManagedDir(root, join('.crew', 'roles')));
  });
});

describe('writeFileAtomic', () => {
  it('writes content, creating parent directories', () => {
    const root = tmp();
    const target = join(root, 'a', 'b', 'file.txt');
    writeFileAtomic(root, target, 'hello');
    expect(readFileSync(target, 'utf8')).toBe('hello');
  });

  it('accepts a root-relative target', () => {
    const root = tmp();
    writeFileAtomic(root, join('sub', 'file.txt'), 'rel');
    expect(readFileSync(join(root, 'sub', 'file.txt'), 'utf8')).toBe('rel');
  });

  it('replaces an existing file and leaves no temp files', () => {
    const root = tmp();
    const target = join(root, 'file.txt');
    writeFileAtomic(root, target, 'first');
    writeFileAtomic(root, target, 'second');
    expect(readFileSync(target, 'utf8')).toBe('second');
    const leftovers = readdirSync(root).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('[security] re-checks containment at write time: a parent swapped for an outside-pointing symlink after validation is rejected', () => {
    const root = tmp();
    const outside = tmp();
    mkdirSync(join(root, 'sub'));
    // Caller-side validation passes while `sub` is a real directory…
    const target = resolveManagedTarget(root, join('sub', 'file.txt'));
    // …then the validated parent is swapped for a symlink escaping the root
    // (the TOCTOU window between check and write).
    rmSync(join(root, 'sub'), { recursive: true, force: true });
    symlinkSync(outside, join(root, 'sub'));
    expectUnsafe(() => writeFileAtomic(root, target, 'payload'));
    // Nothing landed outside the root.
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe('assertRealParentWithin', () => {
  it('returns the physical target path for a contained parent', () => {
    const root = tmp();
    mkdirSync(join(root, 'sub'));
    const physical = assertRealParentWithin(root, join(root, 'sub', 'file.txt'));
    expect(physical.endsWith(join('sub', 'file.txt'))).toBe(true);
  });

  it('[security] rejects a parent whose realpath escapes the root', () => {
    const root = tmp();
    const outside = tmp();
    symlinkSync(outside, join(root, 'sub'));
    expectUnsafe(() => assertRealParentWithin(root, join(root, 'sub', 'file.txt')));
  });
});

describe('ensureDir', () => {
  it('is idempotent', () => {
    const root = tmp();
    const dir = join(root, 'x', 'y');
    ensureDir(dir);
    ensureDir(dir);
    expect(readdirSync(join(root, 'x'))).toContain('y');
  });
});
