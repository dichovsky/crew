import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { CrewError } from '../../../src/errors.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace, runInit } from '../../../src/init.js';
import { run } from '../../../src/run.js';
import { captureIo } from '../../helpers/io.js';

const made: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-init-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  while (made.length) {
    rmSync(made.pop()!, { recursive: true, force: true });
  }
});

describe('init — workspace scaffold', () => {
  it('creates the .crew tree and seeds built-in Roles and the dev Team', () => {
    const cwd = tmp();
    const { io } = captureIo({ cwd });
    const result = initWorkspace(io, { withGuides: false, json: false });

    for (const dir of ['roles', 'teams', 'state', 'generated']) {
      expect(statSync(join(cwd, '.crew', dir)).isDirectory()).toBe(true);
    }
    for (const role of ['manager', 'worker', 'inspector']) {
      expect(existsSync(join(cwd, '.crew', 'roles', `${role}.md`))).toBe(true);
    }
    expect(readFileSync(join(cwd, '.crew', 'roles', 'manager.md'), 'utf8')).toContain(
      'crew_role: manager',
    );
    expect(existsSync(join(cwd, '.crew', 'teams', 'dev.yaml'))).toBe(true);
    expect(result.seeded).toContain('.crew/roles/manager.md');
    expect(result.seeded).toContain('.crew/teams/dev.yaml');
  });

  it('is idempotent: a second init seeds nothing and skips existing files', () => {
    const cwd = tmp();
    const { io } = captureIo({ cwd });
    initWorkspace(io, { withGuides: false, json: false });
    const second = initWorkspace(io, { withGuides: false, json: false });
    expect(second.seeded).toEqual([]);
    expect(second.skipped).toContain('.crew/roles/manager.md');
    expect(second.gitignoreUpdated).toBe(false);
  });

  it('never overwrites an existing Role file', () => {
    const cwd = tmp();
    const { io } = captureIo({ cwd });
    initWorkspace(io, { withGuides: false, json: false });
    const manager = join(cwd, '.crew', 'roles', 'manager.md');
    writeFileSync(manager, 'CUSTOM USER CONTENT');
    initWorkspace(io, { withGuides: false, json: false });
    expect(readFileSync(manager, 'utf8')).toBe('CUSTOM USER CONTENT');
  });
});

describe('init — selective gitignore', () => {
  it('ignores only state/ and generated/, never all of .crew/', () => {
    const cwd = tmp();
    const { io } = captureIo({ cwd });
    initWorkspace(io, { withGuides: false, json: false });
    const lines = readFileSync(join(cwd, '.crew', '.gitignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim());
    expect(lines).toContain('state/');
    expect(lines).toContain('generated/');
    expect(lines).not.toContain('.crew/');
    expect(lines).not.toContain('/');
  });

  it('preserves user lines and does not duplicate entries on re-run', () => {
    const cwd = tmp();
    const { io } = captureIo({ cwd });
    initWorkspace(io, { withGuides: false, json: false });
    const gitignore = join(cwd, '.crew', '.gitignore');
    writeFileSync(gitignore, `${readFileSync(gitignore, 'utf8')}custom-local/\n`);
    const second = initWorkspace(io, { withGuides: false, json: false });
    expect(second.gitignoreUpdated).toBe(false);
    const lines = readFileSync(gitignore, 'utf8').split('\n').filter(Boolean);
    expect(lines.filter((l) => l.trim() === 'state/')).toHaveLength(1);
    expect(lines).toContain('custom-local/');
  });

  it('repairs a gitignore that lost a managed entry, keeping user lines', () => {
    const cwd = tmp();
    const { io } = captureIo({ cwd });
    initWorkspace(io, { withGuides: false, json: false });
    const gitignore = join(cwd, '.crew', '.gitignore');
    // Drop generated/ but keep the rest: the existing-file append path.
    const kept = readFileSync(gitignore, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== 'generated/')
      .join('\n');
    writeFileSync(gitignore, kept);
    const second = initWorkspace(io, { withGuides: false, json: false });
    expect(second.gitignoreUpdated).toBe(true);
    const lines = readFileSync(gitignore, 'utf8')
      .split('\n')
      .map((l) => l.trim());
    expect(lines).toContain('generated/');
    expect(lines).toContain('state/');
  });
});

describe('init — human output', () => {
  it('lists seeded files on the first run, then "none" seeded and the gitignore repair on the second', async () => {
    const cwd = tmp();
    const first = captureIo({ cwd });
    expect(await run(['init'], first.io)).toBe(0);
    const firstText = first.out.join('');
    expect(firstText).toContain('seeded:  .crew/roles/manager.md');
    expect(firstText).toContain('skipped: none');
    expect(firstText).toContain('updated: .crew/.gitignore');

    // Remove one managed entry so the second run repairs the gitignore too.
    const gitignore = join(cwd, '.crew', '.gitignore');
    writeFileSync(
      gitignore,
      readFileSync(gitignore, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== 'generated/')
        .join('\n'),
    );
    const second = captureIo({ cwd });
    expect(await run(['init'], second.io)).toBe(0);
    const secondText = second.out.join('');
    expect(secondText).toContain('seeded:  none');
    expect(secondText).toContain('skipped: .crew/roles/manager.md');
    expect(secondText).toContain('updated: .crew/.gitignore');
  });
});

describe('init — containment (FR-B15)', () => {
  it('refuses to initialize through a symlinked .crew and writes nothing in the target', () => {
    const cwd = tmp();
    const outside = tmp();
    symlinkSync(outside, join(cwd, '.crew'));
    const { io } = captureIo({ cwd });
    try {
      initWorkspace(io, { withGuides: false, json: false });
      expect.unreachable('should reject symlinked .crew');
    } catch (err) {
      expect(err).toBeInstanceOf(CrewError);
      expect((err as CrewError).code).toBe('UNSAFE_PATH');
    }
    expect(readdirSync(outside)).toEqual([]);
  });

  it('skips a symlinked guide file rather than writing through it', () => {
    const cwd = tmp();
    const outsideDir = tmp();
    const victim = join(outsideDir, 'victim.md');
    writeFileSync(victim, 'ORIGINAL\n');
    symlinkSync(victim, join(cwd, 'CLAUDE.md'));
    const { io } = captureIo({ cwd });
    const result = initWorkspace(io, { withGuides: true, json: false });
    expect(result.guidesAppended).toEqual([]);
    expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL\n');
  });
});

describe('init — no $HOME writes (FR-B11)', () => {
  it('writes nothing under the home directory', () => {
    const cwd = tmp();
    const home = tmp();
    const { io } = captureIo({ cwd, env: { HOME: home } });
    initWorkspace(io, { withGuides: true, json: false });
    expect(readdirSync(home)).toEqual([]);
  });
});

describe('init --with-guides', () => {
  it('preserves a non-UTF-8 guide prefix byte-for-byte when appending', () => {
    const cwd = tmp();
    const original = Buffer.from([0x66, 0x6f, 0x80, 0x6f, 0x0a]);
    writeFileSync(join(cwd, 'CLAUDE.md'), original);
    const { io } = captureIo({ cwd });

    expect(initWorkspace(io, { withGuides: true, json: false }).guidesAppended).toEqual([
      'CLAUDE.md',
    ]);
    const result = readFileSync(join(cwd, 'CLAUDE.md'));
    expect(result.subarray(0, original.length).equals(original)).toBe(true);
    expect(result.subarray(original.length).toString('utf8')).toContain('<!-- crew:begin -->');
  });

  it('preserves every existing trailing newline byte when appending', () => {
    const cwd = tmp();
    const original = Buffer.from('line one\r\n\r\n');
    writeFileSync(join(cwd, 'CLAUDE.md'), original);
    const { io } = captureIo({ cwd });

    initWorkspace(io, { withGuides: true, json: false });

    const result = readFileSync(join(cwd, 'CLAUDE.md'));
    expect(result.subarray(0, original.length).equals(original)).toBe(true);
    expect(result.subarray(original.length).toString('utf8')).toMatch(/^\n<!-- crew:begin -->/);
  });

  it('appends a marked section only to existing guides, exactly once', () => {
    const cwd = tmp();
    writeFileSync(join(cwd, 'CLAUDE.md'), '# Project\n');
    const { io } = captureIo({ cwd });

    const first = initWorkspace(io, { withGuides: true, json: false });
    expect(first.guidesAppended).toEqual(['CLAUDE.md']);
    const claude = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
    expect(claude).toContain('# Project');
    expect(claude).toContain('<!-- crew:begin -->');

    // never creates AGENTS.md / GEMINI.md
    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(cwd, 'GEMINI.md'))).toBe(false);

    // second run does not append again
    const second = initWorkspace(io, { withGuides: true, json: false });
    expect(second.guidesAppended).toEqual([]);
    const occurrences =
      readFileSync(join(cwd, 'CLAUDE.md'), 'utf8').split('<!-- crew:begin -->').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('init — output', () => {
  it('emits one JSON record with --json', () => {
    const cwd = tmp();
    const { io, out } = captureIo({ cwd });
    runInit(io, { withGuides: false, json: true });
    const record = JSON.parse(out.join('').trim()) as Record<string, unknown>;
    expect(record).toMatchObject({ type: 'init', schema_version: 1 });
    // snake_case fields per the CLI contract (FR-J02)
    expect(record).toHaveProperty('gitignore_updated');
    expect(record).toHaveProperty('guides_appended');
    expect(record).not.toHaveProperty('gitignoreUpdated');
  });

  it('prints a human summary by default', () => {
    const cwd = tmp();
    const { io, out } = captureIo({ cwd });
    runInit(io, { withGuides: false, json: false });
    expect(out.join('')).toMatch(/Initialized crew workspace/);
  });

  it('prints a human summary with guides by default', () => {
    const cwd = tmp();
    writeFileSync(join(cwd, 'CLAUDE.md'), '# Project\n');
    const { io, out } = captureIo({ cwd });
    runInit(io, { withGuides: true, json: false });
    expect(out.join('')).toMatch(/Initialized crew workspace/);
    expect(out.join('')).toMatch(/guides:\s+appended to CLAUDE.md/);
  });
});

describe('init — through the program', () => {
  it('is reachable as a subcommand and exits 0', async () => {
    const cwd = tmp();
    const { io } = captureIo({ cwd });
    expect(await run(['init'], io)).toBe(0);
    expect(existsSync(join(cwd, '.crew', 'roles', 'manager.md'))).toBe(true);
  });
});
