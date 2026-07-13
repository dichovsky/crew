/**
 * Real-HTTP integration tests for the Console Operator action routes
 * (FR-U13–U19): the four POST routes over a real Store in a temp Workspace.
 * Every route is proven behind the 11c security posture (401 without token,
 * 403 foreign Host, no-store, no cookies), validated at the boundary (USAGE on
 * malformed/oversized/impersonating bodies), authority-checked in the Store
 * (non-reviewer approve → TASK_CONFLICT), and re-proven NON-CONSUMING after
 * every successful POST — a recipient's unread Inbox stays claimable.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { request, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../../src/init.js';
import { openWorkspaceStore, type Store, type TaskRecord } from '../../src/store/index.js';
import { OPERATOR_AGENT_ID } from '../../src/ui/actions.js';
import { MAX_ACTION_BODY_BYTES, startUiServer, type UiServer } from '../../src/ui/server.js';
import { captureIo } from '../helpers/io.js';
import type { Io } from '../../src/io.js';

const TOKEN = 'a-test-console-token';
const HOSTILE = '<script>alert(1)</script>[2J';
const ABSENT_UUID = '00000000-0000-4000-8000-000000000000';
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
  readonly messages?: Array<Record<string, unknown>>;
  readonly task?: Record<string, unknown>;
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

function post(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<HttpReply> {
  return httpSend(port, `${path}?token=${TOKEN}`, JSON.stringify(body), headers);
}

function envelope(reply: HttpReply): Envelope {
  return JSON.parse(reply.body) as Envelope;
}

/** A temp Workspace with a real Store, the standard roster, and a running server. */
async function actionWorkspace(): Promise<{ store: Store; io: Io; port: number }> {
  const cwd = mkdtempSync(join(tmpdir(), 'crew-ui-actions-'));
  made.push(cwd);
  const capture = captureIo({ cwd, clock: () => 0 });
  initWorkspace(capture.io, { withGuides: false, json: false });
  const store = openWorkspaceStore(cwd, () => 0);
  openStores.push(store);
  store.joinAgent({ id: OPERATOR_AGENT_ID, role: 'operator' });
  store.joinAgent({ id: 'manager', role: 'manager' });
  store.joinAgent({ id: 'worker', role: 'worker' });
  store.joinAgent({ id: 'inspector', role: 'inspector' });
  const server = await startUiServer({ store, io: capture.io, port: 0, token: TOKEN });
  openServers.push(server);
  return { store, io: capture.io, port: server.port };
}

/** A Task submitted by `worker`, ready for review by its `reviewer`. */
function submittedTask(store: Store, reviewer: string, creator = 'manager'): TaskRecord {
  const task = store.createTask({
    creatorId: creator,
    assigneeId: 'worker',
    reviewerId: reviewer,
    title: 'reviewed work',
  });
  store.startTask('worker', task.id);
  return store.submitTask('worker', task.id, 'done');
}

/** The non-consuming proof (FR-U12): the Agent's unread Inbox is still claimable. */
function expectStillClaimable(store: Store, agentId: string, atLeast: number): void {
  expect(store.getPendingSummary(agentId).unreadCount).toBeGreaterThanOrEqual(atLeast);
  expect(store.receiveMessages(agentId).length).toBeGreaterThanOrEqual(atLeast);
}

const ACTION_PATHS = (taskId: string): string[] => [
  '/api/messages',
  '/api/tasks',
  `/api/tasks/${taskId}/approve`,
  `/api/tasks/${taskId}/requeue`,
  `/api/agents/${ABSENT_UUID}/archive`,
  `/api/agents/${ABSENT_UUID}/restore`,
];

afterEach(async () => {
  while (openServers.length > 0) await openServers.pop()!.close();
  while (openStores.length > 0) openStores.pop()!.close();
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('Console action routes share the GET security posture (FR-U02/U04)', () => {
  it('rejects every action POST without a token with 401 and no-store', async () => {
    const { port } = await actionWorkspace();
    for (const path of ACTION_PATHS(ABSENT_UUID)) {
      const reply = await httpSend(port, path, JSON.stringify({}));
      expect(reply.status).toBe(401);
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.headers['set-cookie']).toBeUndefined();
    }
  });

  it('rejects every action POST with a foreign Host even with a valid token', async () => {
    const { port } = await actionWorkspace();
    for (const path of ACTION_PATHS(ABSENT_UUID)) {
      const reply = await post(port, path, {}, { Host: 'evil.example:80' });
      expect(reply.status).toBe(403);
      expect(reply.headers['cache-control']).toBe('no-store');
    }
  });

  it('accepts the Bearer header on a POST and sets no-store on success and failure', async () => {
    const { store, port } = await actionWorkspace();
    const ok = await httpSend(
      port,
      '/api/messages',
      JSON.stringify({ to: 'worker', content: 'hi' }),
      { Authorization: `Bearer ${TOKEN}` },
    );
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.headers['set-cookie']).toBeUndefined();
    const failed = await post(port, '/api/messages', { to: 'worker' });
    expect(failed.status).toBe(400);
    expect(failed.headers['cache-control']).toBe('no-store');
    expectStillClaimable(store, 'worker', 1);
  });
});

describe('Console action route and method semantics (FR-U19)', () => {
  it('returns 404 for a POST to an unknown route', async () => {
    const { port } = await actionWorkspace();
    expect((await post(port, '/api/absent', {})).status).toBe(404);
    expect((await post(port, '/api/tasks/not-nested/rename', {})).status).toBe(404);
  });

  it('returns 405 with Allow for a wrong method on a known route', async () => {
    const { port } = await actionWorkspace();
    const getOnAction = await httpSend(port, `/api/messages?token=${TOKEN}`, '', {}, 'GET');
    expect(getOnAction.status).toBe(405);
    expect(getOnAction.headers['allow']).toBe('POST');
    const getOnTaskAction = await httpSend(
      port,
      `/api/tasks/${ABSENT_UUID}/approve?token=${TOKEN}`,
      '',
      {},
      'GET',
    );
    expect(getOnTaskAction.status).toBe(405);
    const postOnRoot = await httpSend(port, `/?token=${TOKEN}`, '{}');
    expect(postOnRoot.status).toBe(405);
    expect(postOnRoot.headers['allow']).toBe('GET');
    const putOnAction = await httpSend(port, `/api/messages?token=${TOKEN}`, '{}', {}, 'PUT');
    expect(putOnAction.status).toBe(405);
    expect(putOnAction.headers['allow']).toBe('POST');
    const deleteOnGet = await httpSend(port, `/api/snapshot?token=${TOKEN}`, '', {}, 'DELETE');
    expect(deleteOnGet.status).toBe(405);
    expect(deleteOnGet.headers['allow']).toBe('GET');
    expect((await httpSend(port, `/api/absent?token=${TOKEN}`, '', {}, 'PATCH')).status).toBe(404);
  });
});

describe('Console action body validation (USAGE at the boundary)', () => {
  it('rejects a malformed JSON body on every action route with a USAGE envelope', async () => {
    const { store, port } = await actionWorkspace();
    const task = submittedTask(store, OPERATOR_AGENT_ID);
    for (const path of ACTION_PATHS(task.id)) {
      const reply = await httpSend(port, `${path}?token=${TOKEN}`, 'not json {');
      expect(reply.status).toBe(400);
      expect(envelope(reply)).toMatchObject({ ok: false, error: { code: 'USAGE' } });
    }
  });

  it('rejects a non-object JSON body and an unexpected field', async () => {
    const { port } = await actionWorkspace();
    for (const body of ['[1,2]', '"text"', '42']) {
      const reply = await httpSend(port, `/api/messages?token=${TOKEN}`, body);
      expect(reply.status).toBe(400);
      expect(envelope(reply).error?.code).toBe('USAGE');
    }
    const extra = await post(port, '/api/messages', { to: 'worker', content: 'x', evil: true });
    expect(extra.status).toBe(400);
    expect(envelope(extra).error?.message).toContain('evil');
  });

  it('rejects a body over the size cap with USAGE before any Store call', async () => {
    const { store, port } = await actionWorkspace();
    const oversized = JSON.stringify({
      to: 'worker',
      content: 'x'.repeat(MAX_ACTION_BODY_BYTES + 1),
    });
    const reply = await httpSend(port, `/api/messages?token=${TOKEN}`, oversized);
    expect(reply.status).toBe(400);
    expect(envelope(reply)).toMatchObject({ ok: false, error: { code: 'USAGE' } });
    expect(store.getPendingSummary('worker').unreadCount).toBe(0);
  });

  it('rejects a client-supplied identity that is not the operator on every route', async () => {
    const { store, port } = await actionWorkspace();
    const task = submittedTask(store, OPERATOR_AGENT_ID);
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['/api/messages', { from: 'manager', to: 'worker', content: 'x' }],
      ['/api/tasks', { creator: 'manager', assignee: 'worker', reviewer: 'inspector', title: 't' }],
      [`/api/tasks/${task.id}/approve`, { actor: 'inspector' }],
      [`/api/tasks/${task.id}/requeue`, { actor: 'manager', reason: 'r' }],
      [`/api/agents/worker/archive`, { actor: 'manager', confirm: true }],
      [`/api/agents/worker/restore`, { actor: 'manager' }],
    ];
    for (const [path, body] of attempts) {
      const reply = await post(port, path, body);
      expect(reply.status).toBe(400);
      expect(envelope(reply).error?.code).toBe('USAGE');
    }
    // The task and the agent are untouched by the rejected impersonation attempts.
    expect(store.getTask(task.id)?.status).toBe('submitted');
    expect(store.getAgent('worker')?.status).toBe('active');
  });
});

describe('POST /api/messages (FR-U14)', () => {
  it('sends a note from the operator, preserves raw bytes, and stays non-consuming', async () => {
    const { store, port } = await actionWorkspace();
    const reply = await post(port, '/api/messages', { to: 'worker', content: HOSTILE });
    expect(reply.status).toBe(200);
    const body = envelope(reply);
    expect(body.ok).toBe(true);
    expect(body.messages).toHaveLength(1);
    expect(body.messages![0]).toMatchObject({
      type: 'message',
      schema_version: 1,
      sender_id: OPERATOR_AGENT_ID,
      recipient_id: 'worker',
      content: HOSTILE,
      kind: 'note',
      read_at: null,
    });
    expectStillClaimable(store, 'worker', 1);
  });

  it('accepts an explicit from equal to the operator and a numeric replyTo', async () => {
    const { store, port } = await actionWorkspace();
    const [inbound] = store.sendMessages({
      senderId: 'manager',
      recipientId: OPERATOR_AGENT_ID,
      content: 'question',
    });
    const reply = await post(port, '/api/messages', {
      from: OPERATOR_AGENT_ID,
      to: 'manager',
      content: 'answer',
      replyTo: inbound!.id,
    });
    expect(reply.status).toBe(200);
    expect(envelope(reply).messages![0]).toMatchObject({ reply_to: inbound!.id });
    expectStillClaimable(store, 'manager', 1);
  });

  it('rejects missing fields and a non-numeric replyTo as USAGE', async () => {
    const { port } = await actionWorkspace();
    expect((await post(port, '/api/messages', { content: 'x' })).status).toBe(400);
    expect((await post(port, '/api/messages', { to: 'worker' })).status).toBe(400);
    expect((await post(port, '/api/messages', { to: 42, content: 'x' })).status).toBe(400);
    const badReply = await post(port, '/api/messages', {
      to: 'worker',
      content: 'x',
      replyTo: 'one',
    });
    expect(badReply.status).toBe(400);
    expect(envelope(badReply).error?.code).toBe('USAGE');
  });

  it('surfaces Store authority failures with their real codes and statuses', async () => {
    const { store, port } = await actionWorkspace();
    const missing = await post(port, '/api/messages', { to: 'ghost', content: 'x' });
    expect(missing.status).toBe(404);
    expect(envelope(missing).error?.code).toBe('NOT_FOUND');
    store.leaveAgent('worker');
    const archived = await post(port, '/api/messages', { to: 'worker', content: 'x' });
    expect(archived.status).toBe(409);
    expect(envelope(archived).error?.code).toBe('AGENT_INACTIVE');
    store.leaveAgent(OPERATOR_AGENT_ID);
    const inactiveSender = await post(port, '/api/messages', { to: 'manager', content: 'x' });
    expect(inactiveSender.status).toBe(409);
    expect(envelope(inactiveSender).error?.code).toBe('AGENT_INACTIVE');
  });
});

describe('POST /api/tasks (FR-U15)', () => {
  it('creates a queued Task with the operator as creator and any reviewer', async () => {
    const { store, port } = await actionWorkspace();
    const reply = await post(port, '/api/tasks', {
      assignee: 'worker',
      reviewer: 'inspector',
      title: 'Add X',
      body: HOSTILE,
    });
    expect(reply.status).toBe(200);
    const body = envelope(reply);
    expect(body.ok).toBe(true);
    expect(body.task).toMatchObject({
      type: 'task',
      schema_version: 1,
      creator_id: OPERATOR_AGENT_ID,
      assignee_id: 'worker',
      reviewer_id: 'inspector',
      status: 'queued',
      title: 'Add X',
      body: HOSTILE,
    });
    // The assignee's task_assigned notification stays unread and claimable.
    expectStillClaimable(store, 'worker', 1);
  });

  it('accepts an explicit creator equal to the operator and defaults the body', async () => {
    const { port } = await actionWorkspace();
    const reply = await post(port, '/api/tasks', {
      creator: OPERATOR_AGENT_ID,
      assignee: 'worker',
      reviewer: OPERATOR_AGENT_ID,
      title: 'self-reviewed',
    });
    expect(reply.status).toBe(200);
    expect(envelope(reply).task).toMatchObject({ body: '', reviewer_id: OPERATOR_AGENT_ID });
  });

  it('rejects a non-string optional body as USAGE', async () => {
    const { port } = await actionWorkspace();
    const reply = await post(port, '/api/tasks', {
      assignee: 'worker',
      reviewer: 'inspector',
      title: 'typed wrong',
      body: 123,
    });
    expect(reply.status).toBe(400);
    const parsed = envelope(reply);
    expect(parsed.error?.code).toBe('USAGE');
    expect(parsed.error?.message).toBe('"body" must be a string');
  });

  it('rejects missing required fields as USAGE and unknown agents as NOT_FOUND', async () => {
    const { port } = await actionWorkspace();
    const missingTitle = await post(port, '/api/tasks', {
      assignee: 'worker',
      reviewer: 'manager',
    });
    expect(missingTitle.status).toBe(400);
    expect(envelope(missingTitle).error?.code).toBe('USAGE');
    const ghost = await post(port, '/api/tasks', {
      assignee: 'ghost',
      reviewer: 'manager',
      title: 't',
    });
    expect(ghost.status).toBe(404);
    expect(envelope(ghost).error?.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/tasks/:id/approve (FR-U16)', () => {
  it('approves a Submission when the operator is the reviewer, non-consuming', async () => {
    const { store, port } = await actionWorkspace();
    const task = submittedTask(store, OPERATOR_AGENT_ID);
    const reply = await post(port, `/api/tasks/${task.id}/approve`, { summary: 'ship it' });
    expect(reply.status).toBe(200);
    expect(envelope(reply).task).toMatchObject({
      id: task.id,
      status: 'completed',
      review_summary: 'ship it',
    });
    // worker holds the assignment + approval notifications, still unread.
    expectStillClaimable(store, 'worker', 1);
  });

  it('approves with an empty body (summary omitted)', async () => {
    const { store, port } = await actionWorkspace();
    const task = submittedTask(store, OPERATOR_AGENT_ID);
    const reply = await httpSend(port, `/api/tasks/${task.id}/approve?token=${TOKEN}`, '');
    expect(reply.status).toBe(200);
    expect(envelope(reply).task).toMatchObject({ status: 'completed', review_summary: null });
  });

  it('rejects a non-reviewer approve as TASK_CONFLICT with a 409 envelope', async () => {
    const { store, port } = await actionWorkspace();
    const task = submittedTask(store, 'inspector');
    const reply = await post(port, `/api/tasks/${task.id}/approve`, {});
    expect(reply.status).toBe(409);
    expect(envelope(reply)).toMatchObject({ ok: false, error: { code: 'TASK_CONFLICT' } });
    expect(store.getTask(task.id)?.status).toBe('submitted');
  });

  it('maps an unknown Task to NOT_FOUND and a malformed id to USAGE', async () => {
    const { port } = await actionWorkspace();
    const absent = await post(port, `/api/tasks/${ABSENT_UUID}/approve`, {});
    expect(absent.status).toBe(404);
    expect(envelope(absent).error?.code).toBe('NOT_FOUND');
    const malformed = await post(port, '/api/tasks/not-a-uuid/approve', {});
    expect(malformed.status).toBe(400);
    expect(envelope(malformed).error?.code).toBe('USAGE');
    const encoded = await post(port, '/api/tasks/%zz/approve', {});
    expect(encoded.status).toBe(400);
  });
});

describe('POST /api/tasks/:id/requeue (FR-U17)', () => {
  it('requeues a Submission with a mandatory reason, non-consuming', async () => {
    const { store, port } = await actionWorkspace();
    const task = submittedTask(store, OPERATOR_AGENT_ID);
    const reply = await post(port, `/api/tasks/${task.id}/requeue`, { reason: 'needs tests' });
    expect(reply.status).toBe(200);
    expect(envelope(reply).task).toMatchObject({ id: task.id, status: 'queued' });
    expect((envelope(reply).task!['revision'] as number) > task.revision).toBe(true);
    expectStillClaimable(store, 'worker', 1);
  });

  it('reassigns with the optional to field', async () => {
    const { store, port } = await actionWorkspace();
    const task = submittedTask(store, OPERATOR_AGENT_ID);
    const reply = await post(port, `/api/tasks/${task.id}/requeue`, {
      reason: 'route to manager',
      to: 'manager',
    });
    expect(reply.status).toBe(200);
    expect(envelope(reply).task).toMatchObject({ status: 'queued', assignee_id: 'manager' });
  });

  it('rejects a missing reason as USAGE without touching the Task', async () => {
    const { store, port } = await actionWorkspace();
    const task = submittedTask(store, OPERATOR_AGENT_ID);
    const reply = await post(port, `/api/tasks/${task.id}/requeue`, {});
    expect(reply.status).toBe(400);
    expect(envelope(reply).error?.code).toBe('USAGE');
    expect(store.getTask(task.id)?.status).toBe('submitted');
  });

  it('rejects an operator who is neither creator nor reviewer as TASK_CONFLICT', async () => {
    const { store, port } = await actionWorkspace();
    const task = submittedTask(store, 'inspector');
    const reply = await post(port, `/api/tasks/${task.id}/requeue`, { reason: 'not mine' });
    expect(reply.status).toBe(409);
    expect(envelope(reply)).toMatchObject({ ok: false, error: { code: 'TASK_CONFLICT' } });
  });
});

describe('POST /api/agents/:id/archive (FR-U36)', () => {
  it('archives an active agent with confirm:true, mirroring `crew leave`', async () => {
    const { store, port } = await actionWorkspace();
    const reply = await post(port, '/api/agents/worker/archive', { confirm: true });
    expect(reply.status).toBe(200);
    const body = envelope(reply) as unknown as { agent?: Record<string, unknown> };
    expect(body.agent).toMatchObject({ type: 'agent', id: 'worker', status: 'archived' });
    expect(store.getAgent('worker')?.status).toBe('archived');
  });

  it('rejects a missing or non-true confirm as USAGE without archiving', async () => {
    const { store, port } = await actionWorkspace();
    for (const confirm of [undefined, false, 'true']) {
      const body: Record<string, unknown> = {};
      if (confirm !== undefined) body['confirm'] = confirm;
      const reply = await post(port, '/api/agents/worker/archive', body);
      expect(reply.status).toBe(400);
      expect(envelope(reply).error?.code).toBe('USAGE');
    }
    expect(store.getAgent('worker')?.status).toBe('active');
  });

  it('refuses to archive the operator itself as USAGE', async () => {
    const { store, port } = await actionWorkspace();
    const reply = await post(port, `/api/agents/${OPERATOR_AGENT_ID}/archive`, { confirm: true });
    expect(reply.status).toBe(400);
    expect(envelope(reply).error?.code).toBe('USAGE');
    expect(store.getAgent(OPERATOR_AGENT_ID)?.status).toBe('active');
  });

  it('maps an unknown agent to NOT_FOUND', async () => {
    const { port } = await actionWorkspace();
    const reply = await post(port, `/api/agents/${ABSENT_UUID}/archive`, { confirm: true });
    expect(reply.status).toBe(404);
    expect(envelope(reply).error?.code).toBe('NOT_FOUND');
  });

  it('maps an already-archived agent to AGENT_INACTIVE with a 409', async () => {
    const { store, port } = await actionWorkspace();
    store.leaveAgent('worker');
    const reply = await post(port, '/api/agents/worker/archive', { confirm: true });
    expect(reply.status).toBe(409);
    expect(envelope(reply).error?.code).toBe('AGENT_INACTIVE');
  });
});

describe('POST /api/agents/:id/restore (FR-U36)', () => {
  it('restores an archived agent with no confirmation required, mirroring `crew join --resume`', async () => {
    const { store, port } = await actionWorkspace();
    store.leaveAgent('worker');
    const reply = await post(port, '/api/agents/worker/restore', {});
    expect(reply.status).toBe(200);
    const body = envelope(reply) as unknown as { agent?: Record<string, unknown> };
    expect(body.agent).toMatchObject({ type: 'agent', id: 'worker', status: 'active' });
    expect(store.getAgent('worker')?.status).toBe('active');
  });

  it('preserves the stored role and platform on restore', async () => {
    const { store, port } = await actionWorkspace();
    store.joinAgent({ id: 'coder', role: 'worker', platformId: 'codex-cli' });
    store.leaveAgent('coder');
    const reply = await post(port, '/api/agents/coder/restore', {});
    expect(reply.status).toBe(200);
    expect(envelope(reply)).toMatchObject({
      ok: true,
      agent: { role: 'worker', platform_id: 'codex-cli', status: 'active' },
    });
  });

  it('maps an unknown agent to NOT_FOUND', async () => {
    const { port } = await actionWorkspace();
    const reply = await post(port, `/api/agents/${ABSENT_UUID}/restore`, {});
    expect(reply.status).toBe(404);
    expect(envelope(reply).error?.code).toBe('NOT_FOUND');
  });

  it('maps an already-active agent to ALREADY_EXISTS with a 409', async () => {
    const { port } = await actionWorkspace();
    const reply = await post(port, '/api/agents/worker/restore', {});
    expect(reply.status).toBe(409);
    expect(envelope(reply).error?.code).toBe('ALREADY_EXISTS');
  });
});

describe('Console action stream resilience', () => {
  it('keeps serving after a client aborts mid-body', async () => {
    const { port } = await actionWorkspace();
    await new Promise<void>((resolve) => {
      const req = request({
        host: '127.0.0.1',
        port,
        path: `/api/messages?token=${TOKEN}`,
        method: 'POST',
        headers: { 'Content-Length': '1000000' },
      });
      req.on('error', () => resolve());
      req.write('{"to":"worker","content":"');
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 25);
    });
    const after = await post(port, '/api/messages', { to: 'worker', content: 'still alive' });
    expect(after.status).toBe(200);
  });
});
