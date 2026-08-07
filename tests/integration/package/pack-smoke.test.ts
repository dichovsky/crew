import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NODE_FLOOR, isNodeBelow } from '../../../src/node-floor.js';

/**
 * Packaging gate: build, pack, install the tarball into a clean temp prefix, and
 * run the installed executable. Proves no source TypeScript is the installed
 * entry point, the packaged file list is correct, and the shebang/exec bit work.
 */

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));
const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
  version: string;
};

/**
 * The Node version the installed entry point is made to observe for the engine-floor
 * case. Any Node 20 is below every Node 24 floor crew can ever declare (`node:sqlite`
 * does not exist before Node 22), so this constant does not need revisiting when
 * {@link NODE_FLOOR} moves up.
 */
const BELOW_FLOOR_NODE = '20.19.0';

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    // Parsing outside the shape guard would surface a bare SyntaxError, losing the
    // context this function exists to provide — e.g. when npm prepends a warning to
    // stdout despite --ignore-scripts.
    throw new Error(`npm pack --json did not emit JSON; got: ${stdout.slice(0, 500)}`, { cause });
  }
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
  installedManifest = join(prefixDir, 'node_modules', '@dichovsky', 'crew', 'package.json');

  // Preload module for the engine-floor case. It runs before the installed entry point
  // is evaluated, so `assertNodeFloor()` — the first thing the shim does — reads the
  // spoofed version. The installed file itself is still what executes; only the
  // runtime version it observes is substituted, because an actual below-floor Node
  // cannot be installed from inside the suite. So this proves the shim reports clearly
  // and exits 1 on a below-floor version; it does NOT prove the deeper reason the floor
  // exists — that `node:sqlite` is absent below Node 24, and that the floor check must
  // precede the dynamic import. On a real Node 24 host the app graph links either way,
  // so that ordering stays covered by reasoning rather than by execution.
  belowFloorHook = join(workDir, 'below-floor-node.mjs');
  writeFileSync(
    belowFloorHook,
    `Object.defineProperty(process.versions, 'node', {\n` +
      `  value: ${JSON.stringify(BELOW_FLOOR_NODE)},\n` +
      `  configurable: true,\n` +
      `  enumerable: true,\n` +
      `});\n`,
    'utf8',
  );
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

  it('round-trips a Message from send to receive through the packed executable', async () => {
    const cwd = join(workDir, 'messaging-workspace');
    mkdirSync(cwd);
    const init = await execa(binPath, ['init', '--json'], { cwd, reject: false });
    expect(init.exitCode).toBe(0);
    for (const id of ['manager', 'worker']) {
      const joined = await execa(binPath, ['join', id, '--role', id, '--json'], {
        cwd,
        reject: false,
      });
      expect(joined.exitCode).toBe(0);
    }

    const content = 'Inspect the packaging gate';
    const sent = await execa(binPath, ['send', 'manager', 'worker', content, '--json'], {
      cwd,
      reject: false,
    });
    expect(sent.exitCode).toBe(0);
    expect(JSON.parse(sent.stdout)).toMatchObject({
      type: 'message',
      sender_id: 'manager',
      recipient_id: 'worker',
      content,
      kind: 'note',
    });

    const received = await execa(binPath, ['receive', 'worker', '--json'], { cwd, reject: false });
    expect(received.exitCode).toBe(0);
    const delivered = received.stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      type: 'message',
      sender_id: 'manager',
      recipient_id: 'worker',
      content,
    });

    // A Message is consumed from the Inbox by the receive that returned it: the
    // returned record carries the committed read timestamp, and a second receive
    // finds nothing.
    // Asserting the type, not just non-null: `not.toBeNull()` would also pass on
    // `undefined`, so dropping `read_at` from the record would silently disarm this.
    expect(delivered[0]?.read_at).toEqual(expect.any(Number));
    const drained = await execa(binPath, ['receive', 'worker', '--json'], { cwd, reject: false });
    expect(drained.exitCode).toBe(0);
    expect(drained.stdout.trim()).toBe('');
  });

  it('drives a Task from creation to a Review that completes it', async () => {
    const cwd = join(workDir, 'task-workspace');
    mkdirSync(cwd);
    const init = await execa(binPath, ['init', '--json'], { cwd, reject: false });
    expect(init.exitCode).toBe(0);
    for (const id of ['manager', 'worker', 'inspector']) {
      const joined = await execa(binPath, ['join', id, '--role', id, '--json'], {
        cwd,
        reject: false,
      });
      expect(joined.exitCode).toBe(0);
    }

    const created = await execa(
      binPath,
      [
        'task',
        'create',
        'manager',
        'worker',
        '--reviewer',
        'inspector',
        '--title',
        'Prove the packaging gate covers Tasks',
        '--json',
      ],
      { cwd, reject: false },
    );
    expect(created.exitCode).toBe(0);
    const task = JSON.parse(created.stdout) as { id: string; status: string };
    expect(task).toMatchObject({
      type: 'task',
      creator_id: 'manager',
      assignee_id: 'worker',
      reviewer_id: 'inspector',
      status: 'queued',
    });

    const started = await execa(binPath, ['task', 'start', 'worker', task.id, '--json'], {
      cwd,
      reject: false,
    });
    expect(started.exitCode).toBe(0);
    expect(JSON.parse(started.stdout)).toMatchObject({
      id: task.id,
      status: 'in_progress',
      lease_owner_id: 'worker',
    });

    // The Worker produces a Submission; the Task is not done until an Inspector's
    // Review accepts it (CONTEXT.md).
    const summary = 'Added the packaging assertions';
    const submitted = await execa(
      binPath,
      ['task', 'submit', 'worker', task.id, '--summary', summary, '--json'],
      { cwd, reject: false },
    );
    expect(submitted.exitCode).toBe(0);
    expect(JSON.parse(submitted.stdout)).toMatchObject({
      id: task.id,
      status: 'submitted',
      submission_summary: summary,
    });

    const approved = await execa(binPath, ['task', 'approve', 'inspector', task.id, '--json'], {
      cwd,
      reject: false,
    });
    expect(approved.exitCode).toBe(0);
    expect(JSON.parse(approved.stdout)).toMatchObject({ id: task.id, status: 'completed' });

    const shown = await execa(binPath, ['task', 'show', task.id, '--json'], { cwd, reject: false });
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({ id: task.id, status: 'completed' });
  });

  it('refuses to run under a below-floor Node with the shim message and exit 1', async () => {
    const result = await execa(
      process.execPath,
      ['--import', pathToFileURL(belowFloorHook).href, installedEntry, '--version'],
      { reject: false },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe(
      `crew requires Node >=${NODE_FLOOR} (found v${BELOW_FLOOR_NODE}). Upgrade Node to run crew.`,
    );
    // The floor is refused before the program runs, so nothing is printed on stdout.
    expect(result.stdout).toBe('');
  });

  it('declares an engines floor equal to the floor the shim enforces', () => {
    const manifest = JSON.parse(readFileSync(installedManifest, 'utf8')) as {
      engines?: { node?: string };
    };
    const range = manifest.engines?.node ?? '';
    expect(range.startsWith('>=')).toBe(true);
    // Equal in both directions: a manifest that admits a Node the shim would refuse
    // (or refuses one the shim accepts) is the drift this gate exists to catch.
    // Read the lower bound rather than assuming the range is exactly `>=X.Y`: adding an
    // upper bound (`>=24.15 <25`) would otherwise parse to a bogus minimum.
    const declaredMinimum = /^>=\s*([0-9]+(?:\.[0-9]+){0,2})/.exec(range)?.[1] ?? '';
    expect(declaredMinimum, `could not read a lower bound from engines.node: ${range}`).not.toBe(
      '',
    );
    expect(isNodeBelow(declaredMinimum, NODE_FLOOR)).toBe(false);
    expect(isNodeBelow(NODE_FLOOR, declaredMinimum)).toBe(false);
  });
});
