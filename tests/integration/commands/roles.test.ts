/* eslint-disable */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initWorkspace } from '../../../src/init.js';
import {
  exportRole,
  listRoles,
  resolveRole,
  roleExists,
  runRoleExport,
  runRolesList,
  runRoleShow,
} from '../../../src/roles.js';
import { run } from '../../../src/run.js';
import { PACKAGED_ROLES } from '../../../src/templates.js';
import { CrewError } from '../../../src/errors.js';
import { captureIo } from '../../helpers/io.js';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

const made: string[] = [];

/** A fresh temp directory with an initialized workspace; returns its path. */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-roles-'));
  made.push(dir);
  const { io } = captureIo({ cwd: dir });
  initWorkspace(io, { withGuides: false, json: false });
  return dir;
}

function rolePath(cwd: string, name: string): string {
  return join(cwd, '.crew', 'roles', `${name}.md`);
}

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
  while (made.length) {
    rmSync(made.pop()!, { recursive: true, force: true });
  }
});

describe('listRoles', () => {
  it('lists seeded built-ins as packaged (unmodified seeds)', () => {
    const { io } = captureIo({ cwd: workspace() });
    const roles = listRoles(io);
    const byName = Object.fromEntries(roles.map((r) => [r.name, r]));
    for (const name of ['manager', 'worker']) {
      expect(byName[name]).toMatchObject({ source: 'packaged', builtin: true, version: 4 });
    }
    expect(byName['inspector']).toMatchObject({ source: 'packaged', builtin: true, version: 2 });
  });

  it('reports an edited Role file as project source', () => {
    const cwd = workspace();
    writeFileSync(rolePath(cwd, 'manager'), '# My manager\n');
    const { io } = captureIo({ cwd });
    const manager = listRoles(io).find((r) => r.name === 'manager');
    expect(manager).toMatchObject({ source: 'project', builtin: true });
  });

  it('includes a custom Role with no packaged counterpart', () => {
    const cwd = workspace();
    writeFileSync(rolePath(cwd, 'auditor'), '# Auditor\n');
    const { io } = captureIo({ cwd });
    const auditor = listRoles(io).find((r) => r.name === 'auditor');
    expect(auditor).toMatchObject({ source: 'project', builtin: false });
  });

  it('requires a workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crew-roles-'));
    made.push(dir);
    const { io } = captureIo({ cwd: dir });
    expectCode(() => listRoles(io), 'NOT_WORKSPACE');
  });

  it('skips invalid role-name stems and non-files when enumerating', () => {
    const cwd = workspace();
    writeFileSync(join(cwd, '.crew', 'roles', 'Bad Name.md'), 'x');
    mkdirSync(join(cwd, '.crew', 'roles', 'dir.md'));
    const { io } = captureIo({ cwd });
    const names = listRoles(io).map((r) => r.name);
    expect(names).not.toContain('Bad Name');
    expect(names).not.toContain('dir');
    expect(names).toContain('manager');
  });

  it('reports a symlinked project Role rather than masking a packaged Role', () => {
    const cwd = workspace();
    const target = join(cwd, 'shared-worker.md');
    writeFileSync(target, '# Shared worker\n');
    rmSync(rolePath(cwd, 'worker'));
    symlinkSync(target, rolePath(cwd, 'worker'));
    const { io } = captureIo({ cwd });
    expectCode(() => listRoles(io), 'UNSAFE_PATH');
  });
});

describe('resolveRole', () => {
  it('returns the packaged body for an unmodified Role', () => {
    const { io } = captureIo({ cwd: workspace() });
    const role = resolveRole(io, 'manager');
    expect(role.source).toBe('packaged');
    expect(role.body).toContain('# Manager');
  });

  it('returns the project override body (FR-F02)', () => {
    const cwd = workspace();
    writeFileSync(rolePath(cwd, 'worker'), '# Custom worker\n');
    const { io } = captureIo({ cwd });
    const role = resolveRole(io, 'worker');
    expect(role.source).toBe('project');
    expect(role.body).toBe('# Custom worker\n');
  });

  it('rejects an invalid name with USAGE', () => {
    const { io } = captureIo({ cwd: workspace() });
    expectCode(() => resolveRole(io, 'Bad Name'), 'USAGE');
  });

  it('reports NOT_FOUND for an unknown role', () => {
    const { io } = captureIo({ cwd: workspace() });
    expectCode(() => resolveRole(io, 'ghost'), 'NOT_FOUND');
  });

  it('rejects reading a symlinked project Role (UNSAFE_PATH)', () => {
    const cwd = workspace();
    const outsideDir = mkdtempSync(join(tmpdir(), 'crew-out-'));
    made.push(outsideDir);
    const outside = join(outsideDir, 'leak.md');
    writeFileSync(outside, '# leaked\n');
    symlinkSync(outside, rolePath(cwd, 'leak'));
    const { io } = captureIo({ cwd });
    expectCode(() => resolveRole(io, 'leak'), 'UNSAFE_PATH');
  });
});

describe('runRoleShow — human sanitization (FR-J08/J11)', () => {
  it('strips ANSI/control sequences from human output but JSON preserves them', () => {
    const cwd = workspace();
    const evil = `# Manager\n${ESC}[31mRED${ESC}[0mbell${BEL}\n`;
    writeFileSync(rolePath(cwd, 'manager'), evil);

    const human = captureIo({ cwd });
    runRoleShow(human.io, 'manager', { json: false });
    const out = human.out.join('');
    expect(out).not.toContain(ESC);
    expect(out).not.toContain(BEL);
    expect(out).toContain('RED');
    expect(out).toContain('bell');

    const machine = captureIo({ cwd });
    runRoleShow(machine.io, 'manager', { json: true });
    const record = JSON.parse(machine.out.join('').trim()) as { body: string };
    expect(record.body).toContain(ESC);
  });
});

describe('exportRole', () => {
  it('recreates a deleted built-in (forced=false)', () => {
    const cwd = workspace();
    rmSync(rolePath(cwd, 'manager'));
    const { io } = captureIo({ cwd });
    const result = exportRole(io, 'manager', false);
    expect(result.forced).toBe(false);
    expect(readFileSync(rolePath(cwd, 'manager'), 'utf8')).toBe(PACKAGED_ROLES.manager);
  });

  it('refuses to overwrite an existing Role without --force', () => {
    const { io } = captureIo({ cwd: workspace() });
    expectCode(() => exportRole(io, 'manager', false), 'ALREADY_EXISTS');
  });

  it('resets an edited Role with --force', () => {
    const cwd = workspace();
    writeFileSync(rolePath(cwd, 'manager'), 'EDITED');
    const { io } = captureIo({ cwd });
    const result = exportRole(io, 'manager', true);
    expect(result.forced).toBe(true);
    expect(readFileSync(rolePath(cwd, 'manager'), 'utf8')).toBe(PACKAGED_ROLES.manager);
  });

  it('reports NOT_FOUND for a non-built-in role', () => {
    const { io } = captureIo({ cwd: workspace() });
    expectCode(() => exportRole(io, 'auditor', false), 'NOT_FOUND');
  });
});

describe('roles/role output', () => {
  it('emits one JSON record per role', () => {
    const { io, out } = captureIo({ cwd: workspace() });
    runRolesList(io, { json: true });
    const records = out
      .join('')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; name: string });
    expect(records.every((r) => r.type === 'role')).toBe(true);
    expect(records.map((r) => r.name).sort()).toEqual(['inspector', 'manager', 'worker']);
  });

  it('role show prints the body', () => {
    const { io, out } = captureIo({ cwd: workspace() });
    runRoleShow(io, 'inspector', { json: false });
    expect(out.join('')).toContain('# Inspector');
  });

  it('role export prints a human confirmation on a fresh export', () => {
    const cwd = workspace();
    rmSync(rolePath(cwd, 'manager'));
    const { io, out } = captureIo({ cwd });
    runRoleExport(io, 'manager', { force: false, json: false });
    expect(out.join('')).toMatch(/Exported role "manager"/);
  });

  it('role export emits a role_export JSON record', () => {
    const { io, out } = captureIo({ cwd: workspace() });
    runRoleExport(io, 'manager', { force: true, json: true });
    const record = JSON.parse(out.join('').trim()) as {
      type: string;
      name: string;
      forced: boolean;
    };
    expect(record).toMatchObject({ type: 'role_export', name: 'manager', forced: true });
  });

  it('role show handles project-defined custom roles with no version and checks ending newline options', () => {
    const cwd = workspace();
    // Custom role without trailing newline
    writeFileSync(rolePath(cwd, 'auditor'), '# Auditor');
    const { io, out } = captureIo({ cwd });
    runRoleShow(io, 'auditor', { json: false });
    expect(out.join('')).toContain('Version -');
    expect(out.join('')).toContain('# Auditor\n');
  });

  it('role export prints human confirmation on overwrite/force', () => {
    const cwd = workspace();
    const { io, out } = captureIo({ cwd });
    runRoleExport(io, 'manager', { force: true, json: false });
    expect(out.join('')).toMatch(/Overwrote role "manager"/);
  });
});

describe('through the program', () => {
  it('crew roles and crew role show exit 0', async () => {
    const cwd = workspace();
    expect(await run(['roles'], captureIo({ cwd }).io)).toBe(0);
    expect(await run(['role', 'show', 'manager'], captureIo({ cwd }).io)).toBe(0);
  });

  it('crew role export without --force exits 1 (ALREADY_EXISTS)', async () => {
    const cwd = workspace();
    const { io, err } = captureIo({ cwd });
    expect(await run(['role', 'export', 'manager'], io)).toBe(1);
    expect(err.join('')).toMatch(/^\[ALREADY_EXISTS\]/);
  });

  it('runs role export with --force and --json through the program', async () => {
    const cwd = workspace();
    const { io, out } = captureIo({ cwd });
    expect(await run(['role', 'export', 'manager', '--force', '--json'], io)).toBe(0);
    const record = JSON.parse(out.join('').trim());
    expect(record).toMatchObject({ type: 'role_export', name: 'manager', forced: true });
  });

  it('runs roles with --json through the program', async () => {
    const cwd = workspace();
    const { io, out } = captureIo({ cwd });
    expect(await run(['roles', '--json'], io)).toBe(0);
    const lines = out.join('').trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'role' });
  });

  it('runs role show with --json through the program', async () => {
    const cwd = workspace();
    const { io, out } = captureIo({ cwd });
    expect(await run(['role', 'show', 'manager', '--json'], io)).toBe(0);
    expect(JSON.parse(out.join('').trim())).toMatchObject({ type: 'role', name: 'manager' });
  });

  it('roleExists returns false for invalid role name stem', () => {
    const cwd = workspace();
    const { io } = captureIo({ cwd });
    expect(roleExists(io, 'Invalid Stem')).toBe(false);
  });

  it('falls back to packaged role when file is deleted', () => {
    const cwd = workspace();
    rmSync(rolePath(cwd, 'manager'));
    const { io } = captureIo({ cwd });
    const role = resolveRole(io, 'manager');
    expect(role.source).toBe('packaged');
    expect(role.body).toContain('# Manager');
  });
});
