/**
 * The Console HTTP server (ADR-0012): a loopback-only, token-guarded
 * observation-and-action surface over the State Store. The module receives its
 * Store handle, Io, port, and per-run secret token from the caller (`crew ui`
 * owns the command lifecycle); it binds only to 127.0.0.1 (FR-U02), requires
 * the token on every request (FR-U04), and touches the Store exclusively
 * through existing domain methods (FR-U11) without ever consuming Inbox rows
 * (FR-U12).
 *
 * GETs stay read-only except `/api/peek` (an owned-session pane capture,
 * sanitized per FR-U24) and the session inventory endpoints `/api/sessions`
 * and `/api/resumable-sessions`. The write surface is EXACTLY the FR-U19
 * Operator action POSTs: `/api/messages`, `/api/tasks`,
 * `/api/tasks/:id/approve`, `/api/tasks/:id/requeue`, `/api/team/launch`,
 * `/api/team/resume`, `/api/team/stop`, `/api/prune`, and `/api/clean` —
 * each handled by `./actions.js` with the actor derived from the
 * authenticated Operator session (FR-U13/U14), guarded by the same
 * token/Host/no-store posture as every GET, and the destructive three gated
 * by the FR-U25 typed confirmation.
 *
 * Change detection is one server-side poller over the monotonic cursors of
 * `Store.getChangeSignature()` (FR-U22); connected browsers are notified with
 * SSE events plus periodic heartbeat comments (FR-U21). Both timers are
 * injectable for tests, unref'd, and cleared by `close()`.
 */
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realDelay } from '../delay.js';
import { runDoctor } from '../doctor.js';
import { CrewError, type ErrorCode } from '../errors.js';
import type { Io } from '../io.js';
import { createTmuxAdapter, type TmuxAdapter } from '../launcher/tmux.js';
import { openWorkspaceStore, type ChangeSignature } from '../store/index.js';
import { resolveWorkspaceRoot, workspacePaths } from '../workspace.js';
import * as actions from './actions.js';
import type { ActionStore } from './actions.js';
import { buildSnapshot, type SnapshotStore } from './snapshot.js';

/** Default Store poll cadence for change detection (FR-U22). */
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** Default SSE heartbeat comment cadence (FR-U21). */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * JSON action bodies above this cap are a USAGE failure. The largest
 * schema-legal payload (a 100,000-codepoint Task body, up to four UTF-8 bytes
 * each) fits comfortably; nothing legitimate approaches the cap.
 */
export const MAX_ACTION_BODY_BYTES = 1_048_576;

/**
 * The exact Store surface the server may touch: the snapshot reads, the
 * change-signature poll, and the four FR-U19 action writes. Narrowing the
 * parameter type keeps a consuming call such as `receiveMessages` a compile
 * error (FR-U11/FR-U12 boundary).
 */
export interface UiStore extends SnapshotStore, ActionStore {
  getChangeSignature(): ChangeSignature;
}

/** A reopened Store handle the server owns and must close (FR-U32 recovery). */
export type ReopenableUiStore = UiStore & { close(): void };

export interface UiServerOptions {
  readonly store: UiStore;
  readonly io: Io;
  /** TCP port to bind on 127.0.0.1; 0 selects an ephemeral port. */
  readonly port: number;
  /** The per-run secret required on every request (FR-U04). */
  readonly token: string;
  readonly pollIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  /**
   * The bundled dashboard directory served at `/` (FR-U08). Defaults to the
   * package's `dist/ui-assets`; injectable so tests point at a temp dir
   * without requiring a web build.
   */
  readonly assetsDir?: string;
  /**
   * tmux adapter for the team-launch/stop/peek routes; injectable so tests
   * drive a recording fake. Defaults to the real adapter.
   */
  readonly tmuxAdapter?: TmuxAdapter;
  /** Launch readiness-poll delay; tests inject an instant one. */
  readonly launchDelay?: (ms: number) => Promise<void>;
  /** Base argv for the launched Relay window; defaults to re-invoking this process. */
  readonly relayBin?: readonly string[];
  /**
   * FR-U32 recovery seam: attempt a fresh Store open at the same workspace
   * path (throw while it is still gone). The default refuses to CREATE state
   * — recovery means someone re-initialized the workspace, never the Console
   * conjuring an empty Store as a poll-tick side effect. Injectable for tests.
   */
  readonly reopenStore?: () => ReopenableUiStore;
}

export interface UiServer {
  /** The actually bound port (resolves an ephemeral request). */
  readonly port: number;
  /** Aborts after a successful clean response has finished writing. */
  readonly shutdown: AbortSignal;
  /** Stop poller and heartbeat, end open SSE streams, and close the server. */
  readonly close: () => Promise<void>;
}

/**
 * Fallback page for an unbuilt source checkout (no `dist/ui-assets`);
 * deliberately contains no stored content. The packaged artifact always ships
 * the bundled dashboard (`prepack` builds it), so end users never see this.
 */
const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>crew Console</title></head>
<body><h1>Console server is running</h1>
<p>The crew Console dashboard assets are not built in this checkout (run
\`npm run build\`). The JSON surface is /api/snapshot, /api/events (SSE), and
/api/health.</p></body>
</html>
`;

/** Content-Types for the file types the web build emits; others are opaque bytes. */
const ASSET_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function contentTypeFor(path: string): string {
  return ASSET_CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The packaged `dist/ui-assets` directory: walk up from this module to the
 * nearest `package.json` (the crew package root in the source, built, and
 * installed layouts alike). A checkout without built assets falls back to the
 * placeholder page at request time.
 */
function defaultAssetsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(dir, 'dist', 'ui-assets');
}

/**
 * Resolve a request path against the assets dir, rejecting anything that
 * escapes it (`..`, percent-encoded traversal, malformed encoding, NUL) —
 * normalize first, then require the resolved path to stay inside (binding
 * path-safety rule). Returns null for any rejected path.
 */
function resolveAssetPath(assetsDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relative = decoded.replace(/^\/+/, '');
  if (relative.length === 0) return null;
  const base = resolve(assetsDir);
  const candidate = resolve(base, relative);
  if (candidate !== base && !candidate.startsWith(base + sep)) return null;
  return candidate;
}

/**
 * Read a regular asset without following a symlink outside the asset root.
 * Lexical containment alone is insufficient because `stat` and `readFile`
 * follow symlinks; compare canonical paths before opening the file as well.
 */
async function readAssetFile(assetsDir: string, path: string): Promise<Buffer | null> {
  try {
    const [base, candidate] = await Promise.all([realpath(assetsDir), realpath(path)]);
    if (candidate !== base && !candidate.startsWith(base + sep)) return null;
    const stats = await stat(candidate);
    if (!stats.isFile()) return null;
    return await readFile(candidate);
  } catch {
    return null;
  }
}

/** Constant-time token comparison; a length mismatch is an ordinary miss. */
function tokenEquals(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return (
    providedBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(providedBytes, expectedBytes)
  );
}

/** True when the request carries the token as `?token=` or a Bearer header. */
function authorized(url: URL, req: IncomingMessage, token: string): boolean {
  const query = url.searchParams.get('token');
  if (query !== null && tokenEquals(query, token)) return true;
  const header = req.headers.authorization;
  return (
    header !== undefined &&
    header.startsWith('Bearer ') &&
    tokenEquals(header.slice('Bearer '.length), token)
  );
}

function sameSignature(a: ChangeSignature, b: ChangeSignature): boolean {
  return (
    a.maxMessageId === b.maxMessageId &&
    a.maxTaskEventId === b.maxTaskEventId &&
    a.maxTaskUpdatedAt === b.maxTaskUpdatedAt &&
    a.maxAgentLastSeen === b.maxAgentLastSeen &&
    a.maxAgentArchivedAt === b.maxAgentArchivedAt &&
    a.staleLeaseCount === b.staleLeaseCount &&
    a.agentMutationCursor === b.agentMutationCursor &&
    a.observableMutationCursor === b.observableMutationCursor
  );
}

function respond(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(body);
}

function respondJson(res: ServerResponse, status: number, value: unknown): void {
  respond(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function respondMethodNotAllowed(res: ServerResponse, allow: 'GET' | 'POST'): void {
  res.writeHead(405, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    Allow: allow,
  });
  res.end('method not allowed');
}

/** The GET route inventory, for 405-on-wrong-method semantics. */
const GET_PATHS: ReadonlySet<string> = new Set([
  '/',
  '/api/snapshot',
  '/api/events',
  '/api/health',
  '/api/peek',
  '/api/sessions',
  '/api/resumable-sessions',
]);

/** The POST task-action route shape: `/api/tasks/:id/approve|requeue`. */
const TASK_ACTION_ROUTE = /^\/api\/tasks\/([^/]+)\/(approve|requeue)$/;

/** The POST agent-action route shape: `/api/agents/:id/archive|restore` (FR-U36). */
const AGENT_ACTION_ROUTE = /^\/api\/agents\/([^/]+)\/(archive|restore)$/;

/** The fixed-path POST routes of the FR-U19 inventory. */
const POST_PATHS: ReadonlySet<string> = new Set([
  '/api/messages',
  '/api/tasks',
  '/api/team/launch',
  '/api/team/resume',
  '/api/team/stop',
  '/api/prune',
  '/api/clean',
]);

/** True for a member of the exhaustive FR-U19/FR-U36 POST route inventory. */
function isActionPath(pathname: string): boolean {
  return (
    POST_PATHS.has(pathname) ||
    TASK_ACTION_ROUTE.test(pathname) ||
    AGENT_ACTION_ROUTE.test(pathname)
  );
}

/**
 * Base argv for the Relay window of a Console-launched Team: re-invoke this
 * same crew build (mirrors `relayBinArgv` in `../launcher/index.ts`).
 */
function defaultRelayBin(): readonly string[] {
  const script = process.argv[1];
  return script === undefined ? ['crew'] : [process.execPath, script];
}

/** A path segment that fails percent-decoding goes to the Store raw; its id validation rejects it. */
function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * HTTP status for a failed request by ErrorCode. Codes outside the map are
 * internal failures (500); the envelope still carries the real code.
 */
const ERROR_STATUS: Partial<Record<ErrorCode, number>> = {
  USAGE: 400,
  INVALID_CONFIG: 400,
  NOT_FOUND: 404,
  TASK_CONFLICT: 409,
  AGENT_INACTIVE: 409,
  ACTIVE_AGENTS: 409,
  ALREADY_EXISTS: 409,
  TEAM_DRIFT: 409,
  DEPENDENCY_MISSING: 503,
  // A dead/replaced Store (FR-U32) matches the Console's own post-clean 503.
  STALE_STORE: 503,
};

/**
 * Buffer and parse one JSON action body under {@link MAX_ACTION_BODY_BYTES}.
 * An over-cap or unparseable body is a USAGE failure; the rest of an over-cap
 * stream is discarded (not buffered) so the 400 response can still be written.
 * An empty body parses as `{}` — the route's field validation decides whether
 * that is acceptable.
 */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.byteLength;
      if (total > MAX_ACTION_BODY_BYTES) {
        done = true;
        chunks.length = 0;
        reject(new CrewError('USAGE', `request body exceeds ${MAX_ACTION_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new CrewError('USAGE', 'request body must be valid JSON'));
      }
    });
    req.on('error', () => {
      if (done) return;
      done = true;
      reject(new CrewError('USAGE', 'request body could not be read'));
    });
  });
}

/**
 * Run the existing doctor in-process with a captured Io in JSON mode and
 * return its parsed findings and summary. Error-severity findings make
 * `runDoctor` throw after writing its records; when the summary was written
 * the findings themselves are the payload, otherwise the failure surfaces.
 */
async function collectHealth(io: Io): Promise<{
  findings: Record<string, unknown>[];
  summary: Record<string, unknown>;
}> {
  const lines: string[] = [];
  const captured: Io = {
    ...io,
    stdout: (text) => {
      lines.push(text);
    },
    stderr: () => {},
  };
  let thrown: CrewError | null = null;
  try {
    await runDoctor(captured, { system: false, json: true });
  } catch (err) {
    if (!(err instanceof CrewError)) throw err;
    thrown = err;
  }
  const records = lines
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const summary = records.find((record) => record['type'] === 'health_summary');
  if (summary === undefined) {
    throw thrown ?? new CrewError('INTEGRITY', 'doctor produced no health summary');
  }
  return {
    findings: records.filter((record) => record['type'] === 'health_finding'),
    summary,
  };
}

/** Start the Console server; resolves once it is listening on 127.0.0.1. */
export function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const { store, io, token } = options;
  if (token.length === 0) {
    throw new CrewError('USAGE', 'Console token must not be empty');
  }
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const assetsDir = options.assetsDir ?? defaultAssetsDir();
  const teamDeps: actions.TeamActionDeps = {
    io,
    adapter: options.tmuxAdapter ?? createTmuxAdapter(io),
    delay: options.launchDelay ?? realDelay,
    relayBin: options.relayBin ?? defaultRelayBin(),
  };
  const reopenStore =
    options.reopenStore ??
    ((): ReopenableUiStore => {
      const root = resolveWorkspaceRoot(io.cwd);
      // Never CREATE state from a poll tick (openWorkspaceStore would): the
      // file must have been brought back by a real re-initialization.
      if (!existsSync(workspacePaths(root).db)) {
        throw new CrewError('STALE_STORE', 'the workspace State Store has not reappeared');
      }
      const reopened = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
      // A re-initialized workspace has no operator row of its own — every
      // Console action, and the abandon-fallback authority, key on
      // this exact identity, so recovery must re-establish it here exactly
      // like Console startup does, not leave it to reappear on its own.
      try {
        actions.ensureOperatorAgent(reopened);
      } catch (err) {
        reopened.close();
        throw err;
      }
      return reopened;
    });

  // FR-U32: routes and the poller read through this handle; recovery swaps it
  // for a freshly opened Store at the same path. Handles the server itself
  // opened are closed by close(); the caller keeps owning the original.
  let liveStore: UiStore = store;
  const reopenedStores: ReopenableUiStore[] = [];
  let workspaceMissing = false;

  const sseClients = new Set<ServerResponse>();
  const terminal = new AbortController();
  let terminating = false;
  let boundPort = 0;

  function openEventStream(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    try {
      const current = liveStore.getChangeSignature();
      res.write(`event: change\ndata: ${JSON.stringify(current)}\n\n`);
    } catch {
      // Ignore reading signature failures on connection setup
    }
    sseClients.add(res);
    res.on('close', () => {
      sseClients.delete(res);
    });
  }

  function broadcast(payload: string): void {
    for (const client of sseClients) client.write(payload);
  }

  /** The FR-U19 action router: parse the capped JSON body, run the handler. */
  async function routePost(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = url.pathname;
    let action:
      ((body: unknown) => Record<string, unknown> | Promise<Record<string, unknown>>) | null = null;
    if (pathname === '/api/messages') {
      action = (body) => actions.sendMessage(liveStore, body);
    } else if (pathname === '/api/tasks') {
      action = (body) => actions.createTask(liveStore, body);
    } else if (pathname === '/api/team/launch') {
      action = (body) => actions.launchTeam(teamDeps, body);
    } else if (pathname === '/api/team/resume') {
      action = (body) => actions.resumeTeam(teamDeps, body);
    } else if (pathname === '/api/team/stop') {
      action = (body) => actions.stopTeam(teamDeps, body);
    } else if (pathname === '/api/prune') {
      action = (body) => actions.pruneWorkspace(io, body);
    } else if (pathname === '/api/clean') {
      action = (body) => actions.cleanWorkspace(io, body);
    } else {
      const taskMatch = TASK_ACTION_ROUTE.exec(pathname);
      if (taskMatch !== null) {
        const taskId = decodePathSegment(taskMatch[1]!);
        action =
          taskMatch[2] === 'approve'
            ? (body) => actions.approveTask(liveStore, taskId, body)
            : (body) => actions.requeueTask(liveStore, taskId, body);
      } else {
        const agentMatch = AGENT_ACTION_ROUTE.exec(pathname);
        if (agentMatch !== null) {
          const agentId = decodePathSegment(agentMatch[1]!);
          action =
            agentMatch[2] === 'archive'
              ? (body) => actions.archiveAgent(liveStore, agentId, body)
              : (body) => actions.restoreAgent(liveStore, agentId, body);
        }
      }
    }
    if (action === null) {
      if (GET_PATHS.has(pathname)) {
        respondMethodNotAllowed(res, 'GET');
        return;
      }
      respond(res, 404, 'text/plain; charset=utf-8', 'not found');
      return;
    }
    const body = await readJsonBody(req);
    const result = await action(body);
    if (pathname === '/api/clean') {
      // The database files are now gone. Reject every later request immediately
      // so the pre-opened Store cannot serve orphaned reads and no route can
      // implicitly recreate state. Once this response is flushed, runUi observes
      // `shutdown` and closes the HTTP server plus its owning Store connection.
      terminating = true;
      const signal = (): void => {
        terminal.abort();
      };
      res.once('finish', signal);
      res.once('close', signal);
    }
    respondJson(res, 200, { ok: true, ...result });
  }

  async function route(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'POST') {
      await routePost(url, req, res);
      return;
    }
    if (req.method !== 'GET') {
      // Neither GET nor POST: 405 on any known route, 404 elsewhere.
      if (GET_PATHS.has(url.pathname)) {
        respondMethodNotAllowed(res, 'GET');
        return;
      }
      if (isActionPath(url.pathname)) {
        respondMethodNotAllowed(res, 'POST');
        return;
      }
      respond(res, 404, 'text/plain; charset=utf-8', 'not found');
      return;
    }
    switch (url.pathname) {
      case '/': {
        // The bundled dashboard (FR-U08); an unbuilt checkout falls back to
        // the placeholder instead of erroring.
        const index = await readAssetFile(assetsDir, join(assetsDir, 'index.html'));
        if (index === null) {
          respond(res, 200, 'text/html; charset=utf-8', PLACEHOLDER_HTML);
          return;
        }
        respond(res, 200, 'text/html; charset=utf-8', index);
        return;
      }
      case '/api/snapshot':
        // Machine surface: raw stored bytes, mirroring the --json CLI contract.
        respondJson(res, 200, buildSnapshot(liveStore));
        return;
      case '/api/events':
        openEventStream(res);
        return;
      case '/api/health':
        // Liveness-gate health like every Store read: a dead store answers
        // with the STALE_STORE envelope (FR-U32), not whatever the doctor
        // happens to see in a half-deleted workspace.
        liveStore.getChangeSignature();
        respondJson(res, 200, await collectHealth(io));
        return;
      case '/api/peek': {
        // An owned-session pane capture, control-sanitized (FR-U24 — the
        // deliberate exception to the raw-bytes JSON rule; see actions.peekPane).
        const peek = await actions.peekPane(
          teamDeps,
          url.searchParams.get('session'),
          url.searchParams.get('window'),
        );
        respondJson(res, 200, { ok: true, ...peek });
        return;
      }
      case '/api/sessions': {
        // The live crew-owned tmux sessions for the Operations Teams panel.
        // Derived from the pane-map ownership proof plus tmux, never the Store,
        // so it does not liveness-gate on the Store the way snapshot/health do.
        respondJson(res, 200, { ok: true, ...(await actions.listSessions(teamDeps)) });
        return;
      }
      case '/api/resumable-sessions': {
        // Clean-stop-only sessions that still match the current Team/config.
        respondJson(res, 200, { ok: true, ...(await actions.listResumableTeamSessions(teamDeps)) });
        return;
      }
      default: {
        // A GET on a POST-only action route is a wrong method, not a miss.
        if (isActionPath(url.pathname)) {
          respondMethodNotAllowed(res, 'POST');
          return;
        }
        // Bundle files next to index.html, behind the same token/Host guards.
        const candidate = resolveAssetPath(assetsDir, url.pathname);
        const body = candidate === null ? null : await readAssetFile(assetsDir, candidate);
        if (candidate === null || body === null) {
          respond(res, 404, 'text/plain; charset=utf-8', 'not found');
          return;
        }
        respond(res, 200, contentTypeFor(candidate), body);
      }
    }
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) {
      respond(res, 403, 'text/plain; charset=utf-8', 'forbidden host');
      return;
    }
    // Node's HTTP parser accepts request targets (e.g. `//[`) that WHATWG
    // `new URL` rejects; an unguarded parse here used to escape the FR-U10
    // error mapping below and destroy the socket with no response.
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`);
    } catch {
      respondJson(res, 400, {
        ok: false,
        error: { code: 'USAGE', message: 'malformed request target' },
      });
      return;
    }
    if (!authorized(url, req, token)) {
      respond(res, 401, 'text/plain; charset=utf-8', 'missing or invalid token');
      return;
    }
    if (terminating) {
      respondJson(res, 503, {
        ok: false,
        error: { code: 'STALE_STORE', message: 'the Console is stopping after clean' },
      });
      return;
    }
    try {
      await route(url, req, res);
    } catch (err) {
      // Console failures reuse the existing ErrorCode vocabulary (FR-U10);
      // unexpected internals are not leaked to the browser.
      const failure =
        err instanceof CrewError ? err : new CrewError('INTEGRITY', 'Console request failed');
      respondJson(res, ERROR_STATUS[failure.code] ?? 500, {
        ok: false,
        error: { code: failure.code, message: failure.message },
      });
    }
  }

  const server: Server = createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      res.destroy();
    });
  });

  /**
   * FR-U32 recovery attempt: reopen at the same workspace path; on a live
   * reopen swap the serving handle, resume signature polling, and announce it.
   * While the workspace stays gone the tick is silent (missing was announced
   * exactly once when first detected).
   */
  function attemptRecovery(): void {
    let reopened: ReopenableUiStore;
    try {
      reopened = reopenStore();
    } catch {
      return;
    }
    try {
      lastSignature = reopened.getChangeSignature();
    } catch {
      // Opened but not live/usable — close it and keep waiting.
      try {
        reopened.close();
      } catch {
        /* already unusable */
      }
      return;
    }
    reopenedStores.push(reopened);
    liveStore = reopened;
    workspaceMissing = false;
    broadcast('event: workspace-restored\ndata: {"reason":"the State Store reopened"}\n\n');
  }

  let lastSignature = store.getChangeSignature();
  const pollTimer = setInterval(() => {
    if (workspaceMissing) {
      attemptRecovery();
      return;
    }
    let next: ChangeSignature;
    try {
      next = liveStore.getChangeSignature();
    } catch (err) {
      // FR-U32: an externally deleted/replaced Workspace is announced exactly
      // once, and the interval KEEPS running so reappearance is detected.
      // Any other failure just skips the tick, as before.
      if (err instanceof CrewError && err.code === 'STALE_STORE') {
        workspaceMissing = true;
        broadcast('event: workspace-missing\ndata: {"reason":"the State Store is gone"}\n\n');
      }
      return;
    }
    if (sameSignature(lastSignature, next)) return;
    lastSignature = next;
    broadcast(`event: change\ndata: ${JSON.stringify(next)}\n\n`);
  }, pollIntervalMs);
  pollTimer.unref();

  const heartbeatTimer = setInterval(() => {
    broadcast(': heartbeat\n\n');
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
    // Handles the recovery path opened belong to the server; the caller still
    // owns (and closes) the Store it originally passed in.
    while (reopenedStores.length > 0) {
      try {
        reopenedStores.pop()!.close();
      } catch {
        /* the workspace may have vanished again; nothing to release */
      }
    }
    for (const client of sseClients) client.end();
    sseClients.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
      server.closeAllConnections();
    });
  }

  return new Promise<UiServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      boundPort = (server.address() as AddressInfo).port;
      resolve({ port: boundPort, shutdown: terminal.signal, close });
    });
  });
}
