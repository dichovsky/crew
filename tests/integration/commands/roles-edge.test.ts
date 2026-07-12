/**
 * Edge-case branch coverage for `src/roles.ts`.
 *
 * Targets the classify / version-parse / list branches that the main
 * `roles.test.ts` suite leaves unexercised:
 *   - parseVersion with a frontmatter block that omits `crew_version` (line 54)
 *   - infoFor's packaged fallback when project content is absent (lines 67, 68)
 *   - listRoles with a missing `.crew/roles` directory (line 79)
 *   - listRoles skipping the managed read for a name with no project file (line 87)
 *   - runRolesList human output rendering "-" for a null version (line 170)
 *
 * Everything is driven through `run(...)` so the human/JSON surfaces are covered
 * exactly as a user would exercise them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initWorkspace } from '../../../src/init.js';
import { run } from '../../../src/run.js';
import { captureIo } from '../../helpers/io.js';

const made: string[] = [];

/** A fresh temp directory with an initialized workspace; returns its path. */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-roles-edge-'));
  made.push(dir);
  const { io } = captureIo({ cwd: dir });
  initWorkspace(io, { withGuides: false, json: false });
  return dir;
}

function rolePath(cwd: string, name: string): string {
  return join(cwd, '.crew', 'roles', `${name}.md`);
}

/** Parse captured NDJSON stdout into role records. */
function records(out: string[]): Record<string, unknown>[] {
  return out
    .join('')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

afterEach(() => {
  while (made.length) {
    rmSync(made.pop()!, { recursive: true, force: true });
  }
});

describe('parseVersion — frontmatter without crew_version (line 54)', () => {
  it('reports a null version when a frontmatter block omits crew_version', async () => {
    const cwd = workspace();
    // A real `---\n...\n---` block is present, so parseVersion reaches the
    // crew_version regex and finds no match (line 54's null branch).
    writeFileSync(
      rolePath(cwd, 'auditor'),
      '---\ntitle: Auditor\ndescription: a custom role\n---\n# Auditor Body\n',
    );
    const { io, out } = captureIo({ cwd });
    expect(await run(['role', 'show', 'auditor', '--json'], io)).toBe(0);
    const record = JSON.parse(out.join('').trim()) as {
      type: string;
      source: string;
      builtin: boolean;
      version: number | null;
    };
    expect(record).toMatchObject({ type: 'role', source: 'project', builtin: false });
    expect(record.version).toBeNull();
  });
});

describe('listRoles — missing roles directory (line 79)', () => {
  it('lists packaged roles when .crew/roles is absent', async () => {
    const cwd = workspace();
    // existsSync(rolesDir) is false, so projectNames short-circuits to []
    // and every packaged name resolves via the packaged fallback (lines 67/68).
    rmSync(join(cwd, '.crew', 'roles'), { recursive: true, force: true });
    const { io, out } = captureIo({ cwd });
    expect(await run(['roles', '--json'], io)).toBe(0);
    const byName = Object.fromEntries(records(out).map((r) => [r.name as string, r] as const));
    for (const name of ['manager', 'worker']) {
      expect(byName[name]).toMatchObject({ source: 'packaged', builtin: true, version: 4 });
    }
    expect(byName['inspector']).toMatchObject({ source: 'packaged', builtin: true, version: 2 });
  });
});

describe('listRoles — deleted packaged seed file (lines 87, 67, 68)', () => {
  it('classifies a deleted seed as packaged via the packaged fallback', async () => {
    const cwd = workspace();
    // The roles dir still exists (line 79 true), but `manager` is not among the
    // enumerated project files, so line 87 skips the managed read and infoFor
    // takes the projectContent===null / builtin=true fallback (lines 67, 68).
    rmSync(rolePath(cwd, 'manager'));
    const { io, out } = captureIo({ cwd });
    expect(await run(['roles', '--json'], io)).toBe(0);
    const manager = records(out).find((r) => r.name === 'manager');
    expect(manager).toMatchObject({ source: 'packaged', builtin: true, version: 4 });
  });
});

describe('listRoles — strict listing rethrows the first per-file failure', () => {
  it('fails `crew roles` with INVALID_CONFIG when a project role is oversized', async () => {
    const cwd = workspace();
    // The tolerant lister collects the oversized file as a per-file failure;
    // the strict `listRoles` wrapper rethrows it, so `crew roles` still aborts.
    writeFileSync(rolePath(cwd, 'broken'), 'x'.repeat(300_000));
    const { io, out, err } = captureIo({ cwd });
    expect(await run(['roles', '--json'], io)).toBe(2);
    expect(out.join('')).toBe('');
    expect(JSON.parse(err.join('')) as Record<string, unknown>).toMatchObject({
      ok: false,
      error: { code: 'INVALID_CONFIG' },
    });
  });
});

describe('crew roles human output — null version rendering (line 170)', () => {
  it('renders "-" in the VERSION column for a role with no version', async () => {
    const cwd = workspace();
    // A custom role with no frontmatter → version null → line 170's "-" branch.
    writeFileSync(rolePath(cwd, 'auditor'), '# Auditor\n');
    const { io, out } = captureIo({ cwd });
    expect(await run(['roles'], io)).toBe(0);
    expect(out.join('')).toMatch(/auditor\s+project\s+-/);
  });
});
