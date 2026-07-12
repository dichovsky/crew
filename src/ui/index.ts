/**
 * The `crew ui` command lifecycle (ADR-0012): an explicitly Operator-started,
 * foreground-only Console (FR-U01/U07). It validates the port (random
 * available by default, explicit 1..65535 with no fallback — FR-U03), draws a
 * per-run secret token from `node:crypto` randomBytes (FR-U04; the token
 * appears only inside the printed URL), starts the Console server, renders the
 * startup result on the requested surface (FR-U09), optionally opens the URL
 * in the platform browser, and then serves until SIGINT/SIGTERM — shutting
 * down cleanly with the handlers removed (FR-U05). Failures reuse the existing
 * `ErrorCode` vocabulary (FR-U10). CLI registration lives in `src/cli.ts`.
 */
import { randomBytes } from 'node:crypto';
import { CrewError } from '../errors.js';
import { messageOf, renderUiStarted } from '../format.js';
import type { Io } from '../io.js';
import { openWorkspaceStore } from '../store/index.js';
import { resolveWorkspaceRoot, workspacePaths } from '../workspace.js';
import { ensureOperatorAgent } from './actions.js';
import { startUiServer, type UiServer } from './server.js';

/** Random bytes per run token (64 hex characters — cf. the launch-token shape). */
const TOKEN_BYTES = 32;
/** Bound on the short-lived browser-opener child; the server itself is unbounded. */
const OPENER_TIMEOUT_MS = 10_000;

/** The platform's URL opener executable: `open` on darwin, `xdg-open` otherwise. */
export function openerFor(platform: string): string {
  return platform === 'darwin' ? 'open' : 'xdg-open';
}

export interface RunUiOptions {
  /** Raw `--port` value; omitted selects a random available port (FR-U03). */
  readonly port?: string;
  /** False under `--no-open`: suppresses the browser opener only. */
  readonly open: boolean;
  readonly json: boolean;
  /** Test seam: aborting resolves the run exactly like a delivered signal. */
  readonly shutdown?: AbortSignal;
}

/**
 * Test-only seam for Program-level tests: `run(argv, io)` cannot carry an
 * AbortSignal through the command line, so a CLI-driven test arms a default
 * shutdown signal here before invoking `run`. A `runUi` call without an
 * explicit `shutdown` falls back to it. Production never sets it.
 */
let cliShutdownSeam: AbortSignal | undefined;

export function setUiShutdownForTests(signal: AbortSignal | undefined): void {
  cliShutdownSeam = signal;
}

/** Validate `--port`: default to an ephemeral bind, else strict decimal 1..65535. */
function resolvePort(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const port = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new CrewError('USAGE', '--port must be a decimal TCP port from 1 through 65535');
  }
  return port;
}

/**
 * Resolve when SIGINT/SIGTERM is delivered (or the injected seam aborts),
 * removing every handler it installed so repeated runs and tests never leak.
 */
function waitForShutdown(shutdown?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      shutdown?.removeEventListener('abort', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    if (shutdown !== undefined) {
      if (shutdown.aborted) {
        stop();
        return;
      }
      shutdown.addEventListener('abort', stop, { once: true });
    }
  });
}

/** `crew ui`: start the Console, print/emit the startup result, serve until a signal. */
export async function runUi(io: Io, options: RunUiOptions): Promise<void> {
  const port = resolvePort(options.port);
  const root = resolveWorkspaceRoot(io.cwd);
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    ensureOperatorAgent(store);
  } catch (err) {
    store.close();
    throw err;
  }
  const token = randomBytes(TOKEN_BYTES).toString('hex');

  let server: UiServer;
  try {
    server = await startUiServer({ store, io, port, token });
  } catch (err) {
    store.close();
    if (err instanceof CrewError) throw err;
    // An explicit port that is unavailable fails here — never a fallback bind
    // (FR-U03); the message carries Node's reason (e.g. EADDRINUSE).
    throw new CrewError('LAUNCH_FAILED', `Console server failed to start: ${messageOf(err)}`);
  }

  try {
    const url = `http://127.0.0.1:${server.port}/?token=${token}`;
    renderUiStarted(
      io,
      { url, port: server.port, workspace: workspacePaths(root).crew },
      options.json,
    );
    if (!options.json && options.open) {
      try {
        await io.runProcess(openerFor(process.platform), [url], { timeoutMs: OPENER_TIMEOUT_MS });
      } catch {
        // A failed browser opener must not kill the running Console (cli-contract).
      }
    }
    const requestedShutdown = options.shutdown ?? cliShutdownSeam;
    const shutdown =
      requestedShutdown === undefined
        ? server.shutdown
        : AbortSignal.any([requestedShutdown, server.shutdown]);
    await waitForShutdown(shutdown);
  } finally {
    await server.close();
    store.close();
  }
}
