import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CrewError } from '../../src/errors.js';
import {
  artifactExists,
  backupArtifact,
  isSymlinkLeaf,
  readArtifact,
  resolveProjectArtifact,
  UnreadableArtifact,
  writeArtifactAtomic,
  writeProjectArtifactAtomic,
} from '../../src/setup/fs.js';

const made: string[] = [];
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'crew-setupfs-'));
  made.push(d);
  return d;
}
afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('readArtifact', () => {
  it('returns null when absent', () => {
    expect(readArtifact(join(dir(), 'nope.md'))).toBeNull();
  });

  it('reads a regular UTF-8 file', () => {
    const p = join(dir(), 'a.md');
    writeFileSync(p, 'hello\n');
    expect(readArtifact(p)).toBe('hello\n');
  });

  it('rejects a relative path', () => {
    expect(() => readArtifact('relative/path.md')).toThrow(CrewError);
  });

  it('throws UnreadableArtifact for invalid UTF-8', () => {
    const p = join(dir(), 'bin.md');
    writeFileSync(p, Buffer.from([0xff, 0xfe, 0x00]));
    expect(() => readArtifact(p)).toThrow(UnreadableArtifact);
  });

  it('throws for a non-regular file (a directory)', () => {
    const p = join(dir(), 'sub');
    mkdirSync(p);
    expect(() => readArtifact(p)).toThrow(CrewError);
  });
});

describe('isSymlinkLeaf / artifactExists', () => {
  it('detects a symlinked leaf and an absent path', () => {
    const d = dir();
    const real = join(d, 'real.md');
    writeFileSync(real, 'x\n');
    const link = join(d, 'link.md');
    symlinkSync(real, link);
    expect(isSymlinkLeaf(link)).toBe(true);
    expect(isSymlinkLeaf(real)).toBe(false);
    expect(isSymlinkLeaf(join(d, 'absent.md'))).toBe(false);
    expect(artifactExists(real)).toBe(true);
    expect(artifactExists(link)).toBe(true);
    expect(artifactExists(join(d, 'absent.md'))).toBe(false);
  });

  it('treats a dangling symlink as existing (a leaf to refuse without --force)', () => {
    const d = dir();
    const link = join(d, 'dangling.md');
    symlinkSync(join(d, 'missing-target.md'), link);
    expect(isSymlinkLeaf(link)).toBe(true);
    expect(artifactExists(link)).toBe(true);
  });
});

describe('writeArtifactAtomic', () => {
  it('creates parent directories and writes content', () => {
    const p = join(dir(), 'deep/nested/crew/SKILL.md');
    writeArtifactAtomic(p, 'body\n');
    expect(readFileSync(p, 'utf8')).toBe('body\n');
  });

  it('replaces an existing file in place', () => {
    const p = join(dir(), 'x.md');
    writeArtifactAtomic(p, 'one\n');
    writeArtifactAtomic(p, 'two\n');
    expect(readFileSync(p, 'utf8')).toBe('two\n');
  });

  it('rejects a relative path', () => {
    expect(() => writeArtifactAtomic('rel.md', 'x')).toThrow(CrewError);
  });

  it('tolerates a symlinked parent directory (stow/chezmoi)', () => {
    const d = dir();
    const realParent = join(d, 'real-config');
    mkdirSync(realParent, { recursive: true });
    const linkedParent = join(d, 'linked-config');
    symlinkSync(realParent, linkedParent);
    const p = join(linkedParent, 'crew/SKILL.md');
    writeArtifactAtomic(p, 'body\n');
    expect(readFileSync(join(realParent, 'crew/SKILL.md'), 'utf8')).toBe('body\n');
  });

  it('applies the requested parent-directory mode (user-only vs world-readable)', () => {
    const d = dir();
    // Read the ambient umask robustly so the assertion is environment-independent.
    const probe = join(d, 'umask-probe');
    mkdirSync(probe, { mode: 0o777 });
    const umask = 0o777 & ~(statSync(probe).mode & 0o777);

    const globalPath = join(d, 'global/skills/crew/SKILL.md');
    writeArtifactAtomic(globalPath, 'x\n', 0o700);
    expect(statSync(join(d, 'global')).mode & 0o777).toBe(0o700 & ~umask);

    const projectPath = join(d, 'project/agents/crew.agent.md');
    writeArtifactAtomic(projectPath, 'x\n', 0o755);
    expect(statSync(join(d, 'project')).mode & 0o777).toBe(0o755 & ~umask);
  });

  it('removes the temp sibling when the rename fails (no orphan .tmp)', () => {
    const d = dir();
    const target = join(d, 'target');
    mkdirSync(target); // a directory squats the target path → rename throws
    expect(() => writeArtifactAtomic(target, 'body\n')).toThrow();
    expect(readdirSync(d).filter((n) => n.includes('.tmp'))).toEqual([]);
  });
});

describe('resolveProjectArtifact', () => {
  it('resolves a registry-relative path under the workspace root', () => {
    const root = dir();
    expect(resolveProjectArtifact(root, '.claude/skills/crew/SKILL.md')).toBe(
      join(root, '.claude/skills/crew/SKILL.md'),
    );
  });

  it('[security] rejects a symlinked repo component that escapes the workspace', () => {
    const root = dir();
    const escape = dir();
    symlinkSync(escape, join(root, '.claude'));
    expect(() => resolveProjectArtifact(root, '.claude/skills/crew/SKILL.md')).toThrow(CrewError);
    expect(existsSync(join(escape, 'skills'))).toBe(false);
  });

  it('[security] rejects a symlinked intermediate component even when it stays inside the root', () => {
    const root = dir();
    mkdirSync(join(root, '.claude'), { recursive: true });
    mkdirSync(join(root, 'elsewhere'), { recursive: true });
    symlinkSync(join(root, 'elsewhere'), join(root, '.claude', 'skills'));
    expect(() => resolveProjectArtifact(root, '.claude/skills/crew/SKILL.md')).toThrow(CrewError);
  });

  it('rejects traversal out of the workspace root', () => {
    expect(() => resolveProjectArtifact(dir(), '../escape.md')).toThrow(CrewError);
  });
});

describe('writeProjectArtifactAtomic', () => {
  it('writes a contained project artifact, creating parent directories', () => {
    const root = dir();
    writeProjectArtifactAtomic(root, '.claude/skills/crew/SKILL.md', 'body\n');
    expect(readFileSync(join(root, '.claude/skills/crew/SKILL.md'), 'utf8')).toBe('body\n');
  });

  it('[security] re-checks containment at write time: a parent swapped for an outside symlink after the up-front check is rejected', () => {
    const root = dir();
    const escape = dir();
    mkdirSync(join(root, '.claude/skills/crew'), { recursive: true });
    // The up-front check passes while the tree is real (mirroring
    // runSetupParticipant's resolveProjectArtifact before classification/backup)…
    resolveProjectArtifact(root, '.claude/skills/crew/SKILL.md');
    // …then a concurrent process swaps the validated component for an
    // outside-pointing symlink before the write (the TOCTOU window).
    rmSync(join(root, '.claude'), { recursive: true, force: true });
    symlinkSync(escape, join(root, '.claude'));
    try {
      writeProjectArtifactAtomic(root, '.claude/skills/crew/SKILL.md', 'payload\n');
      expect.unreachable('should have thrown UNSAFE_PATH');
    } catch (err) {
      expect(err).toBeInstanceOf(CrewError);
      expect((err as CrewError).code).toBe('UNSAFE_PATH');
    }
    // Nothing landed outside the workspace root.
    expect(readdirSync(escape)).toEqual([]);
  });
});

describe('backupArtifact', () => {
  it('moves the existing file to <path>.bak.<epoch> (preserving its bytes)', () => {
    const d = dir();
    const p = join(d, 'a.md');
    writeFileSync(p, 'original\n');
    const backup = backupArtifact(p, 99);
    expect(backup).toBe(`${p}.bak.99`);
    expect(readFileSync(backup!, 'utf8')).toBe('original\n');
    expect(existsSync(p)).toBe(false); // moved aside, not copied
  });

  it('returns null for an absent path (nothing to back up)', () => {
    expect(backupArtifact(join(dir(), 'gone.md'), 99)).toBeNull();
  });

  it('preserves a dangling symlink by moving it instead of destroying it', () => {
    const d = dir();
    const link = join(d, 'dangling.md');
    symlinkSync(join(d, 'missing-target.md'), link);
    const backup = backupArtifact(link, 99);
    expect(backup).toBe(`${link}.bak.99`);
    expect(isSymlinkLeaf(backup!)).toBe(true); // the link itself was preserved
    expect(isSymlinkLeaf(link)).toBe(false); // and moved off the original path
  });

  it('allocates a non-colliding name when a same-epoch backup already exists', () => {
    const d = dir();
    const p = join(d, 'a.md');
    writeFileSync(p, 'first\n');
    const b1 = backupArtifact(p, 99);
    writeFileSync(p, 'second\n');
    const b2 = backupArtifact(p, 99);
    expect(b1).toBe(`${p}.bak.99`);
    expect(b2).toBe(`${p}.bak.99.1`);
    expect(readFileSync(b1!, 'utf8')).toBe('first\n'); // first backup not overwritten
    expect(readFileSync(b2!, 'utf8')).toBe('second\n');
  });
});
