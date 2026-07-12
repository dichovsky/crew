/**
 * `crew ui` CLI wiring tests (ADR-0012): the single registration reaching both
 * commander programs (FR-A11), strict `--port` validation surfacing as USAGE
 * exit 2 through `run()` (FR-U03), the successful `--json --no-open` lifecycle
 * closing via the Task 4 shutdown seam (FR-U01/U05), the browser-opener
 * default vs `--no-open` mapping, and NOT_WORKSPACE on the existing error
 * vocabulary (FR-U10). Everything drives `run(argv, io)` — the Program seam —
 * not `runUi` directly (that layer is covered by ui.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../../src/init.js';
import type { Io } from '../../../src/io.js';
import { run } from '../../../src/run.js';
import { setUiShutdownForTests } from '../../../src/ui/index.js';
import { captureIo, recordingRunProcess } from '../../helpers/io.js';

const made: string[] = [];

const URL_PATTERN = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]{64})/;

function workspace(overrides: Partial<Io> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-ui-cli-'));
  made.push(cwd);
  const capture = captureIo({ cwd, ...overrides });
  initWorkspace(capture.io, { withGuides: false, json: false });
  capture.out.length = 0;
  return { cwd, ...capture };
}

/**
 * Arm the Task 4 shutdown seam with an already-aborted signal so a CLI-driven
 * `crew ui` run starts, renders, and closes immediately instead of serving
 * until a real SIGINT — the test can never hang on the foreground loop.
 */
function armAbortedShutdown(): void {
  const controller = new AbortController();
  controller.abort();
  setUiShutdownForTests(controller.signal);
}

afterEach(() => {
  setUiShutdownForTests(undefined);
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('crew ui registration (FR-A11)', () => {
  it('appears in top-level help', async () => {
    const { io, out } = workspace();
    expect(await run(['--help'], io)).toBe(0);
    expect(out.join('')).toContain('ui');
    expect(out.join('')).toContain('Console');
  });

  it('serves its own help', async () => {
    const { io, out } = workspace();
    expect(await run(['ui', '--help'], io)).toBe(0);
    const help = out.join('');
    expect(help).toContain('--port');
    expect(help).toContain('--no-open');
    expect(help).toContain('--json');
  });

  it('rejects an unknown option, with and without --help', async () => {
    const { io, err } = workspace();
    expect(await run(['ui', '--bogus'], io)).toBe(2);
    expect(err.join('')).toContain('[USAGE]');
    err.length = 0;
    // FR-A11: help is honored only when the surrounding sequence is valid.
    expect(await run(['ui', '--bogus', '--help'], io)).toBe(2);
    expect(err.join('')).toContain('[USAGE]');
  });

  it('rejects an unexpected positional argument', async () => {
    const { io, err } = workspace();
    expect(await run(['ui', 'extra'], io)).toBe(2);
    expect(err.join('')).toContain('[USAGE]');
  });
});

describe('crew ui --port validation (FR-U03)', () => {
  it.each(['0', '65536', 'abc'])('rejects --port %s as USAGE exit 2', async (raw) => {
    const { io, err } = workspace();
    expect(await run(['ui', '--port', raw, '--no-open'], io)).toBe(2);
    expect(err.join('')).toContain('[USAGE]');
    expect(err.join('')).toContain('65535');
  });
});

describe('crew ui successful run through run()', () => {
  it('--json --no-open emits exactly one ui_started record and closes cleanly', async () => {
    const { cwd, io, out } = workspace();
    armAbortedShutdown();
    expect(await run(['ui', '--json', '--no-open'], io)).toBe(0);

    expect(out).toHaveLength(1);
    const record = JSON.parse(out[0]!) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([
      'port',
      'schema_version',
      'type',
      'url',
      'workspace',
    ]);
    expect(record['type']).toBe('ui_started');
    expect(record['schema_version']).toBe(1);
    expect(record['workspace']).toBe(join(cwd, '.crew'));
    const match = URL_PATTERN.exec(record['url'] as string);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(record['port']);

    // The lifecycle's close path ran: the bound port no longer accepts.
    await expect(fetch(record['url'] as string)).rejects.toThrow();
  });

  it('human mode opens the browser by default', async () => {
    const opener = recordingRunProcess();
    const { io, out } = workspace({ runProcess: opener.runProcess });
    armAbortedShutdown();
    expect(await run(['ui'], io)).toBe(0);

    const match = URL_PATTERN.exec(out.join(''));
    expect(match).not.toBeNull();
    expect(opener.calls).toHaveLength(1);
    expect(opener.calls[0]!.args).toEqual([match![0]]);
  });

  it('--no-open suppresses the opener without changing the output', async () => {
    const opener = recordingRunProcess();
    const { io, out } = workspace({ runProcess: opener.runProcess });
    armAbortedShutdown();
    expect(await run(['ui', '--no-open'], io)).toBe(0);
    expect(URL_PATTERN.test(out.join(''))).toBe(true);
    expect(opener.calls).toEqual([]);
  });
});

describe('crew ui error vocabulary (FR-U10)', () => {
  it('fails with NOT_WORKSPACE exit 1 outside a crew Workspace', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'crew-ui-cli-nows-'));
    made.push(cwd);
    const { io, err } = captureIo({ cwd });
    armAbortedShutdown();
    expect(await run(['ui', '--no-open'], io)).toBe(1);
    expect(err.join('')).toContain('[NOT_WORKSPACE]');
  });
});
