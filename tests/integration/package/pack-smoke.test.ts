import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Packaging gate: build, pack, install the tarball into a clean temp prefix, and
 * run the installed executable. Proves no source TypeScript is the installed
 * entry point, the packaged file list is correct, and the shebang/exec bit work.
 */

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
  version: string;
};

interface PackEntry {
  readonly filename: string;
  readonly files: readonly { readonly path: string }[];
}

function isPackEntry(value: unknown): value is PackEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { filename?: unknown; files?: unknown };
  if (typeof candidate.filename !== 'string' || !Array.isArray(candidate.files)) return false;
  return candidate.files.every(
    (file: unknown) =>
      typeof file === 'object' &&
      file !== null &&
      typeof (file as { path?: unknown }).path === 'string',
  );
}

/**
 * `npm pack --json` has two shapes across the npm versions this project must run on:
 * npm 11 and earlier emit an array of pack entries (`[{filename, files[]}]`), while
 * npm 12 emits an object keyed by package name
 * (`{"@dichovsky/crew": {filename, files[], ...}}`). Node 24.18's bundled npm is 11.x,
 * so CI sees the array while a contributor on npm 12 sees the object. Accept both, and
 * fail loudly on anything else — indexing blindly into the wrong shape yields
 * `undefined` and a downstream `TypeError` that says nothing about the real cause.
 */
function readPackEntry(stdout: string): PackEntry {
  const parsed: unknown = JSON.parse(stdout);
  const candidates: readonly unknown[] = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null
      ? Object.values(parsed)
      : [];
  const entry = candidates[0];
  if (!isPackEntry(entry)) {
    throw new Error(
      `npm pack --json returned an unrecognized shape (expected an array of pack entries ` +
        `or an object keyed by package name); got: ${stdout.slice(0, 500)}`,
    );
  }
  return entry;
}

let workDir: string;
let prefixDir: string;
let binPath: string;
let installedEntry: string;
let installedManifest: string;
let belowFloorHook: string;
let packedFiles: string[];

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'crew-pack-'));
  prefixDir = mkdtempSync(join(tmpdir(), 'crew-prefix-'));

  // dist/ is built once by the sequential global setup (tests/global-build.ts) before
  // any project runs — deliberately NOT rebuilt here: this test shares the parallel
  // `main` project with suites the `spawn` project reads dist/ from, and an in-band
  // rmSync+build raced those readers. Pack with scripts ignored so stdout is pure JSON.
  const { stdout } = await execa(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', workDir],
    { cwd: projectRoot },
  );
  const entry = readPackEntry(stdout);
  packedFiles = entry.files.map((f) => f.path);
  const tarball = join(workDir, entry.filename);

  await execa(
    'npm',
    ['install', tarball, '--prefix', prefixDir, '--no-save', '--no-audit', '--no-fund'],
    { cwd: prefixDir },
  );

  binPath = join(prefixDir, 'node_modules', '.bin', 'crew');
  installedEntry = join(prefixDir, 'node_modules', '@dichovsky', 'crew', 'dist', 'bin', 'crew.js');
}, 180_000);

afterAll(() => {
  for (const dir of [workDir, prefixDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('packaged tarball contents', () => {
  it('includes the built executable, dashboard assets, manifest, README, and LICENSE', () => {
    expect(packedFiles).toContain('package.json');
    expect(packedFiles).toContain('README.md');
    expect(packedFiles).toContain('LICENSE');
    expect(packedFiles).toContain('dist/bin/crew.js');
    expect(packedFiles).toContain('dist/ui-assets/index.html');
    expect(packedFiles).toContain('dist/ui-assets/main.js');
  });

  it('ships no TypeScript source, tests, or node_modules', () => {
    for (const path of packedFiles) {
      expect(path.startsWith('src/')).toBe(false);
      expect(path.startsWith('tests/')).toBe(false);
      expect(path.startsWith('node_modules/')).toBe(false);
      expect(path.endsWith('.ts')).toBe(false);
    }
  });

  // Exclusivity allowlist: nothing outside {dist/**/*.js, the bundled Console
  // page dist/ui-assets/index.html (FR-U08 offline assets), README.md, LICENSE,
  // package.json} may ship. This rejects stale JavaScript, source maps
  // (`*.js.map`), declaration files, and stray fixtures regardless of how they
  // entered dist.
  it('ships only allowlisted files', () => {
    const ROOT_FILES = ['LICENSE', 'README.md', 'package.json'];
    const unexpected = packedFiles.filter(
      (path) =>
        !ROOT_FILES.includes(path) &&
        !/^dist\/.+\.js$/.test(path) &&
        path !== 'dist/ui-assets/index.html',
    );
    expect(unexpected).toEqual([]);
    // And the documented top-level files are all present.
    for (const file of ROOT_FILES) {
      expect(packedFiles).toContain(file);
    }
  });
});

describe('installed executable', () => {
  it('keeps the node shebang on the entry point', () => {
    const firstLine = readFileSync(installedEntry, 'utf8').split('\n', 1)[0];
    expect(firstLine).toBe('#!/usr/bin/env node');
  });

  it('is marked executable', () => {
    const mode = statSync(installedEntry).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it('prints the package version and exits 0', async () => {
    const result = await execa(binPath, ['--version'], { reject: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it('prints help and exits 0', async () => {
    const result = await execa(binPath, ['--help'], { reject: false });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/crew/);
  });

  it('rejects an unknown command with USAGE exit 2 on stderr', async () => {
    const result = await execa(binPath, ['bogus'], { reject: false });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/^\[USAGE\]/);
    expect(result.stdout).toBe('');
  });

  it('runs init, join, agents, and leave through the packed executable', async () => {
    const cwd = join(workDir, 'lifecycle-workspace');
    mkdirSync(cwd);
    const init = await execa(binPath, ['init', '--json'], { cwd, reject: false });
    expect(init.exitCode).toBe(0);
    expect(JSON.parse(init.stdout)).toMatchObject({ type: 'init', schema_version: 1 });

    const joined = await execa(
      binPath,
      ['join', 'worker', '--role', 'worker', '--platform', 'codex-cli', '--json'],
      { cwd, reject: false },
    );
    expect(joined.exitCode).toBe(0);
    expect(JSON.parse(joined.stdout)).toMatchObject({
      type: 'agent',
      id: 'worker',
      status: 'active',
      platform_id: 'codex-cli',
    });

    const active = await execa(binPath, ['agents', '--json'], { cwd, reject: false });
    expect(active.exitCode).toBe(0);
    expect(JSON.parse(active.stdout)).toMatchObject({ id: 'worker', activity: 'recent' });

    const left = await execa(binPath, ['leave', 'worker', '--json'], { cwd, reject: false });
    expect(left.exitCode).toBe(0);
    expect(JSON.parse(left.stdout)).toMatchObject({
      id: 'worker',
      status: 'archived',
      activity: 'archived',
    });
  });
});
