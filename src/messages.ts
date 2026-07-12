/** Messaging command validation, Store calls, and human/NDJSON rendering. */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { assertAgentId } from './agent-id.js';
import { CrewError } from './errors.js';
import { formatTimestamp, sanitizeHuman, writeJsonLine, writeLine } from './format.js';
import type { Io } from './io.js';
import { type InboxState, type MessageRecord, openWorkspaceStore } from './store/index.js';
import { resolveWorkspaceRoot } from './workspace.js';

const MAX_MESSAGE_CODE_POINTS = 100_000;
const MAX_MESSAGE_BYTES = MAX_MESSAGE_CODE_POINTS * 4;

export interface SendOptions {
  readonly file?: string;
  readonly replyTo?: string;
  readonly json: boolean;
}

export interface PendingOptions {
  readonly agent?: string;
  readonly summary: boolean;
  readonly limit?: string;
  readonly json: boolean;
}

export interface HistoryOptions {
  readonly agent?: string;
  readonly from?: string;
  readonly to?: string;
  readonly since?: string;
  readonly limit?: string;
  readonly json: boolean;
}

function integerOption(value: string, name: string, maximum: number): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new CrewError('USAGE', `${name} must be an integer between 1 and ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new CrewError('USAGE', `${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function messageId(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new CrewError('USAGE', 'reply-to must be a positive integer Message id');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CrewError('USAGE', 'reply-to must be a positive integer Message id');
  }
  return parsed;
}

function decodeMessage(bytes: Uint8Array, source: string): string {
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CrewError('USAGE', `${source} is not valid UTF-8`);
  }
  const length = Array.from(content).length;
  if (length < 1 || length > MAX_MESSAGE_CODE_POINTS) {
    throw new CrewError(
      'USAGE',
      'message content must be between 1 and 100000 Unicode code points',
    );
  }
  return content;
}

function readMessageFile(io: Io, path: string): string {
  const resolved = isAbsolute(path) ? path : resolve(io.cwd, path);
  let size: number;
  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) throw new CrewError('USAGE', `${path} is not a regular file`);
    size = stat.size;
  } catch (err) {
    if (err instanceof CrewError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new CrewError('NOT_FOUND', `no file at "${path}"`);
    }
    throw err;
  }
  if (size > MAX_MESSAGE_BYTES) {
    throw new CrewError('USAGE', `${path} exceeds the bounded Message input size`);
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new CrewError('NOT_FOUND', `no file at "${path}"`);
    }
    throw err;
  }
  if (bytes.byteLength > MAX_MESSAGE_BYTES) {
    throw new CrewError('USAGE', `${path} exceeds the bounded Message input size`);
  }
  return decodeMessage(bytes, path);
}

function readMessageStdin(io: Io): Promise<string> {
  return new Promise((resolveContent, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = io.stdin;
    const cleanup = (): void => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
    };
    const fail = (err: unknown): void => {
      cleanup();
      stream.pause();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onData = (chunk: string | Buffer): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_MESSAGE_BYTES) {
        fail(new CrewError('USAGE', 'stdin exceeds the bounded Message input size'));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      cleanup();
      try {
        resolveContent(decodeMessage(Buffer.concat(chunks, size), 'stdin'));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    const onError = (err: Error): void => {
      fail(err);
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.resume();
  });
}

async function sendContent(
  io: Io,
  positional: readonly string[],
  file: string | undefined,
): Promise<string> {
  if (file !== undefined && positional.length > 0) {
    throw new CrewError('USAGE', '--file and positional Message content are mutually exclusive');
  }
  if (file === undefined && positional.length === 0) {
    throw new CrewError('USAGE', 'Message content is required');
  }
  if (file === '-') return readMessageStdin(io);
  if (file !== undefined) return readMessageFile(io, file);
  const content = positional.join(' ');
  const length = Array.from(content).length;
  if (length < 1 || length > MAX_MESSAGE_CODE_POINTS) {
    throw new CrewError(
      'USAGE',
      'message content must be between 1 and 100000 Unicode code points',
    );
  }
  return content;
}

/** Parse inclusive history timestamps: safe epoch seconds or exact-second ISO-8601. */
export function parseHistoryTimestamp(value: string): number {
  if (/^-?(?:0|[1-9]\d*)$/.test(value)) {
    const seconds = Number(value);
    if (Number.isSafeInteger(seconds)) return seconds;
    throw new CrewError('USAGE', 'since epoch seconds must be a safe integer');
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|([+-])(\d{2}):(\d{2}))$/.exec(
    value,
  );
  if (match === null) {
    throw new CrewError(
      'USAGE',
      'since must be safe epoch seconds or exact-second ISO-8601 with Z or a numeric offset',
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[9] ?? 0);
  const offsetMinute = Number(match[10] ?? 0);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new CrewError('USAGE', 'since contains an invalid ISO-8601 date or offset');
  }
  const direction = match[8] === '-' ? -1 : 1;
  const offsetSeconds = direction * (offsetHour * 60 + offsetMinute) * 60;
  const seconds = date.getTime() / 1_000 - offsetSeconds;
  if (!Number.isSafeInteger(seconds)) {
    throw new CrewError('USAGE', 'since timestamp is outside the safe epoch-second range');
  }
  return seconds;
}

function messageRecord(message: MessageRecord): Record<string, unknown> {
  return {
    type: 'message',
    schema_version: 1,
    id: message.id,
    sender_id: message.senderId,
    recipient_id: message.recipientId,
    content: message.content,
    kind: message.kind,
    task_id: message.taskId,
    reply_to: message.replyTo,
    created_at: message.createdAt,
    read_at: message.readAt,
  };
}

function inboxRecord(state: InboxState): Record<string, unknown> {
  return {
    type: 'inbox_state',
    schema_version: 1,
    agent_id: state.agentId,
    unread_count: state.unreadCount,
    max_unread_id: state.maxUnreadId,
  };
}

function preview(content: string): string {
  const points = Array.from(content);
  return points.length <= 200 ? content : `${points.slice(0, 200).join('')}…`;
}

function writeHumanMessage(io: Io, message: MessageRecord, truncate: boolean): void {
  writeLine(
    io,
    `#${message.id}  ${sanitizeHuman(message.senderId)} -> ${sanitizeHuman(message.recipientId)}  ${formatTimestamp(message.createdAt)}`,
  );
  const sanitized = sanitizeHuman(message.content);
  const content = truncate ? preview(sanitized) : sanitized;
  for (const line of content.split('\n')) writeLine(io, `  ${line}`);
}

function writeMessages(
  io: Io,
  messages: readonly MessageRecord[],
  json: boolean,
  truncate: boolean,
): void {
  if (json) {
    for (const message of messages) writeJsonLine(io, messageRecord(message));
    return;
  }
  if (messages.length === 0) {
    writeLine(io, 'No messages.');
    return;
  }
  messages.forEach((message, index) => {
    if (index > 0) writeLine(io, '');
    writeHumanMessage(io, message, truncate);
  });
}

/** `crew send`: resolve bounded content, then send one direct note or broadcast. */
export async function runSend(
  io: Io,
  senderId: string,
  recipientId: string,
  positional: readonly string[],
  options: SendOptions,
): Promise<void> {
  assertAgentId(senderId);
  if (recipientId !== '@all') assertAgentId(recipientId);
  if (recipientId === '@all' && options.replyTo !== undefined) {
    throw new CrewError('USAGE', 'broadcast Messages cannot be replies');
  }
  const replyTo = options.replyTo === undefined ? undefined : messageId(options.replyTo);
  const content = await sendContent(io, positional, options.file);
  const root = resolveWorkspaceRoot(io.cwd);
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    const messages = store.sendMessages({
      senderId,
      recipientId,
      content,
      ...(replyTo !== undefined ? { replyTo } : {}),
    });
    if (recipientId === '@all' && messages.length === 0 && !options.json) {
      writeLine(io, 'Broadcast reached 0 recipients.');
    } else {
      writeMessages(io, messages, options.json, false);
    }
  } finally {
    store.close();
  }
}

/** `crew receive`: claim a bounded Inbox window and render committed rows. */
export function runReceive(
  io: Io,
  agentId: string,
  options: { limit?: string; json: boolean },
): void {
  assertAgentId(agentId);
  const limit = options.limit === undefined ? 50 : integerOption(options.limit, 'limit', 500);
  const root = resolveWorkspaceRoot(io.cwd);
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    writeMessages(io, store.receiveMessages(agentId, limit), options.json, false);
  } finally {
    store.close();
  }
}

/** `crew pending`: observe unread Messages without changing read/activity state. */
export function runPending(io: Io, options: PendingOptions): void {
  if (options.summary && options.agent === undefined) {
    throw new CrewError('USAGE', 'pending --summary requires --agent');
  }
  if (options.summary && options.limit !== undefined) {
    throw new CrewError('USAGE', 'pending --summary cannot be combined with --limit');
  }
  if (options.agent !== undefined) assertAgentId(options.agent);
  const limit = options.limit === undefined ? 50 : integerOption(options.limit, 'limit', 500);
  const root = resolveWorkspaceRoot(io.cwd);
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    if (options.summary) {
      const state = store.getPendingSummary(options.agent!);
      if (options.json) {
        writeJsonLine(io, inboxRecord(state));
      } else {
        const maximum = state.maxUnreadId === null ? 'none' : `#${state.maxUnreadId}`;
        writeLine(
          io,
          `${sanitizeHuman(state.agentId)}: ${state.unreadCount} unread; max ${maximum}`,
        );
      }
      return;
    }
    writeMessages(
      io,
      store.listPendingMessages({
        ...(options.agent !== undefined ? { agentId: options.agent } : {}),
        limit,
      }),
      options.json,
      true,
    );
  } finally {
    store.close();
  }
}

/** `crew history`: query a newest bounded window with inclusive filters. */
export function runHistory(io: Io, options: HistoryOptions): void {
  if (options.agent !== undefined) assertAgentId(options.agent);
  if (options.from !== undefined) assertAgentId(options.from);
  if (options.to !== undefined) assertAgentId(options.to);
  const since = options.since === undefined ? undefined : parseHistoryTimestamp(options.since);
  const limit = options.limit === undefined ? 100 : integerOption(options.limit, 'limit', 1_000);
  const root = resolveWorkspaceRoot(io.cwd);
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    writeMessages(
      io,
      store.listMessageHistory({
        ...(options.agent !== undefined ? { agentId: options.agent } : {}),
        ...(options.from !== undefined ? { senderId: options.from } : {}),
        ...(options.to !== undefined ? { recipientId: options.to } : {}),
        ...(since !== undefined ? { since } : {}),
        limit,
      }),
      options.json,
      true,
    );
  } finally {
    store.close();
  }
}
