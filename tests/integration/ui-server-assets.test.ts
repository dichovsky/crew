/**
 * Real-HTTP tests for the Console server's bundled-dashboard static handler
 * (FR-U08 serving side): the injectable assets directory, index.html at
 * `GET /`, bundle files by path, traversal-safe resolution (nothing outside
 * the assets dir is ever readable), the unchanged security posture on every
 * asset response (token, Host allowlist, no-store, no cookies), and the
 * placeholder fallback for an unbuilt source checkout.
 */
import { request, type IncomingHttpHeaders } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../../src/io.js';
import { startUiServer, type UiServer, type UiStore } from '../../src/ui/server.js';
import { captureIo } from '../helpers/io.js';

const TOKEN = 'assets-suite-token';
const SECRET = 'TOP-SECRET-OUTSIDE-ASSETS';
const INDEX_HTML =
  '<!doctype html><title>crew dashboard</title><script type="module" src="/main.js"></script>';
const MAIN_JS = 'console.log("dashboard-bundle");';

const made: string[] = [];
const openServers: UiServer[] = [];

interface HttpReply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function stubStore(): UiStore {
  const unusedAction = (): never => {
    throw new Error('action not stubbed');
  };
  return {
    listAgents: () => [],
    getPendingSummary: (agentId: string) => ({ agentId, unreadCount: 0, maxUnreadId: null }),
    listTasks: () => [],
    getTaskWithEvents: () => ({ task: null, events: [] }),
    listMessageHistory: () => [],
    sendMessages: unusedAction,
    createTask: unusedAction,
    approveTask: unusedAction,
    requeueTask: unusedAction,
    leaveAgent: unusedAction,
    joinAgent: unusedAction,
    getChangeSignature: () => ({
      maxMessageId: 0,
      maxTaskEventId: 0,
      maxTaskUpdatedAt: 0,
      maxAgentLastSeen: 0,
      maxAgentArchivedAt: 0,
      staleLeaseCount: 0,
      agentMutationCursor: 0,
      observableMutationCursor: 0,
    }),
  };
}

/** A built-assets layout in a temp dir, with a secret file OUTSIDE the assets dir. */
function makeAssets(): { assetsDir: string; parent: string } {
  const parent = mkdtempSync(join(tmpdir(), 'crew-ui-assets-'));
  made.push(parent);
  const assetsDir = join(parent, 'ui-assets');
  mkdirSync(join(assetsDir, 'sub'), { recursive: true });
  writeFileSync(join(assetsDir, 'index.html'), INDEX_HTML);
  writeFileSync(join(assetsDir, 'main.js'), MAIN_JS);
  writeFileSync(join(assetsDir, 'sub', 'extra.js'), 'console.log("nested");');
  writeFileSync(join(assetsDir, 'notes.txt'), 'plain-notes');
  writeFileSync(join(parent, 'secret.txt'), SECRET);
  symlinkSync(join(parent, 'secret.txt'), join(assetsDir, 'escape.txt'));
  symlinkSync(parent, join(assetsDir, 'escape-dir'));
  return { assetsDir, parent };
}

async function serveAssets(assetsDir?: string): Promise<UiServer> {
  const { io } = captureIo() as { io: Io };
  const server = await startUiServer({
    store: stubStore(),
    io,
    port: 0,
    token: TOKEN,
    ...(assetsDir !== undefined ? { assetsDir } : {}),
  });
  openServers.push(server);
  return server;
}

afterEach(async () => {
  while (openServers.length > 0) await openServers.pop()!.close();
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('Console bundled dashboard at /', () => {
  it('serves the built index.html bytes with the token and 401s without it', async () => {
    const { assetsDir } = makeAssets();
    const server = await serveAssets(assetsDir);

    const page = await httpGet(server.port, `/?token=${TOKEN}`);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['set-cookie']).toBeUndefined();
    expect(page.body).toBe(INDEX_HTML);

    const anonymous = await httpGet(server.port, '/');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).not.toContain('crew dashboard');
  });

  it('serves bundle files with extension Content-Types and the full security posture', async () => {
    const { assetsDir } = makeAssets();
    const server = await serveAssets(assetsDir);

    const bundle = await httpGet(server.port, `/main.js?token=${TOKEN}`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers['content-type']).toContain('text/javascript');
    expect(bundle.headers['cache-control']).toBe('no-store');
    expect(bundle.headers['set-cookie']).toBeUndefined();
    expect(bundle.body).toBe(MAIN_JS);

    const nested = await httpGet(server.port, `/sub/extra.js?token=${TOKEN}`);
    expect(nested.status).toBe(200);
    expect(nested.body).toContain('nested');

    // A regular file with an unmapped extension is served as opaque bytes.
    const notes = await httpGet(server.port, `/notes.txt?token=${TOKEN}`);
    expect(notes.status).toBe(200);
    expect(notes.headers['content-type']).toContain('application/octet-stream');

    expect((await httpGet(server.port, '/main.js')).status).toBe(401);
    const foreignHost = await httpGet(server.port, `/main.js?token=${TOKEN}`, {
      Host: 'evil.example:80',
    });
    expect(foreignHost.status).toBe(403);
  });

  it('rejects unknown paths, directories, and non-GET asset requests', async () => {
    const { assetsDir } = makeAssets();
    const server = await serveAssets(assetsDir);

    expect((await httpGet(server.port, `/nope.js?token=${TOKEN}`)).status).toBe(404);
    // A directory is not a regular file.
    expect((await httpGet(server.port, `/sub?token=${TOKEN}`)).status).toBe(404);
    expect((await httpGet(server.port, `/sub/?token=${TOKEN}`)).status).toBe(404);
  });
});

describe('Console asset path safety', () => {
  it('never serves content outside the assets dir for traversal attempts', async () => {
    const { assetsDir } = makeAssets();
    const server = await serveAssets(assetsDir);

    const attempts = [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/..%2fsecret.txt',
      '/%2e%2e%2fsecret.txt',
      '/sub/%2e%2e/%2e%2e/secret.txt',
      '/%2f..%2f..%2fsecret.txt',
      '/main.js%00.html',
      '/%2f%2f',
      // Lexically contained symlinks must not escape the canonical asset root.
      '/escape.txt',
      '/escape-dir/secret.txt',
    ];
    for (const path of attempts) {
      const reply = await httpGet(server.port, `${path}?token=${TOKEN}`);
      expect(reply.status, path).toBe(404);
      expect(reply.body, path).not.toContain(SECRET);
      expect(reply.headers['cache-control'], path).toBe('no-store');
    }
  });

  it('treats malformed percent-encoding as an unknown path', async () => {
    const { assetsDir } = makeAssets();
    const server = await serveAssets(assetsDir);
    expect((await httpGet(server.port, `/%zz?token=${TOKEN}`)).status).toBe(404);
  });

  it('does not follow an index.html symlink outside the assets dir', async () => {
    const { assetsDir, parent } = makeAssets();
    rmSync(join(assetsDir, 'index.html'));
    symlinkSync(join(parent, 'secret.txt'), join(assetsDir, 'index.html'));
    const server = await serveAssets(assetsDir);

    const page = await httpGet(server.port, `/?token=${TOKEN}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('Console server is running');
    expect(page.body).not.toContain(SECRET);
  });
});

describe('Console placeholder fallback (unbuilt checkout)', () => {
  it('serves the placeholder at / when the assets dir is missing', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'crew-ui-noassets-'));
    made.push(parent);
    const server = await serveAssets(join(parent, 'absent'));

    const page = await httpGet(server.port, `/?token=${TOKEN}`);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('Console server is running');
    expect((await httpGet(server.port, `/main.js?token=${TOKEN}`)).status).toBe(404);
  });

  it('serves the placeholder at / when index.html is missing from the dir', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'crew-ui-emptyassets-'));
    made.push(parent);
    const empty = join(parent, 'ui-assets');
    mkdirSync(empty);
    const server = await serveAssets(empty);

    const page = await httpGet(server.port, `/?token=${TOKEN}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain('Console server is running');
  });

  it('serves a 200 text/html page from the default package assets dir', async () => {
    const server = await serveAssets();
    // The default dir resolves under the package root; the body is the built
    // dashboard when dist/ui-assets exists and the placeholder when it does
    // not — both are valid states of a source checkout.
    const page = await httpGet(server.port, `/?token=${TOKEN}`);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['cache-control']).toBe('no-store');
  });
});
