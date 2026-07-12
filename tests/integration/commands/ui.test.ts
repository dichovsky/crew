/**
 * `crew ui` command lifecycle tests (ADR-0012): foreground start, port
 * selection without fallback (FR-U03), the per-run token appearing only inside
 * the printed URL (FR-U04), the single `ui_started` machine record (FR-U09),
 * the browser opener, clean signal-path shutdown with handler hygiene
 * (FR-U05/U07), and error mapping onto the existing vocabulary (FR-U10).
 * `runUi` is exercised directly; CLI registration lands in a later task.
 */
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewError, exitCodeForError } from '../../../src/errors.js';
import { initWorkspace } from '../../../src/init.js';
import type { Io } from '../../../src/io.js';
import { openerFor, runUi, type RunUiOptions } from '../../../src/ui/index.js';
import { captureIo, recordingRunProcess } from '../../helpers/io.js';

const made: string[] = [];

function workspace(overrides: Partial<Io> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-ui-command-'));
  made.push(cwd);
  const capture = captureIo({ cwd, ...overrides });
  initWorkspace(capture.io, { withGuides: false, json: false });
  capture.out.length = 0;
  return { cwd, ...capture };
}

const URL_PATTERN = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]{64})/;

async function fetchStatus(url: string): Promise<number> {
  const response = await fetch(url);
  await response.text();
  return response.status;
}

function startRun(io: Io, options: Omit<RunUiOptions, 'shutdown'>) {
  const controller = new AbortController();
  const done = runUi(io, { ...options, shutdown: controller.signal });
  return { controller, done };
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('crew ui human mode', () => {
  it('prints the URL, opens the browser, keeps serving, and closes cleanly', async () => {
    const opener = recordingRunProcess();
    const { io, out } = workspace({ runProcess: opener.runProcess });
    const { controller, done } = startRun(io, { open: true, json: false });
    await vi.waitFor(() => {
      expect(opener.calls).toHaveLength(1);
    });

    const match = URL_PATTERN.exec(out.join(''));
    expect(match).not.toBeNull();
    const [url, port, token] = [match![0], Number(match![1]), match![2]!];
    expect(opener.calls[0]!.file).toBe(openerFor(process.platform));
    expect(opener.calls[0]!.args).toEqual([url]);

    // The opener ran, and the server is still serving authenticated reads.
    expect(await fetchStatus(`http://127.0.0.1:${port}/api/snapshot?token=${token}`)).toBe(200);

    controller.abort();
    await expect(done).resolves.toBeUndefined();
    // Clean shutdown: the port no longer accepts connections.
    await expect(fetch(`http://127.0.0.1:${port}/?token=${token}`)).rejects.toThrow();
  });

  it('--no-open starts the server without any opener call', async () => {
    const opener = recordingRunProcess();
    const { io, out } = workspace({ runProcess: opener.runProcess });
    const { controller, done } = startRun(io, { open: false, json: false });
    await vi.waitFor(() => {
      expect(URL_PATTERN.test(out.join(''))).toBe(true);
    });

    const match = URL_PATTERN.exec(out.join(''))!;
    expect(await fetchStatus(`http://127.0.0.1:${match[1]}/api/snapshot?token=${match[2]}`)).toBe(
      200,
    );
    expect(opener.calls).toEqual([]);

    controller.abort();
    await expect(done).resolves.toBeUndefined();
  });

  it('an opener failure does not kill the running server', async () => {
    const { io, out } = workspace({
      runProcess: () => Promise.reject(new Error('spawn failed')),
    });
    const { controller, done } = startRun(io, { open: true, json: false });
    await vi.waitFor(() => {
      expect(URL_PATTERN.test(out.join(''))).toBe(true);
    });

    const match = URL_PATTERN.exec(out.join(''))!;
    expect(await fetchStatus(`http://127.0.0.1:${match[1]}/api/snapshot?token=${match[2]}`)).toBe(
      200,
    );

    controller.abort();
    await expect(done).resolves.toBeUndefined();
  });
});

describe('crew ui machine mode', () => {
  it('emits exactly one valid ui_started record, no opener call, and keeps serving', async () => {
    const opener = recordingRunProcess();
    const { cwd, io, out } = workspace({ runProcess: opener.runProcess });
    const { controller, done } = startRun(io, { open: true, json: true });
    await vi.waitFor(() => {
      expect(out).toHaveLength(1);
    });

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

    // JSON mode never opens a browser; the server continues serving after the record.
    expect(opener.calls).toEqual([]);
    expect(
      await fetchStatus(
        `http://127.0.0.1:${record['port'] as number}/api/snapshot?token=${match![2]}`,
      ),
    ).toBe(200);
    expect(out).toHaveLength(1);

    controller.abort();
    await expect(done).resolves.toBeUndefined();
  });
});

describe('crew ui port selection (FR-U03)', () => {
  it('binds exactly the explicit free port', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const { io, out } = workspace();
    const { controller, done } = startRun(io, { port: String(port), open: false, json: true });
    await vi.waitFor(() => {
      expect(out).toHaveLength(1);
    });
    expect((JSON.parse(out[0]!) as { port: number }).port).toBe(port);
    controller.abort();
    await expect(done).resolves.toBeUndefined();
  });

  it('fails without fallback when the explicit port is unavailable', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as AddressInfo).port;

    const { io, out } = workspace();
    const err = await runUi(io, { port: String(port), open: false, json: false }).catch(
      (thrown: unknown) => thrown,
    );
    expect(err).toBeInstanceOf(CrewError);
    expect((err as CrewError).code).toBe('LAUNCH_FAILED');
    expect(exitCodeForError(err)).toBe(1);
    // No fallback: nothing was printed, no other port was bound.
    expect(out).toEqual([]);

    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it.each(['0', '65536', 'abc', '-1', '1.5'])('rejects invalid --port %s as USAGE', async (raw) => {
    const { io } = workspace();
    const err = await runUi(io, { port: raw, open: false, json: false }).catch(
      (thrown: unknown) => thrown,
    );
    expect(err).toBeInstanceOf(CrewError);
    expect((err as CrewError).code).toBe('USAGE');
    expect(exitCodeForError(err)).toBe(2);
  });
});

describe('crew ui shutdown (FR-U05/FR-U07)', () => {
  it('installs SIGINT/SIGTERM handlers while serving and removes them on shutdown', async () => {
    const sigint = process.listenerCount('SIGINT');
    const sigterm = process.listenerCount('SIGTERM');
    const { io, out } = workspace();
    const { controller, done } = startRun(io, { open: false, json: true });
    await vi.waitFor(() => {
      expect(out).toHaveLength(1);
    });

    expect(process.listenerCount('SIGINT')).toBe(sigint + 1);
    expect(process.listenerCount('SIGTERM')).toBe(sigterm + 1);

    controller.abort();
    await expect(done).resolves.toBeUndefined();
    expect(process.listenerCount('SIGINT')).toBe(sigint);
    expect(process.listenerCount('SIGTERM')).toBe(sigterm);
  });

  it('an already-delivered shutdown closes the server right after startup', async () => {
    const sigint = process.listenerCount('SIGINT');
    const { io, out } = workspace();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runUi(io, { open: false, json: true, shutdown: controller.signal }),
    ).resolves.toBeUndefined();

    // Startup completed (the record was emitted) and nothing leaked behind.
    const record = JSON.parse(out[0]!) as { port: number; url: string };
    expect(process.listenerCount('SIGINT')).toBe(sigint);
    await expect(fetch(record.url)).rejects.toThrow();
  });
});

describe('crew ui error vocabulary (FR-U10)', () => {
  it('fails with NOT_WORKSPACE outside a crew Workspace', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'crew-ui-no-workspace-'));
    made.push(cwd);
    const { io } = captureIo({ cwd });
    const err = await runUi(io, { open: false, json: false }).catch((thrown: unknown) => thrown);
    expect(err).toBeInstanceOf(CrewError);
    expect((err as CrewError).code).toBe('NOT_WORKSPACE');
  });
});

describe('openerFor', () => {
  it('picks the platform opener', () => {
    expect(openerFor('darwin')).toBe('open');
    expect(openerFor('linux')).toBe('xdg-open');
  });
});
