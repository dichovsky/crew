/**
 * Real-HTTP integration tests for the 11d-2 Console routes: detached team
 * launch (FR-U20, via the noAttach seam), team stop through the live-marker
 * ownership proof (FR-U26–U29), the owned-session sanitized peek (FR-U24
 * exception), prune/clean through the CLI commands with their real guards,
 * the FR-U25 confirmation-flag gate, and the FR-U13 operator-row ensure at
 * `crew ui` startup. tmux is a recording fake injected through the server
 * options; the Store and Team config are real, in a temp Workspace.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, type IncomingHttpHeaders } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../src/init.js';
import type { Io } from '../../src/io.js';
import { createTmuxAdapter, type TmuxAdapter } from '../../src/launcher/tmux.js';
import { openWorkspaceStore, type Store } from '../../src/store/index.js';
import { OPERATOR_AGENT_ID, peekPane } from '../../src/ui/actions.js';
import { runUi } from '../../src/ui/index.js';
import { startUiServer, type UiServer } from '../../src/ui/server.js';
import { captureIo } from '../helpers/io.js';

const TOKEN = 'a-test-console-token';
const SESSION = 'crew-demo';
const ROSTER = ['manager', 'worker', 'worker-2', 'inspector'];
const LAUNCHER_YAML = `version: 1
project:
  name: crew-demo
  session_name: crew-demo
runtime:
  client: codex-cli
relay:
  enabled: true
  poll_seconds: 2
  reminder_seconds: 30
`;

const made: string[] = [];
const openStores: Store[] = [];
const openServers: UiServer[] = [];

interface HttpReply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface Envelope {
  readonly ok: boolean;
  readonly error?: { code: string; message: string };
  readonly launch?: Record<string, unknown>;
  readonly stop?: Record<string, unknown>;
  readonly peek?: Record<string, unknown>;
  readonly prune?: Record<string, unknown>;
  readonly clean?: Record<string, unknown>;
  readonly sessions?: ReadonlyArray<Record<string, unknown>>;
}

function httpSend(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {},
  method = 'POST',
): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function post(port: number, path: string, body: unknown): Promise<HttpReply> {
  return httpSend(port, `${path}?token=${TOKEN}`, JSON.stringify(body));
}

function get(port: number, path: string): Promise<HttpReply> {
  return httpSend(port, `${path}&token=${TOKEN}`, '', {}, 'GET');
}

function envelope(reply: HttpReply): Envelope {
  return JSON.parse(reply.body) as Envelope;
}

/** A Workspace with the launcher config and a fake `codex` on PATH (preflight). */
function teamWorkspace(clock: () => number = () => 0): { cwd: string; io: Io; out: string[] } {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-ui-team-'));
  made.push(cwd);
  const capture = captureIo({
    cwd,
    env: { HOME: '/home/u', PATH: join(cwd, 'fakebin') },
    clock,
  });
  initWorkspace(capture.io, { withGuides: false, json: false });
  writeFileSync(join(cwd, '.crew', 'launcher.yaml'), LAUNCHER_YAML);
  writeFileSync(join(cwd, '.crew', 'run-task.md'), '# Task\n\nDo the thing.\n');
  mkdirSync(join(cwd, 'fakebin'));
  writeFileSync(join(cwd, 'fakebin', 'codex'), '#!/bin/sh\n');
  chmodSync(join(cwd, 'fakebin', 'codex'), 0o755);
  capture.out.length = 0;
  return { cwd, io: capture.io, out: capture.out };
}

function openStore(cwd: string, clock: () => number = () => 0): Store {
  const store = openWorkspaceStore(cwd, clock);
  openStores.push(store);
  return store;
}

interface FakeTmux {
  readonly adapter: TmuxAdapter;
  readonly ops: string[];
  readonly setPresent: (value: boolean) => void;
}

/**
 * A recording fake TmuxAdapter: pasting an invocation simulates the pane's
 * `crew join` against the real Store (the team-launch-live pattern), so the
 * launch route's stage-2 gate passes on genuine registrations.
 */
function fakeTmux(
  cwd: string,
  opts: {
    capture?: string;
    hasSession?: boolean;
    captureThrows?: boolean;
    ownerMismatch?: boolean;
  } = {},
): FakeTmux {
  const ops: string[] = [];
  let paneCounter = 0;
  let pendingJoin: { id: string; role: string } | null = null;
  let launchToken: string | undefined;
  let sessionOwner: string | null = null;
  // Stateful session existence: a launch creates it, a kill removes it, so a
  // later stop on the launched session reports killed:true like real tmux.
  let sessionAlive = false;
  let present = true;
  const adapter: TmuxAdapter = {
    isPresent: () => {
      ops.push('isPresent');
      return Promise.resolve(present);
    },
    hasSession: (session) => {
      ops.push(`hasSession:${session}`);
      return Promise.resolve(opts.hasSession ?? sessionAlive);
    },
    newSession: (o) => {
      ops.push('newSession');
      sessionAlive = true;
      launchToken = o.env?.CREW_LAUNCH_TOKEN ?? launchToken;
      return Promise.resolve(`%${paneCounter++}`);
    },
    splitPane: (o) => {
      ops.push('splitPane');
      launchToken = o.env?.CREW_LAUNCH_TOKEN ?? launchToken;
      return Promise.resolve(`%${paneCounter++}`);
    },
    tileLayout: () => {
      ops.push('tileLayout');
      return Promise.resolve();
    },
    paneCommand: () => Promise.resolve('codex'),
    setSessionOwner: (_session, token) => {
      ops.push('setSessionOwner');
      sessionOwner = token;
      return Promise.resolve();
    },
    sessionOwner: () =>
      Promise.resolve(
        opts.ownerMismatch === true ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : sessionOwner,
      ),
    capturePane: (target) => {
      ops.push(`capturePane:${target}`);
      if (opts.captureThrows === true) {
        return Promise.reject(new Error("can't find pane"));
      }
      return Promise.resolve(opts.capture ?? '');
    },
    setBufferArg: (_b, content) => {
      ops.push('setBufferArg');
      const parts = content.trim().split(/\s+/);
      if (parts.length >= 3 && parts[0]?.includes('crew')) {
        pendingJoin = { role: parts[parts.length - 2]!, id: parts[parts.length - 1]! };
      }
      return Promise.resolve();
    },
    loadBufferFile: () => {
      ops.push('loadBufferFile');
      return Promise.resolve();
    },
    pasteBuffer: () => {
      ops.push('pasteBuffer');
      return Promise.resolve();
    },
    sendEnter: () => {
      ops.push('sendEnter');
      if (pendingJoin !== null) {
        const store = openWorkspaceStore(cwd, () => 0);
        try {
          store.joinAgent({
            id: pendingJoin.id,
            role: pendingJoin.role,
            ...(launchToken !== undefined ? { launchToken } : {}),
          });
        } finally {
          store.close();
        }
        pendingJoin = null;
      }
      return Promise.resolve();
    },
    newWindow: (o) => {
      ops.push(`newWindow:${o.window}`);
      return Promise.resolve(`%${paneCounter++}`);
    },
    killSession: (session) => {
      ops.push(`killSession:${session}`);
      sessionAlive = false;
      return Promise.resolve();
    },
    attach: () => {
      ops.push('attach');
      return Promise.resolve(0);
    },
  };
  return {
    adapter,
    ops,
    setPresent: (value) => {
      present = value;
    },
  };
}

async function serve(
  io: Io,
  cwd: string,
  fake: FakeTmux,
  clock: () => number = () => 0,
): Promise<{ port: number; store: Store; server: UiServer }> {
  const store = openStore(cwd, clock);
  const server = await startUiServer({
    store,
    io,
    port: 0,
    token: TOKEN,
    tmuxAdapter: fake.adapter,
    launchDelay: () => Promise.resolve(),
    relayBin: ['node', 'crew'],
  });
  openServers.push(server);
  return { port: server.port, store, server };
}

const TEAM_POSTS: ReadonlyArray<[string, Record<string, unknown>]> = [
  ['/api/team/launch', { team: 'dev' }],
  ['/api/team/stop', { session: SESSION, confirm: true }],
  ['/api/prune', { confirm: true }],
  ['/api/clean', { confirm: true }],
];

afterEach(async () => {
  while (openServers.length > 0) await openServers.pop()!.close();
  while (openStores.length > 0) openStores.pop()!.close();
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('team/maintenance routes share the security posture (FR-U02/U04)', () => {
  it('rejects every route without a token (401) and with a foreign Host (403)', async () => {
    const { cwd, io } = teamWorkspace();
    const { port } = await serve(io, cwd, fakeTmux(cwd));
    for (const [path, body] of TEAM_POSTS) {
      const noToken = await httpSend(port, path, JSON.stringify(body));
      expect(noToken.status).toBe(401);
      expect(noToken.headers['cache-control']).toBe('no-store');
      const foreignHost = await httpSend(port, `${path}?token=${TOKEN}`, JSON.stringify(body), {
        Host: 'evil.example:80',
      });
      expect(foreignHost.status).toBe(403);
    }
    expect((await httpSend(port, `/api/peek?session=${SESSION}`, '', {}, 'GET')).status).toBe(401);
    const peekForeign = await httpSend(
      port,
      `/api/peek?session=${SESSION}&token=${TOKEN}`,
      '',
      { Host: 'evil.example:80' },
      'GET',
    );
    expect(peekForeign.status).toBe(403);
  });

  it('enforces 405+Allow on wrong methods for the new routes', async () => {
    const { cwd, io } = teamWorkspace();
    const { port } = await serve(io, cwd, fakeTmux(cwd));
    const getOnLaunch = await httpSend(port, `/api/team/launch?token=${TOKEN}`, '', {}, 'GET');
    expect(getOnLaunch.status).toBe(405);
    expect(getOnLaunch.headers['allow']).toBe('POST');
    const postOnPeek = await httpSend(port, `/api/peek?token=${TOKEN}`, '{}');
    expect(postOnPeek.status).toBe(405);
    expect(postOnPeek.headers['allow']).toBe('GET');
  });

  it('rejects malformed and oversized bodies as USAGE on every POST route', async () => {
    const { cwd, io } = teamWorkspace();
    const { port } = await serve(io, cwd, fakeTmux(cwd));
    for (const [path] of TEAM_POSTS) {
      const reply = await httpSend(port, `${path}?token=${TOKEN}`, 'not json {');
      expect(reply.status).toBe(400);
      expect(envelope(reply).error?.code).toBe('USAGE');
    }
    const oversized = await httpSend(
      port,
      `/api/team/stop?token=${TOKEN}`,
      JSON.stringify({ session: 'x'.repeat(1_048_576 + 16), confirm: true }),
    );
    expect(oversized.status).toBe(400);
    expect(envelope(oversized).error?.code).toBe('USAGE');
  });
});

describe('FR-U25 confirmation flag gates stop/prune/clean', () => {
  it('rejects a missing and a non-true confirm flag with USAGE', async () => {
    const { cwd, io } = teamWorkspace();
    const { port } = await serve(io, cwd, fakeTmux(cwd));
    const cases: ReadonlyArray<[string, Record<string, unknown>]> = [
      ['/api/team/stop', { session: SESSION }],
      ['/api/prune', {}],
      ['/api/clean', {}],
    ];
    for (const [path, body] of cases) {
      const missing = await post(port, path, body);
      expect(missing.status).toBe(400);
      expect(envelope(missing).error?.code).toBe('USAGE');
      expect(envelope(missing).error?.message).toContain('confirm');
      // A non-true value (e.g. a truthy string) is not acceptance.
      const wrong = await post(port, path, { ...body, confirm: 'yes' });
      expect(wrong.status).toBe(400);
      expect(envelope(wrong).error?.code).toBe('USAGE');
    }
  });

  it('launch is unconfirmed: a confirm field is an unexpected key', async () => {
    const { cwd, io } = teamWorkspace();
    const { port } = await serve(io, cwd, fakeTmux(cwd));
    const reply = await post(port, '/api/team/launch', {
      team: 'dev',
      confirm: true,
    });
    expect(reply.status).toBe(400);
    expect(envelope(reply).error?.message).toContain('confirm');
  });
});

describe('POST /api/team/launch (FR-U20)', () => {
  it('launches the configured team DETACHED: zero attach calls, roster registered', async () => {
    const { cwd, io } = teamWorkspace();
    const fake = fakeTmux(cwd);
    const { port, store } = await serve(io, cwd, fake);

    const reply = await post(port, '/api/team/launch', { team: 'dev' });
    expect(reply.status).toBe(200);
    const body = envelope(reply);
    expect(body.ok).toBe(true);
    expect(body.launch).toMatchObject({
      type: 'launch_result',
      schema_version: 1,
      session_name: SESSION,
      panes: 4,
      relay: true,
      attached: false,
    });
    // The detached proof: the session was fully built, but attach never fired.
    expect(fake.ops).toContain('newSession');
    expect(fake.ops).toContain('newWindow:crew-relay');
    expect(fake.ops).not.toContain('attach');
    // The roster registered through the real stage-2 Store gate.
    const ids = new Set(store.listAgents().map((agent) => agent.id));
    for (const id of ROSTER) expect(ids.has(id)).toBe(true);
  });

  it('maps an unknown team to its real error without touching tmux sessions', async () => {
    const { cwd, io } = teamWorkspace();
    const fake = fakeTmux(cwd);
    const { port } = await serve(io, cwd, fake);
    const reply = await post(port, '/api/team/launch', { team: 'no-such-team' });
    expect(reply.status).toBeGreaterThanOrEqual(400);
    expect(envelope(reply).ok).toBe(false);
    expect(fake.ops).not.toContain('newSession');
  });

  it('refuses a colliding session name with ALREADY_EXISTS (409)', async () => {
    const { cwd, io } = teamWorkspace();
    const fake = fakeTmux(cwd, { hasSession: true });
    const { port } = await serve(io, cwd, fake);
    const reply = await post(port, '/api/team/launch', { team: 'dev' });
    expect(reply.status).toBe(409);
    expect(envelope(reply).error?.code).toBe('ALREADY_EXISTS');
  });

  it('refuses a worktree-enabled team launch as USAGE before any tmux operation', async () => {
    const { cwd, io } = teamWorkspace();
    writeFileSync(
      join(cwd, '.crew', 'launcher.yaml'),
      `${LAUNCHER_YAML}workspace:\n  worktree:\n    enabled: true\n    branch: crew/demo\n`,
    );
    const fake = fakeTmux(cwd);
    const { port } = await serve(io, cwd, fake);
    const reply = await post(port, '/api/team/launch', { team: 'dev' });
    expect(reply.status).toBe(400);
    expect(envelope(reply).error?.code).toBe('USAGE');
    expect(envelope(reply).error?.message).toContain('worktree');
    expect(fake.ops).not.toContain('newSession');
  });

  it('refuses a team without a manager as USAGE before any tmux session exists', async () => {
    const { cwd, io } = teamWorkspace();
    writeFileSync(
      join(cwd, '.crew', 'teams', 'pair.yaml'),
      'version: 1\nname: pair\nmembers:\n  - id: worker\n    role: worker\n    replicas: 2\n',
    );
    const fake = fakeTmux(cwd);
    const { port } = await serve(io, cwd, fake);
    const reply = await post(port, '/api/team/launch', { team: 'pair' });
    expect(reply.status).toBe(400);
    expect(envelope(reply).error?.code).toBe('USAGE');
    expect(envelope(reply).error?.message).toContain('manager');
    expect(fake.ops).not.toContain('newSession');
  });

  it('launches a team without an inspector and without a task brief', async () => {
    const { cwd, io } = teamWorkspace();
    rmSync(join(cwd, '.crew', 'run-task.md'));
    writeFileSync(
      join(cwd, '.crew', 'teams', 'duo.yaml'),
      'version: 1\nname: duo\nmembers:\n  - id: manager\n    role: manager\n  - id: worker\n    role: worker\n',
    );
    const fake = fakeTmux(cwd);
    const { port } = await serve(io, cwd, fake);
    const reply = await post(port, '/api/team/launch', { team: 'duo' });
    expect(reply.status).toBe(200);
    const body = envelope(reply);
    expect(body.ok).toBe(true);
    expect(body.launch).toMatchObject({ type: 'launch_result', session_name: SESSION });
  });
});

describe('POST /api/team/stop (FR-U26–U29 reused)', () => {
  it('refuses an unowned session with NOT_FOUND before any tmux operation', async () => {
    const { cwd, io } = teamWorkspace();
    const fake = fakeTmux(cwd);
    const { port } = await serve(io, cwd, fake);
    const reply = await post(port, '/api/team/stop', {
      session: 'someone-elses-session',
      confirm: true,
    });
    expect(reply.status).toBe(404);
    expect(envelope(reply).error?.code).toBe('NOT_FOUND');
    expect(fake.ops).toEqual([]);
  });

  it('stops a launched session, archives its agents, and stays non-consuming', async () => {
    const { cwd, io } = teamWorkspace();
    const fake = fakeTmux(cwd);
    const { port, store } = await serve(io, cwd, fake);
    // An observer outside the session, holding an unread Message.
    store.joinAgent({ id: 'observer', role: 'worker' });

    await post(port, '/api/team/launch', { team: 'dev' });
    store.sendMessages({ senderId: 'manager', recipientId: 'observer', content: 'still unread' });
    fake.ops.length = 0;

    const reply = await post(port, '/api/team/stop', {
      session: SESSION,
      confirm: true,
    });
    expect(reply.status).toBe(200);
    expect(envelope(reply).stop).toMatchObject({
      type: 'stop_result',
      schema_version: 1,
      session_name: SESSION,
      killed: true,
      agents_archived: 4,
    });
    expect(fake.ops).toContain(`killSession:${SESSION}`);
    const active = new Set(store.listAgents().map((agent) => agent.id));
    for (const id of ROSTER) expect(active.has(id)).toBe(false);
    // The unrelated observer's inbox was never consumed by the Console.
    expect(store.getPendingSummary('observer').unreadCount).toBe(1);
    expect(store.receiveMessages('observer').map((m) => m.content)).toEqual(['still unread']);
  });
});

describe('GET /api/sessions (owned live sessions for Operations)', () => {
  function getSessions(port: number): Promise<HttpReply> {
    return httpSend(port, `/api/sessions?token=${TOKEN}`, '', {}, 'GET');
  }

  it('returns an empty list when no team has been launched', async () => {
    const { cwd, io } = teamWorkspace();
    const { port } = await serve(io, cwd, fakeTmux(cwd));
    const reply = await getSessions(port);
    expect(reply.status).toBe(200);
    expect(envelope(reply).ok).toBe(true);
    expect(envelope(reply).sessions).toEqual([]);
  });

  it('lists a launched session with its pane and agent counts', async () => {
    const { cwd, io } = teamWorkspace();
    const fake = fakeTmux(cwd);
    const { port } = await serve(io, cwd, fake);
    await post(port, '/api/team/launch', { team: 'dev' });
    const reply = await getSessions(port);
    expect(reply.status).toBe(200);
    const sessions = envelope(reply).sessions!;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      type: 'session',
      schema_version: 1,
      session_name: SESSION,
      pane_count: 5, // 4 roster panes + the Relay pane
      agent_count: 4,
    });
    expect(typeof sessions[0]!['started_at']).toBe('number');
  });

  it('reports no sessions when tmux is not present to verify liveness', async () => {
    const { cwd, io } = teamWorkspace();
    const fake = fakeTmux(cwd);
    const { port } = await serve(io, cwd, fake);
    await post(port, '/api/team/launch', { team: 'dev' });
    fake.setPresent(false); // tmux vanished; liveness can no longer be proven
    const reply = await getSessions(port);
    expect(reply.status).toBe(200);
    expect(envelope(reply).sessions).toEqual([]);
  });
});

describe('GET /api/peek (FR-U24 sanitized, ownership-gated)', () => {
  it('refuses an unowned session with NOT_FOUND and never invokes capturePane', async () => {
    const { cwd, io } = teamWorkspace();
    const fake = fakeTmux(cwd, { capture: 'should never be read' });
    const { port } = await serve(io, cwd, fake);
    const reply = await get(port, `/api/peek?session=foreign-session`);
    expect(reply.status).toBe(404);
    expect(envelope(reply).error?.code).toBe('NOT_FOUND');
    expect(fake.ops.filter((op) => op.startsWith('capturePane'))).toEqual([]);
  });

  it('returns the owned pane text control-stripped (the FR-U24 JSON exception)', async () => {
    const esc = String.fromCharCode(0x1b);
    const hostile = `${esc}[2J${esc}[31mred alert${esc}[0m plain text`;
    const { cwd, io } = teamWorkspace();
    const fake = fakeTmux(cwd, { capture: hostile });
    const { port } = await serve(io, cwd, fake);
    await post(port, '/api/team/launch', { team: 'dev' }); // writes the pane-map proof

    const reply = await get(port, `/api/peek?session=${SESSION}`);
    expect(reply.status).toBe(200);
    const body = envelope(reply);
    // The capture is bound to the pane id the map recorded at launch, never
    // to a caller-supplied name (a stale-map capture cannot read a foreign
    // same-name session), and the reply names the resolved target + pane.
    expect(body.peek).toMatchObject({ target: `${SESSION}:crew` });
    const paneId = body.peek!['pane'] as string;
    expect(paneId).toMatch(/^%\d+$/);
    const text = body.peek!['text'] as string;
    expect(text).toContain('red alert');
    expect(text).toContain('plain text');
    expect(text).not.toContain(esc);
    expect(fake.ops).toContain(`capturePane:${paneId}`);
  });

  it('resolves the window parameter against the pane-map and captures its recorded pane id', async () => {
    const { cwd, io } = teamWorkspace();
    const fake = fakeTmux(cwd, { capture: 'pane says hi' });
    const { port } = await serve(io, cwd, fake);
    await post(port, '/api/team/launch', { team: 'dev' });

    const reply = await get(port, `/api/peek?session=${SESSION}&window=crew`);
    expect(reply.status).toBe(200);
    const peek = envelope(reply).peek!;
    expect(peek).toMatchObject({ target: `${SESSION}:crew` });
    expect(fake.ops).toContain(`capturePane:${peek['pane'] as string}`);
  });

  it('peeks the Relay through its recorded pane id', async () => {
    const { cwd, io } = teamWorkspace();
    const fake = fakeTmux(cwd, { capture: 'relay says hi' });
    const { port } = await serve(io, cwd, fake);
    await post(port, '/api/team/launch', { team: 'dev' });
    fake.ops.length = 0;

    const reply = await get(port, `/api/peek?session=${SESSION}&window=crew-relay`);
    expect(reply.status).toBe(200);
    const peek = envelope(reply).peek!;
    expect(peek).toMatchObject({ target: `${SESSION}:crew-relay`, text: 'relay says hi' });
    expect(fake.ops).toContain(`capturePane:${peek['pane'] as string}`);
  });

  it('reports NOT_FOUND for a window name the pane-map does not record', async () => {
    const { cwd, io } = teamWorkspace();
    const fake = fakeTmux(cwd, { capture: 'should never be read' });
    const { port } = await serve(io, cwd, fake);
    await post(port, '/api/team/launch', { team: 'dev' });
    fake.ops.length = 0;

    const reply = await get(port, `/api/peek?session=${SESSION}&window=bogus`);
    expect(reply.status).toBe(404);
    expect(envelope(reply).error?.code).toBe('NOT_FOUND');
    expect(envelope(reply).error?.message).toContain('no crew-owned window "bogus"');
    expect(fake.ops.filter((op) => op.startsWith('capturePane'))).toEqual([]);
  });

  it('reports NOT_FOUND when the recorded pane is gone (stale map, foreign same-name session)', async () => {
    const { cwd, io } = teamWorkspace();
    const fake = fakeTmux(cwd, { captureThrows: true });
    const { port } = await serve(io, cwd, fake);
    await post(port, '/api/team/launch', { team: 'dev' });

    const reply = await get(port, `/api/peek?session=${SESSION}`);
    expect(reply.status).toBe(404);
    expect(envelope(reply).error?.code).toBe('NOT_FOUND');
  });

  it('reports DEPENDENCY_MISSING when tmux disappears after launch', async () => {
    const { cwd, io } = teamWorkspace();
    const fake = fakeTmux(cwd);
    const { port } = await serve(io, cwd, fake);
    await post(port, '/api/team/launch', { team: 'dev' });
    fake.ops.length = 0;
    fake.setPresent(false);

    const reply = await get(port, `/api/peek?session=${SESSION}`);
    expect(reply.status).toBe(503);
    expect(envelope(reply).error?.code).toBe('DEPENDENCY_MISSING');
    expect(fake.ops).toEqual(['isPresent']);
  });

  it('surfaces a killed availability probe as a generic ERROR, never as missing tmux', async () => {
    const { cwd, io } = teamWorkspace();
    const fake = fakeTmux(cwd);
    const { port } = await serve(io, cwd, fake);
    await post(port, '/api/team/launch', { team: 'dev' }); // writes the pane-map proof

    // Drive the peek through the REAL adapter so the probe classification is
    // proven end-to-end for this flow: a killed `tmux -V` is an operational
    // ERROR, not "tmux is not available" and not a launch-shaped failure.
    const killedIo = captureIo({
      cwd,
      runProcess: () =>
        Promise.resolve({ status: null, stdout: '', stderr: '', killed: true, signal: 'SIGTERM' }),
    }).io;
    await expect(
      peekPane(
        {
          io: killedIo,
          adapter: createTmuxAdapter(killedIo),
          delay: () => Promise.resolve(),
          relayBin: ['node', 'crew'],
        },
        SESSION,
        null,
      ),
    ).rejects.toMatchObject({
      code: 'ERROR',
      message: 'the tmux availability probe (tmux -V) did not exit cleanly (signal SIGTERM)',
    });
  });

  it('surfaces a killed liveness check during peek as a generic ERROR, not a launch failure', async () => {
    const { cwd, io } = teamWorkspace();
    const fake = fakeTmux(cwd);
    const { port } = await serve(io, cwd, fake);
    await post(port, '/api/team/launch', { team: 'dev' }); // writes the pane-map proof

    // Probe succeeds; the has-session liveness check is killed. Pane peek is
    // not a launch, so the surfaced class must be the generic operational
    // ERROR, never LAUNCH_FAILED.
    const killedIo = captureIo({
      cwd,
      runProcess: (_file, args) =>
        args[0] === '-V'
          ? Promise.resolve({ status: 0, stdout: 'tmux 3.5a\n', stderr: '' })
          : Promise.resolve({
              status: null,
              stdout: '',
              stderr: '',
              killed: true,
              signal: 'SIGTERM',
            }),
    }).io;
    await expect(
      peekPane(
        {
          io: killedIo,
          adapter: createTmuxAdapter(killedIo),
          delay: () => Promise.resolve(),
          relayBin: ['node', 'crew'],
        },
        SESSION,
        null,
      ),
    ).rejects.toMatchObject({
      code: 'ERROR',
      message: 'tmux has-session did not exit cleanly (signal SIGTERM)',
    });
  });

  it('refuses a same-name session when its live ownership marker differs', async () => {
    const { cwd, io } = teamWorkspace();
    const fake = fakeTmux(cwd, { ownerMismatch: true, capture: 'foreign pane' });
    const { port } = await serve(io, cwd, fake);
    await post(port, '/api/team/launch', { team: 'dev' });
    fake.ops.length = 0;

    const reply = await get(port, `/api/peek?session=${SESSION}`);
    expect(reply.status).toBe(404);
    expect(envelope(reply).error?.code).toBe('NOT_FOUND');
    expect(fake.ops.filter((op) => op.startsWith('capturePane'))).toEqual([]);
  });

  it('requires the session parameter and a non-empty window', async () => {
    const { cwd, io } = teamWorkspace();
    const { port } = await serve(io, cwd, fakeTmux(cwd));
    const missing = await httpSend(port, `/api/peek?token=${TOKEN}`, '', {}, 'GET');
    expect(missing.status).toBe(400);
    expect(envelope(missing).error?.code).toBe('USAGE');
    const emptyWindow = await get(port, `/api/peek?session=${SESSION}&window=`);
    expect(emptyWindow.status).toBe(400);
  });
});

describe('POST /api/prune and /api/clean (guards reused)', () => {
  it('prunes old read Messages with the CLI defaults and reports the record', async () => {
    const HUNDRED_DAYS = 100 * 86_400;
    const { cwd, io } = teamWorkspace(() => HUNDRED_DAYS);
    // Seed at t=0: a read message (delivered) and its agents.
    const seed = openStore(cwd, () => 0);
    seed.joinAgent({ id: 'a', role: 'worker' });
    seed.joinAgent({ id: 'b', role: 'worker' });
    seed.sendMessages({ senderId: 'a', recipientId: 'b', content: 'old and read' });
    seed.receiveMessages('b');

    const { port } = await serve(io, cwd, fakeTmux(cwd), () => HUNDRED_DAYS);
    const reply = await post(port, '/api/prune', { confirm: true });
    expect(reply.status).toBe(200);
    expect(envelope(reply).prune).toMatchObject({
      type: 'prune_result',
      schema_version: 1,
      messages_deleted: 1,
      vacuumed: false,
    });
  });

  it('clean refuses with ACTIVE_AGENTS (409) while any active Agent exists', async () => {
    const { cwd, io } = teamWorkspace();
    const { port, store } = await serve(io, cwd, fakeTmux(cwd));
    store.joinAgent({ id: 'busy', role: 'worker' });
    const reply = await post(port, '/api/clean', { confirm: true });
    expect(reply.status).toBe(409);
    expect(envelope(reply).error?.code).toBe('ACTIVE_AGENTS');
    // Nothing was removed: the Store still answers.
    expect(store.listAgents().map((agent) => agent.id)).toEqual(['busy']);
  });

  it('clean removes the State Store files in an idle workspace', async () => {
    const { cwd, io } = teamWorkspace();
    const { port, server } = await serve(io, cwd, fakeTmux(cwd));
    const reply = await post(port, '/api/clean', { confirm: true });
    expect(reply.status).toBe(200);
    const clean = envelope(reply).clean!;
    expect(clean).toMatchObject({ type: 'clean_result', schema_version: 1, forced: false });
    expect((clean['removed'] as string[]).length).toBeGreaterThan(0);
    expect(existsSync(join(cwd, '.crew', 'state', 'crew.db'))).toBe(false);
    expect(server.shutdown.aborted).toBe(true);
    // No request can observe the orphaned pre-clean Store while its owner is
    // winding down; the production runUi lifecycle closes it immediately.
    const after = await post(port, '/api/prune', { confirm: true });
    expect(after.status).toBe(503);
    expect(envelope(after).error?.code).toBe('STALE_STORE');
    expect(existsSync(join(cwd, '.crew', 'state', 'crew.db'))).toBe(false);
  });

  it('clean succeeds from a real Console: the ensured operator row does not block it', async () => {
    const { cwd, io, out } = teamWorkspace();
    const done = runUi(io, { open: false, json: true });
    await vi.waitFor(() => {
      expect(out).toHaveLength(1);
    });
    const started = JSON.parse(out[0]!) as { port: number; url: string };
    const token = new URL(started.url).searchParams.get('token')!;
    const reply = await httpSend(
      started.port,
      `/api/clean?token=${token}`,
      JSON.stringify({ confirm: true }),
    );
    expect(reply.status).toBe(200);
    expect(envelope(reply).clean).toMatchObject({ type: 'clean_result', forced: false });
    await expect(done).resolves.toBeUndefined();
    expect(existsSync(join(cwd, '.crew', 'state', 'crew.db'))).toBe(false);
    await expect(fetch(started.url)).rejects.toThrow();
  });

  it('clean still refuses for OTHER active Agents and restores the operator row', async () => {
    const { cwd, io } = teamWorkspace();
    const { port, store } = await serve(io, cwd, fakeTmux(cwd));
    store.joinAgent({ id: OPERATOR_AGENT_ID, role: 'operator' });
    store.joinAgent({ id: 'busy', role: 'worker' });
    const reply = await post(port, '/api/clean', { confirm: true });
    expect(reply.status).toBe(409);
    expect(envelope(reply).error?.code).toBe('ACTIVE_AGENTS');
    // The guard held for the other Agent AND the Console's own actor is back.
    const active = store.listAgents().map((agent) => agent.id);
    expect(active).toContain('busy');
    expect(active).toContain(OPERATOR_AGENT_ID);
  });
});

describe('crew ui ensures the operator Agent row at startup (FR-U13)', () => {
  const URL_PATTERN = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]{64})/;

  async function startAndStopUi(io: Io, out: string[]): Promise<void> {
    const controller = new AbortController();
    const done = runUi(io, { open: false, json: false, shutdown: controller.signal });
    await vi.waitFor(() => {
      expect(URL_PATTERN.test(out.join(''))).toBe(true);
    });
    controller.abort();
    await done;
  }

  function uiWorkspace(): { cwd: string; io: Io; out: string[] } {
    const cwd = mkdtempSync(join(tmpdir(), 'crew-ui-operator-'));
    made.push(cwd);
    const capture = captureIo({ cwd });
    initWorkspace(capture.io, { withGuides: false, json: false });
    capture.out.length = 0;
    return { cwd, io: capture.io, out: capture.out };
  }

  it('creates the plain operator row (platform NULL) in a fresh workspace', async () => {
    const { cwd, io, out } = uiWorkspace();
    await startAndStopUi(io, out);
    const store = openStore(cwd);
    const operator = store.listAgents().find((agent) => agent.id === OPERATOR_AGENT_ID);
    expect(operator).toMatchObject({
      id: OPERATOR_AGENT_ID,
      role: 'operator',
      platformId: null,
      status: 'active',
    });
  });

  it('is idempotent: a restart neither duplicates nor suffixes the row', async () => {
    const { cwd, io, out } = uiWorkspace();
    await startAndStopUi(io, out);
    out.length = 0;
    await startAndStopUi(io, out);
    const store = openStore(cwd);
    const operators = store
      .listAgents({ includeArchived: true })
      .filter((agent) => agent.id.startsWith(OPERATOR_AGENT_ID));
    expect(operators).toHaveLength(1);
    expect(operators[0]).toMatchObject({ id: OPERATOR_AGENT_ID, status: 'active' });
  });

  it('reactivates an archived operator row instead of suffixing a new id', async () => {
    const { cwd, io, out } = uiWorkspace();
    await startAndStopUi(io, out);
    const store = openStore(cwd);
    store.leaveAgent(OPERATOR_AGENT_ID);
    out.length = 0;
    await startAndStopUi(io, out);
    const operators = store
      .listAgents({ includeArchived: true })
      .filter((agent) => agent.id.startsWith(OPERATOR_AGENT_ID));
    expect(operators).toHaveLength(1);
    expect(operators[0]).toMatchObject({ id: OPERATOR_AGENT_ID, status: 'active' });
  });

  it('refuses to adopt an existing "operator" id that is not the plain operator row', async () => {
    const { cwd, io, out } = uiWorkspace();
    const store = openStore(cwd);
    // Someone joined a WORKER as "operator": Console actions must never run
    // under an identity the Operator did not create.
    store.joinAgent({ id: OPERATOR_AGENT_ID, role: 'worker' });
    await expect(
      runUi(io, { open: false, json: false, shutdown: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    // The foreign row was left exactly as it was — no silent adoption.
    expect(out.join('')).not.toMatch(URL_PATTERN);
    expect(store.listAgents().find((agent) => agent.id === OPERATOR_AGENT_ID)).toMatchObject({
      role: 'worker',
      status: 'active',
    });
  });
});
