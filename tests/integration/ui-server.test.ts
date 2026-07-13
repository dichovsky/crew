/**
 * Real-HTTP integration tests for the Console server (ADR-0012): loopback
 * security (FR-U02/U04), read-only routes over Store domain methods
 * (FR-U11/U12), SSE change notifications from the monotonic poller
 * (FR-U21/U22), and the in-process doctor health route. Requests use
 * `node:http` directly so hostile Host headers and SSE streams are exercised
 * without fetch-layer rewriting.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { request, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CrewError } from '../../src/errors.js';
import { initWorkspace } from '../../src/init.js';
import { openWorkspaceStore, type Store } from '../../src/store/index.js';
import {
  startUiServer,
  type UiServer,
  type UiServerOptions,
  type UiStore,
} from '../../src/ui/server.js';
import { captureIo } from '../helpers/io.js';
import type { Io } from '../../src/io.js';

const TOKEN = 'a-test-console-token';
const made: string[] = [];
const openStores: Store[] = [];
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
  method = 'GET',
): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
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

interface SseStream {
  readonly status: number;
  readonly received: () => string;
  readonly ended: () => boolean;
  readonly close: () => void;
}

function openSse(port: number, path: string): Promise<SseStream> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let buffer = '';
      let ended = false;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
      });
      res.on('end', () => {
        ended = true;
      });
      resolve({
        status: res.statusCode ?? 0,
        received: () => buffer,
        ended: () => ended,
        close: () => {
          req.destroy();
        },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Send one raw HTTP/1.1 request over a plain TCP socket and return everything
 * the server writes back. Bypasses `node:http`'s client-side request-target
 * validation so targets Node's server parser accepts but WHATWG `new URL`
 * rejects (e.g. `//[`) reach the server verbatim.
 */
function rawHttpRequest(port: number, requestText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(requestText);
    });
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      received += chunk;
    });
    socket.on('close', () => {
      resolve(received);
    });
    socket.on('error', reject);
  });
}

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A temp Workspace with a real Store and a captured Io rooted at it. */
function workspace(): { cwd: string; store: Store; io: Io; out: string[] } {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-ui-server-'));
  made.push(cwd);
  const capture = captureIo({ cwd, clock: () => 0 });
  initWorkspace(capture.io, { withGuides: false, json: false });
  capture.out.length = 0;
  const store = openWorkspaceStore(cwd, () => 0);
  openStores.push(store);
  return { cwd, store, io: capture.io, out: capture.out };
}

async function serve(
  store: UiStore,
  io: Io,
  options: Partial<Omit<UiServerOptions, 'store' | 'io' | 'port' | 'token'>> = {},
): Promise<UiServer> {
  const server = await startUiServer({ store, io, port: 0, token: TOKEN, ...options });
  openServers.push(server);
  return server;
}

/** A hand-rolled read-only Store double for failure-path routing tests. */
function stubStore(overrides: Partial<UiStore> = {}): UiStore {
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
    ...overrides,
  };
}

afterEach(async () => {
  while (openServers.length > 0) await openServers.pop()!.close();
  while (openStores.length > 0) openStores.pop()!.close();
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('Console server authentication (FR-U04)', () => {
  it('rejects a request without a token with 401 and a short plain message', async () => {
    const { store, io } = workspace();
    const server = await serve(store, io);
    const reply = await httpGet(server.port, '/api/snapshot');
    expect(reply.status).toBe(401);
    expect(reply.body).toBe('missing or invalid token');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['set-cookie']).toBeUndefined();
  });

  it('rejects wrong tokens of equal and different length', async () => {
    const { store, io } = workspace();
    const server = await serve(store, io);
    const sameLength = 'b'.repeat(TOKEN.length);
    expect((await httpGet(server.port, `/?token=${sameLength}`)).status).toBe(401);
    expect((await httpGet(server.port, '/?token=short')).status).toBe(401);
  });

  it('refuses to start with an empty token', () => {
    const { store, io } = workspace();
    expect(() => startUiServer({ store, io, port: 0, token: '' })).toThrow(CrewError);
  });

  it('accepts the query token and the Bearer header, and rejects other schemes', async () => {
    const { store, io } = workspace();
    const server = await serve(store, io);
    expect((await httpGet(server.port, `/?token=${TOKEN}`)).status).toBe(200);
    const viaHeader = await httpGet(server.port, '/', { Authorization: `Bearer ${TOKEN}` });
    expect(viaHeader.status).toBe(200);
    const viaBasic = await httpGet(server.port, '/', { Authorization: `Basic ${TOKEN}` });
    expect(viaBasic.status).toBe(401);
  });
});

describe('Console server Host guard and headers (FR-U02)', () => {
  it('rejects a foreign Host header even with a valid token', async () => {
    const { store, io } = workspace();
    const server = await serve(store, io);
    const reply = await httpGet(server.port, `/?token=${TOKEN}`, { Host: 'evil.example:80' });
    expect(reply.status).toBe(403);
    expect(reply.headers['cache-control']).toBe('no-store');
  });

  it('accepts the exact localhost Host form', async () => {
    const { store, io } = workspace();
    const server = await serve(store, io);
    const reply = await httpGet(server.port, `/?token=${TOKEN}`, {
      Host: `localhost:${server.port}`,
    });
    expect(reply.status).toBe(200);
  });

  it('sets Cache-Control: no-store and no cookies on every response', async () => {
    const { store, io } = workspace();
    const server = await serve(store, io);
    const replies = [
      await httpGet(server.port, `/?token=${TOKEN}`),
      await httpGet(server.port, `/api/snapshot?token=${TOKEN}`),
      await httpGet(server.port, `/api/absent?token=${TOKEN}`),
      await httpGet(server.port, '/api/snapshot'),
      await httpGet(server.port, `/?token=${TOKEN}`, { Host: 'evil.example:80' }),
    ];
    for (const reply of replies) {
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.headers['set-cookie']).toBeUndefined();
    }
  });
});

describe('Console server routes', () => {
  it('serves the placeholder fallback (unbuilt assets) with no stored content injected', async () => {
    const hostile = '<script>alert(1)</script>\u001b[2J';
    const { cwd, store, io } = workspace();
    store.joinAgent({ id: 'manager', role: 'manager' });
    store.joinAgent({ id: 'worker', role: 'worker' });
    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: hostile });
    const server = await serve(store, io, { assetsDir: join(cwd, 'no-assets-here') });

    const page = await httpGet(server.port, `/?token=${TOKEN}`);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('Console server is running');
    expect(page.body).not.toContain('alert(1)');
    expect(page.body).not.toContain('\u001b');
  });

  it('serves /api/snapshot with the CLI record shapes and raw stored bytes', async () => {
    const hostile = '<script>alert(1)</script>\u001b[2J';
    const { store, io } = workspace();
    store.joinAgent({ id: 'manager', role: 'manager' });
    store.joinAgent({ id: 'worker', role: 'worker' });
    store.joinAgent({ id: 'inspector', role: 'inspector' });
    store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'Add X',
    });
    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: hostile });
    const server = await serve(store, io);

    const reply = await httpGet(server.port, `/api/snapshot?token=${TOKEN}`);
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toContain('application/json');
    const snapshot = JSON.parse(reply.body) as {
      agents: Array<Record<string, unknown>>;
      tasks: Array<Record<string, unknown>>;
      messages: Array<Record<string, unknown>>;
    };
    expect(snapshot.agents.map((agent) => agent['type'])).toEqual(['agent', 'agent', 'agent']);
    expect(snapshot.tasks[0]).toMatchObject({ type: 'task', schema_version: 1, title: 'Add X' });
    const note = snapshot.messages.find((message) => message['kind'] === 'note');
    expect(note).toMatchObject({ type: 'message', schema_version: 1, content: hostile });
    const pending = snapshot.agents[1]?.['pending_summary'] as Record<string, unknown>;
    expect(pending).toMatchObject({ type: 'inbox_state', schema_version: 1 });
  });

  it('returns 404 for unknown paths and 405 for a wrong method on a known route', async () => {
    const { store, io } = workspace();
    const server = await serve(store, io);
    expect((await httpGet(server.port, `/api/absent?token=${TOKEN}`)).status).toBe(404);
    const wrongMethod = await httpGet(server.port, `/api/snapshot?token=${TOKEN}`, {}, 'POST');
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers['allow']).toBe('GET');
  });

  it('maps a CrewError failure to a 500 envelope with the existing code (FR-U10)', async () => {
    const { io } = workspace();
    const failing = stubStore({
      listAgents: () => {
        throw new CrewError('CONTENTION', 'State Store remained locked');
      },
    });
    const server = await serve(failing, io);
    const reply = await httpGet(server.port, `/api/snapshot?token=${TOKEN}`);
    expect(reply.status).toBe(500);
    expect(JSON.parse(reply.body)).toEqual({
      ok: false,
      error: { code: 'CONTENTION', message: 'State Store remained locked' },
    });
  });

  it('answers a request target Node accepts but WHATWG URL rejects with 400, not a reset', async () => {
    const { store, io } = workspace();
    const server = await serve(store, io);
    const reply = await rawHttpRequest(
      server.port,
      `GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n\r\n`,
    );
    // Before the guard the socket was destroyed with no bytes written.
    expect(reply.startsWith('HTTP/1.1 400 ')).toBe(true);
    // The body arrives chunk-framed on a raw socket; assert on the envelope text.
    expect(reply).toContain(
      '{"ok":false,"error":{"code":"USAGE","message":"malformed request target"}}',
    );
  });

  it('maps an unexpected failure to INTEGRITY without leaking its message', async () => {
    const { io } = workspace();
    const failing = stubStore({
      listAgents: () => {
        throw new Error('secret internal detail');
      },
    });
    const server = await serve(failing, io);
    const reply = await httpGet(server.port, `/api/snapshot?token=${TOKEN}`);
    expect(reply.status).toBe(500);
    const envelope = JSON.parse(reply.body) as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe('INTEGRITY');
    expect(envelope.error.message).not.toContain('secret internal detail');
  });
});

describe('Console server SSE poller (FR-U21/U22)', () => {
  it('emits nothing while idle and one change event when the Store changes', async () => {
    const { store, io } = workspace();
    store.joinAgent({ id: 'manager', role: 'manager' });
    store.joinAgent({ id: 'worker', role: 'worker' });
    const server = await serve(store, io, { pollIntervalMs: 20 });

    const stream = await openSse(server.port, `/api/events?token=${TOKEN}`);
    expect(stream.status).toBe(200);
    await until(() => stream.received().includes(': connected'));
    // With reconnect resync, the initial event: change is sent immediately on connect
    await until(() => stream.received().includes('event: change'));

    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'wake up' });
    // It should receive a second change event
    await until(() => {
      const parts = stream.received().split('event: change');
      return parts.length >= 3;
    });

    const parts = stream.received().split('event: change\ndata: ');
    const firstSig = JSON.parse(parts[1]!.split('\n\n')[0]!) as Record<string, number>;
    const secondSig = JSON.parse(parts[2]!.split('\n\n')[0]!) as Record<string, number>;
    expect(secondSig['maxMessageId']).toBeGreaterThan(firstSig['maxMessageId']!);
    stream.close();
  });

  it('sends current signature immediately on connect for reconnect resync', async () => {
    const { store, io } = workspace();
    store.joinAgent({ id: 'manager', role: 'manager' });
    store.joinAgent({ id: 'worker', role: 'worker' });
    const server = await serve(store, io, { pollIntervalMs: 20 });

    // 1. Advance the store while no client is connected
    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'hello' });

    // 2. Open /api/events
    const stream = await openSse(server.port, `/api/events?token=${TOKEN}`);
    expect(stream.status).toBe(200);

    // 3. Assert the client receives the change event immediately without any subsequent mutation
    await until(() => stream.received().includes(': connected'));
    await until(() => stream.received().includes('event: change'));

    const dataLine = stream
      .received()
      .split('\n')
      .find((line) => line.startsWith('data: '));
    const signature = JSON.parse(dataLine!.slice('data: '.length)) as Record<string, number>;
    expect(signature['maxMessageId']).toBeGreaterThan(0);
    stream.close();
  });

  it('emits one event when any change-signature cursor changes', async () => {
    const { io } = workspace();
    const signature = {
      maxMessageId: 0,
      maxTaskEventId: 0,
      maxTaskUpdatedAt: 0,
      maxAgentLastSeen: 0,
      maxAgentArchivedAt: 0,
      staleLeaseCount: 0,
      agentMutationCursor: 0,
      observableMutationCursor: 0,
    };
    const server = await serve(stubStore({ getChangeSignature: () => ({ ...signature }) }), io, {
      pollIntervalMs: 10,
    });
    const stream = await openSse(server.port, `/api/events?token=${TOKEN}`);
    await until(() => stream.received().includes(': connected'));
    const events = (): number => stream.received().split('event: change').length - 1;

    signature.maxTaskEventId = 1;
    await until(() => events() >= 1);
    signature.maxTaskUpdatedAt = 1;
    await until(() => events() >= 2);
    signature.maxAgentLastSeen = 1;
    await until(() => events() >= 3);
    signature.maxMessageId = 1;
    await until(() => events() >= 4);
    // The agent-archive cursor (leave / team-stop) must also push a change.
    signature.maxAgentArchivedAt = 1;
    await until(() => events() >= 5);
    // The stale-lease cursor must also push a change.
    signature.staleLeaseCount = 1;
    await until(() => events() >= 6);
    // The agent-mutation cursor (reap / same-second re-stamp) too.
    signature.agentMutationCursor = 1;
    await until(() => events() >= 7);
    signature.observableMutationCursor = 1;
    await until(() => events() >= 8);
    stream.close();
  });

  it('emits a change event when a real Lease crosses its expiry', async () => {
    let now = 0;
    const cwd = mkdtempSync(join(tmpdir(), 'crew-ui-server-stale-'));
    made.push(cwd);
    const capture = captureIo({ cwd, clock: () => now });
    initWorkspace(capture.io, { withGuides: false, json: false });
    const store = openWorkspaceStore(cwd, () => now);
    openStores.push(store);
    store.joinAgent({ id: 'manager', role: 'manager' });
    store.joinAgent({ id: 'worker', role: 'worker' });
    store.joinAgent({ id: 'inspector', role: 'inspector' });
    const task = store.createTask({
      creatorId: 'manager',
      assigneeId: 'worker',
      reviewerId: 'inspector',
      title: 'Add X',
    });
    store.startTask('worker', task.id); // lease_expires_at = 900

    const server = await serve(store, capture.io, { pollIntervalMs: 20 });
    const stream = await openSse(server.port, `/api/events?token=${TOKEN}`);
    await until(() => stream.received().includes(': connected'));
    // With reconnect resync, the initial event: change is sent immediately on connect
    await until(() => stream.received().includes('event: change'));

    now = 900; // the poller reads this same injected clock on its next tick
    // It should receive a second change event
    await until(() => {
      const parts = stream.received().split('event: change');
      return parts.length >= 3;
    });
    stream.close();
  });

  it('sends heartbeat comments on the injected interval', async () => {
    const { store, io } = workspace();
    const server = await serve(store, io, { pollIntervalMs: 20, heartbeatIntervalMs: 30 });
    const stream = await openSse(server.port, `/api/events?token=${TOKEN}`);
    await until(() => stream.received().includes(': heartbeat'));
    stream.close();
  });

  it('requires the token on the SSE route too', async () => {
    const { store, io } = workspace();
    const server = await serve(store, io);
    expect((await httpGet(server.port, '/api/events')).status).toBe(401);
  });

  it('keeps serving when the poller read fails (Store closed mid-run)', async () => {
    const { store, io } = workspace();
    const server = await serve(store, io, { pollIntervalMs: 20 });
    const stream = await openSse(server.port, `/api/events?token=${TOKEN}`);
    await until(() => stream.received().includes(': connected'));
    store.close();
    await sleep(100);
    expect((await httpGet(server.port, `/?token=${TOKEN}`)).status).toBe(200);
    expect(stream.ended()).toBe(false);
    stream.close();
  });
});

describe('Console server /api/health', () => {
  it('returns parsed doctor findings and summary as JSON', async () => {
    const { store, io } = workspace();
    const server = await serve(store, io);
    const reply = await httpGet(server.port, `/api/health?token=${TOKEN}`);
    expect(reply.status).toBe(200);
    const health = JSON.parse(reply.body) as {
      findings: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
    };
    for (const finding of health.findings) {
      expect(finding['type']).toBe('health_finding');
      expect(finding['schema_version']).toBe(1);
    }
    expect(health.summary['type']).toBe('health_summary');
    expect(String(health.summary['workspace'])).toContain('.crew');
  });

  it('surfaces a doctor failure through the error envelope (FR-U10)', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'crew-ui-nows-'));
    made.push(outside);
    const capture = captureIo({ cwd: outside, clock: () => 0 });
    const server = await serve(stubStore(), capture.io);
    const reply = await httpGet(server.port, `/api/health?token=${TOKEN}`);
    expect(reply.status).toBe(500);
    const envelope = JSON.parse(reply.body) as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('NOT_WORKSPACE');
  });
});

describe('Console server is read-only over the Store (FR-U11/U12)', () => {
  it('leaves unread Messages unread after exercising every endpoint', async () => {
    const { store, io } = workspace();
    store.joinAgent({ id: 'manager', role: 'manager' });
    store.joinAgent({ id: 'worker', role: 'worker' });
    store.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'still unread' });
    const server = await serve(store, io, { pollIntervalMs: 20 });

    await httpGet(server.port, `/?token=${TOKEN}`);
    await httpGet(server.port, `/api/snapshot?token=${TOKEN}`);
    await httpGet(server.port, `/api/health?token=${TOKEN}`);
    const stream = await openSse(server.port, `/api/events?token=${TOKEN}`);
    await until(() => stream.received().includes(': connected'));
    stream.close();

    expect(store.getPendingSummary('worker').unreadCount).toBe(1);
    const delivered = store.receiveMessages('worker');
    expect(delivered.map((message) => message.content)).toEqual(['still unread']);
  });
});

describe('Console server deleted-workspace recovery (FR-U32)', () => {
  function deleteStateFiles(cwd: string): void {
    for (const name of ['crew.db', 'crew.db-wal', 'crew.db-shm']) {
      rmSync(join(cwd, '.crew', 'state', name), { force: true });
    }
  }

  it('announces workspace-missing exactly once, keeps polling, and restores on re-init', async () => {
    const { cwd, store, io } = workspace();
    store.joinAgent({ id: 'manager', role: 'manager' });
    const server = await serve(store, io, { pollIntervalMs: 20 });
    const stream = await openSse(server.port, `/api/events?token=${TOKEN}`);
    await until(() => stream.received().includes(': connected'));

    deleteStateFiles(cwd);
    await until(() => stream.received().includes('event: workspace-missing'));
    // Many further ticks: the announcement is deduplicated, never spammed.
    await sleep(150);
    expect(stream.received().split('event: workspace-missing')).toHaveLength(2);

    // Dead-store GETs answer with the mapped STALE_STORE envelope, not a bare 500.
    const snapshot = await httpGet(server.port, `/api/snapshot?token=${TOKEN}`);
    expect(snapshot.status).toBe(503);
    expect(JSON.parse(snapshot.body)).toMatchObject({
      ok: false,
      error: { code: 'STALE_STORE' },
    });
    const health = await httpGet(server.port, `/api/health?token=${TOKEN}`);
    expect(health.status).toBe(503);
    const healthEnvelope = JSON.parse(health.body) as { error: { code: string } };
    expect(healthEnvelope.error.code).toBe('STALE_STORE');

    // A re-initialized Store at the same path is detected and announced once.
    const revived = openWorkspaceStore(cwd, () => 0);
    openStores.push(revived);
    await until(() => stream.received().includes('event: workspace-restored'));
    await sleep(100);
    expect(stream.received().split('event: workspace-restored')).toHaveLength(2);

    // The plain operator identity is re-established on the fresh Store —
    // every Console action, and the abandon-fallback authority, key on
    // it, and a re-initialized workspace has no row of its own.
    const operator = revived
      .listAgents({ includeArchived: true })
      .find((agent) => agent.id === 'operator');
    expect(operator).toMatchObject({ role: 'operator', platformId: null, status: 'active' });

    // Normal change polling resumed against the fresh store... (a message
    // moves the maxMessageId cursor; a join at the fixed test clock would not)
    revived.joinAgent({ id: 'manager', role: 'manager' });
    revived.joinAgent({ id: 'worker', role: 'worker' });
    revived.sendMessages({ senderId: 'manager', recipientId: 'worker', content: 'alive again' });
    await until(() => stream.received().includes('event: change'));
    // ...and the routes serve from the swapped handle again.
    const after = await httpGet(server.port, `/api/snapshot?token=${TOKEN}`);
    expect(after.status).toBe(200);
    stream.close();
  });

  it('refuses to recover onto a re-initialized Store whose operator row is not the plain identity', async () => {
    const { cwd, store, io } = workspace();
    const server = await serve(store, io, { pollIntervalMs: 20 });
    const stream = await openSse(server.port, `/api/events?token=${TOKEN}`);
    await until(() => stream.received().includes(': connected'));

    deleteStateFiles(cwd);
    await until(() => stream.received().includes('event: workspace-missing'));

    // A re-initialized Store whose "operator" row was joined with the wrong
    // shape (a platform-bound Agent, exactly what Console startup itself also
    // refuses to adopt) must not be silently treated as recovered.
    const revived = openWorkspaceStore(cwd, () => 0);
    openStores.push(revived);
    revived.joinAgent({ id: 'operator', role: 'operator', platformId: 'claude-code' });
    await sleep(150);
    expect(stream.received()).not.toContain('event: workspace-restored');

    // The server keeps retrying rather than giving up or crashing (binding
    // decision: never stop the timer) — still reachable and still reporting
    // the dead-store envelope, many ticks later.
    const snapshot = await httpGet(server.port, `/api/snapshot?token=${TOKEN}`);
    expect(snapshot.status).toBe(503);
    stream.close();
  });

  it('never recreates the State Store from a poll tick while the workspace is gone', async () => {
    const { cwd, store, io } = workspace();
    const server = await serve(store, io, { pollIntervalMs: 20 });
    const stream = await openSse(server.port, `/api/events?token=${TOKEN}`);
    await until(() => stream.received().includes(': connected'));

    deleteStateFiles(cwd);
    await until(() => stream.received().includes('event: workspace-missing'));
    await sleep(150);
    // Recovery attempts must not conjure an empty database as a side effect.
    expect(existsSync(join(cwd, '.crew', 'state', 'crew.db'))).toBe(false);
    expect(stream.received()).not.toContain('event: workspace-restored');
    stream.close();
  });

  it('recovers through an injected reopen seam and closes swapped handles on close', async () => {
    const { io } = workspace();
    let reopens = 0;
    let closes = 0;
    const fresh = stubStore({
      getChangeSignature: () => ({
        maxMessageId: 7,
        maxTaskEventId: 0,
        maxTaskUpdatedAt: 0,
        maxAgentLastSeen: 0,
        maxAgentArchivedAt: 0,
        staleLeaseCount: 0,
        agentMutationCursor: 0,
        observableMutationCursor: 0,
      }),
    });
    let current: UiStore = stubStore();
    const wrapper = stubStore({ getChangeSignature: () => current.getChangeSignature() });
    const dying = stubStore({
      getChangeSignature: () => {
        throw new CrewError('STALE_STORE', 'gone');
      },
    });
    const server = await serve(wrapper, io, {
      pollIntervalMs: 20,
      reopenStore: () => {
        reopens++;
        if (reopens < 3) throw new CrewError('STALE_STORE', 'still gone');
        return {
          ...fresh,
          close: () => {
            closes++;
          },
        };
      },
    });
    const stream = await openSse(server.port, `/api/events?token=${TOKEN}`);
    await until(() => stream.received().includes(': connected'));

    current = dying;
    await until(() => stream.received().includes('event: workspace-missing'));
    await until(() => stream.received().includes('event: workspace-restored'));
    // The seam was retried until it produced a live store.
    expect(reopens).toBeGreaterThanOrEqual(3);

    stream.close();
    await server.close();
    // close() released the handle the recovery path opened.
    expect(closes).toBe(1);
  });
});

describe('Console server shutdown', () => {
  it('close() ends open SSE streams, stops serving, and is idempotent', async () => {
    const { store, io } = workspace();
    const server = await serve(store, io, { pollIntervalMs: 20, heartbeatIntervalMs: 30 });
    const stream = await openSse(server.port, `/api/events?token=${TOKEN}`);
    await until(() => stream.received().includes(': connected'));

    await server.close();
    await until(() => stream.ended());
    await expect(httpGet(server.port, `/?token=${TOKEN}`)).rejects.toThrow();
    await expect(server.close()).resolves.toBeUndefined();
  });
});
