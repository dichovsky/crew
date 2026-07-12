/**
 * Output rendering for crew: the human and NDJSON surfaces plus the JSON error
 * envelope. All writes go through the injected {@link Io} sinks so output is
 * captured in tests. JSON serialization escapes control characters but never
 * rewrites stored content (FR-J11); stream separation is the caller's choice of
 * sink (FR-J05).
 */
import { CrewError, type ErrorCode } from './errors.js';
import type { Io } from './io.js';
import type { ClientSource } from './launcher/config.js';
import type { LaunchAssembly, LaunchPlan } from './launcher/plan.js';

export interface ErrorEnvelope {
  readonly ok: false;
  readonly error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

/** Coerce any throwable to a human string (Error message, else String()). */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const ESC = 0x1b;
const BEL = 0x07;
const TAB = 0x09;
const LF = 0x0a;

/** Skip one ANSI escape sequence starting at the ESC at `start`; return the next index. */
function skipEscape(text: string, start: number): number {
  const next = text.charCodeAt(start + 1);
  if (next === 0x5b /* [ */) {
    // CSI: parameter/intermediate bytes then a final byte in 0x40-0x7E.
    let i = start + 2;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      i++;
      if (c >= 0x40 && c <= 0x7e) break;
    }
    return i;
  }
  if (next === 0x5d /* ] */) {
    // OSC: runs until BEL or ST (ESC \).
    let i = start + 2;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === BEL) return i + 1;
      if (c === ESC && text.charCodeAt(i + 1) === 0x5c) return i + 2;
      i++;
    }
    return i;
  }
  // Lone ESC or unsupported escape: drop only the ESC.
  return start + 1;
}

/**
 * True for a Unicode bidirectional formatting control: LRM/RLM (`U+200E`/`U+200F`),
 * the embeddings/overrides (`U+202A`–`U+202E`), and the isolates (`U+2066`–`U+2069`).
 * These reorder displayed text without changing bytes (the "Trojan Source" vector), so
 * a user-controlled path or stored string could visually forge or reorder a crew line
 * even after C0/C1/ANSI stripping. Zero-width joiners are deliberately NOT stripped —
 * they carry legitimate meaning (emoji, some scripts) and do not reorder text.
 */
function isBidiControl(code: number): boolean {
  return (
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Strip ANSI escape sequences, C0/C1 control characters (except tab and newline),
 * and Unicode bidirectional formatting controls from text destined for the human
 * (terminal) surface, so stored or untrusted content cannot manipulate the terminal,
 * reorder its display, or impersonate crew output (FR-J08). JSON output keeps the raw
 * bytes (FR-J11).
 */
export function sanitizeHuman(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === ESC) {
      i = skipEscape(text, i);
      continue;
    }
    const isControl =
      (code <= 0x1f && code !== TAB && code !== LF) || (code >= 0x7f && code <= 0x9f);
    if (!isControl && !isBidiControl(code)) {
      out += text[i];
    }
    i++;
  }
  return out;
}

const REDACTED = '[REDACTED]';
/**
 * Cap on a single redacted string so an oversized config body is never echoed.
 * Applied to the input BEFORE any pattern runs (the output is capped regardless),
 * so a user-controlled error value cannot drive a large scan through the patterns
 * below — the FR-J14 redaction path must not be a denial-of-service vector.
 */
const MAX_REDACTED_LENGTH = 2048;

// Credential-named `key = value` / `key: value` pairs. The key run is matched in a
// single left-to-right pass (each character is consumed once; the separator+value
// group is OPTIONAL, so a long hyphen/underscore run with no separator still just
// advances) — a non-secret key like `a-a-a-…` cannot force quadratic backtracking.
// The value (double-quoted with spaces, single-quoted, or a bare token) is masked
// only when the key ENDS WITH a credential word — bare or namespaced, so
// `launch_token`, `CREW_LAUNCH_TOKEN`, `signing_key`, and `db_credential` all match
// while `monkey`/`author` do not. The credential-word set mirrors the name-based
// env-guardrail set documented in security.md (FR-J14).
const KEYED_PAIR =
  /([A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?)((\s*[=:]\s*)(?:"([^"]*)"|'([^']*)'|([^\s",;]+)))?/g;
const CREDENTIAL_KEY =
  /(?:^|[_-])(?:api[-_]?key|access[-_]?key|client[-_]?secret|secret|token|password|passwd|pwd|authorization|bearer|credential|session|cookie|private|auth|pat|key)$/i;

// Connection-string credentials: `scheme://[user][:password]@host` (a tokenized git
// remote or database URL). The credential before `@` is masked while the scheme,
// optional user, and host are preserved. The username and its colon are optional, so
// user-less forms common to Redis/Mongo are also covered: `scheme://:password@host`
// and `scheme://password@host` (connection strings).
const CONNECTION_CRED = /([a-z][a-z0-9+.-]*:\/\/(?:[^\s:/@]*:)?)([^\s/@]+)(@)/gi;

/** Opaque secret-like tokens masked whole (security.md FR-J14 redaction rule). */
const TOKEN_PATTERNS: readonly RegExp[] = [
  // Common provider token prefixes (sk-, ghp_, xoxb-, ...).
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gi,
  // AWS access key id.
  /\bAKIA[0-9A-Z]{12,}\b/g,
  // JWTs: three base64url segments after an `eyJ` header.
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  // Unbroken run of 20+ alphanumeric characters (security.md threshold). The
  // alphabet is deliberately alphanumeric only: adding the base64 `+`/`/` or
  // base64url `-`/`_` symbols would let this rule swallow filesystem paths and URLs
  // that legitimately appear in error text (a long `a/b/c…` path segment), so a
  // symbol-bearing base64 secret is instead caught when it appears as a keyed value
  // or connection credential rather than by this standalone backstop (security.md).
  /\b[A-Za-z0-9]{20,}\b/g,
];

/**
 * Mask token/key-like substrings so error output never leaks secrets (FR-J14),
 * and cap the length so an oversized config body is not echoed. Pure: returns a
 * new string. Applied only to error rendering; record output is never rewritten.
 */
export function redactSecrets(text: string): string {
  // Bound the input up front so no pattern below can be driven into a large scan by
  // a user-controlled value; the output is capped regardless (FR-J14 DoS guard).
  const overLimit = text.length > MAX_REDACTED_LENGTH;
  let out = overLimit ? text.slice(0, MAX_REDACTED_LENGTH) : text;
  out = out.replace(
    KEYED_PAIR,
    (
      match: string,
      key: string,
      pair: string | undefined,
      sep: string,
      dq: string | undefined,
      sq: string | undefined,
    ) => {
      if (pair === undefined || !CREDENTIAL_KEY.test(key)) return match;
      const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : '';
      return `${key}${sep}${quote}${REDACTED}${quote}`;
    },
  );
  out = out.replace(CONNECTION_CRED, (_match, prefix: string, _pw: string, at: string) => {
    return `${prefix}${REDACTED}${at}`;
  });
  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  if (overLimit || out.length > MAX_REDACTED_LENGTH) {
    out = out.slice(0, MAX_REDACTED_LENGTH) + '…[truncated]';
  }
  return out;
}

/** Recursively redact string leaves of an error-details value into a new value. */
function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactValue(item),
      ]),
    );
  }
  return value;
}

/** Build the stable `{ok:false,error:{...}}` envelope for any throwable. */
export function errorEnvelope(err: unknown): ErrorEnvelope {
  if (err instanceof CrewError) {
    const error: ErrorEnvelope['error'] = { code: err.code, message: err.message };
    if (err.details !== undefined) {
      error.details = err.details;
    }
    return { ok: false, error };
  }
  return { ok: false, error: { code: 'ERROR', message: messageOf(err) } };
}

/** Write an error to stderr as `[CODE] message` (human) or one JSON object (machine).
 * Secrets are redacted on both surfaces (FR-J14). */
export function writeError(io: Io, err: unknown, json: boolean): void {
  if (json) {
    const envelope = errorEnvelope(err);
    const redacted: ErrorEnvelope = {
      ok: false,
      error: {
        code: envelope.error.code,
        message: redactSecrets(envelope.error.message),
        ...(envelope.error.details !== undefined
          ? { details: redactValue(envelope.error.details) as Record<string, unknown> }
          : {}),
      },
    };
    io.stderr(JSON.stringify(redacted) + '\n');
    return;
  }
  const code = err instanceof CrewError ? err.code : 'ERROR';
  const rawMsg = messageOf(err);
  const formatted = redactSecrets(rawMsg);
  // Single-line surface: humanCell strips terminal/bidi controls (like
  // sanitizeHuman) AND escapes newlines/tabs, so a file-controlled message
  // (e.g. an unknown-key name) cannot forge a following stderr line.
  io.stderr(`[${code}] ${humanCell(formatted)}\n`);
}

/** Write one NDJSON record to stdout. */
export function writeJsonLine(io: Io, record: unknown): void {
  io.stdout(JSON.stringify(record) + '\n');
}

/** Write one human-readable line to stdout. */
export function writeLine(io: Io, text: string): void {
  io.stdout(text + '\n');
}

/** Emit the stable human or NDJSON result for `crew team stop`. */
export function renderTeamStopResult(
  io: Io,
  result: {
    readonly sessionName: string;
    readonly killed: boolean;
    readonly agentsArchived: number;
  },
  json: boolean,
): void {
  if (json) {
    writeJsonLine(io, {
      type: 'stop_result',
      schema_version: 1,
      session_name: result.sessionName,
      killed: result.killed,
      agents_archived: result.agentsArchived,
    });
    return;
  }
  writeLine(
    io,
    `Stopped ${sanitizeHuman(result.sessionName)}; archived ${result.agentsArchived} Agents.`,
  );
}

/** Emit the stable human or NDJSON result for `crew team resume`. */
export function renderTeamResumeResult(
  io: Io,
  result: {
    readonly sessionName: string;
    readonly panes: number;
    readonly relay: boolean;
    readonly attached: boolean;
  },
  json: boolean,
): void {
  if (json) {
    writeJsonLine(io, {
      type: 'resume_result',
      schema_version: 1,
      session_name: result.sessionName,
      panes: result.panes,
      relay: result.relay,
      attached: result.attached,
    });
    return;
  }
  writeLine(
    io,
    `Resumed session ${sanitizeHuman(result.sessionName)} (${result.panes} panes, relay ${result.relay ? 'on' : 'off'}).`,
  );
}

/** The `crew ui` startup facts rendered on both surfaces (FR-U09). */
export interface UiStartedResult {
  /** Authenticated loopback URL embedding the per-run token (never a separate field). */
  readonly url: string;
  readonly port: number;
  /** The resolved `.crew` Workspace path. */
  readonly workspace: string;
}

/** Emit the stable human or NDJSON startup result for `crew ui` (FR-U09). */
export function renderUiStarted(io: Io, result: UiStartedResult, json: boolean): void {
  if (json) {
    writeJsonLine(io, {
      type: 'ui_started',
      schema_version: 1,
      url: result.url,
      port: result.port,
      workspace: result.workspace,
    });
    return;
  }
  writeLine(
    io,
    `Console listening at ${sanitizeHuman(result.url)} (workspace ${sanitizeHuman(result.workspace)})`,
  );
  writeLine(
    io,
    "The URL embeds this run's secret token — do not share it. Ctrl-C stops the server.",
  );
}

/**
 * Render a stored epoch-second timestamp as UTC ISO-8601 for the human surface
 * (cli-contract.md). Timestamps are stored as whole seconds, so the always-zero
 * millisecond field is trimmed (`…:00Z`, not `…:00.000Z`) to match the contract's
 * shown format. The single source of truth for every command's timestamp column.
 */
export function formatTimestamp(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * Sanitize a persisted value for a single-line human cell: strip terminal/bidi
 * controls (FR-J08) and render tabs/newlines literally so a stored string cannot
 * inject escapes, forge a following line, or break a table row. JSON keeps the
 * raw bytes (FR-J11).
 */
export function humanCell(value: string): string {
  return sanitizeHuman(value).replaceAll('\t', '\\t').replaceAll('\n', '\\n');
}

/**
 * Write a left-aligned text table: each column is padded to the widest cell
 * (header or value), columns are joined by two spaces, and trailing padding is
 * trimmed. Callers render the empty case (e.g. "No agents.") before calling.
 * Invariant: every row must have exactly `headers.length` cells (the width is
 * caller-enforced, not encoded in the type).
 */
export function writeTable(
  io: Io,
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): void {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  );
  const render = (row: readonly string[]): string =>
    row
      .map((value, index) => value.padEnd(widths[index]!))
      .join('  ')
      .trimEnd();
  writeLine(io, render(headers));
  for (const row of rows) writeLine(io, render(row));
}

/**
 * Canonically serialize a {@link LaunchPlan}: the keys are already in
 * configuration.md order, so a stable 2-space indent plus a trailing newline
 * makes one string that is byte-identical for both `--print --json` stdout and
 * the `launch-plan.json` file (the single source — no fixture drift).
 */
export function serializeLaunchPlan(plan: LaunchPlan): string {
  return JSON.stringify(plan, null, 2) + '\n';
}

/** Write the launch plan as one canonical JSON object (the `--print --json` surface). */
export function writeLaunchPlanJson(io: Io, plan: LaunchPlan): void {
  io.stdout(serializeLaunchPlan(plan));
}

const CLIENT_SOURCE_LABEL: Record<ClientSource, string> = {
  flag: '--client',
  config: 'runtime.client',
  default: 'default',
};

/** Canonical role order for the pane-count breakdown; other roles append in first-seen order. */
const ROLE_ORDER = ['manager', 'worker', 'inspector'];

function paneBreakdown(roster: LaunchPlan['roster']): string {
  const counts = new Map<string, number>();
  for (const entry of roster) counts.set(entry.role, (counts.get(entry.role) ?? 0) + 1);
  const roles = [...counts.keys()].sort((a, b) => {
    const ia = ROLE_ORDER.indexOf(a);
    const ib = ROLE_ORDER.indexOf(b);
    return (ia === -1 ? ROLE_ORDER.length : ia) - (ib === -1 ? ROLE_ORDER.length : ib);
  });
  const parts = roles.map((role) => `${counts.get(role)} ${role}`);
  return `Panes: ${parts.join(' + ')} = ${roster.length}`;
}

function writePathBlock(io: Io, label: string, paths: readonly string[]): void {
  writeLine(io, `${label}:`);
  if (paths.length === 0) {
    writeLine(io, '  (none)');
    return;
  }
  for (const path of paths) writeLine(io, `  - ${sanitizeHuman(path)}`);
}

/**
 * Render the compact `--print` human summary: session, resolved
 * client+executable with provenance, the INTENDED worktree (no created/reused
 * verdict — that is a launch-time fact), relay, a pane-count line, the roster,
 * focus paths, constraints, the Task brief as METADATA ONLY (path + line count,
 * never the body), the artifacts list, and the schema version. All stored
 * strings pass through {@link sanitizeHuman}.
 */
export function renderLaunchPlanHuman(io: Io, assembly: LaunchAssembly): void {
  const { plan, clientSource, brief } = assembly;
  writeLine(io, `LAUNCH PLAN ${plan.team} (session ${plan.session_name})`);
  writeLine(
    io,
    `Client: ${plan.client} (${plan.executable}) [source: ${CLIENT_SOURCE_LABEL[clientSource]}]`,
  );
  if (plan.worktree.enabled) {
    writeLine(
      io,
      `Worktree: ${sanitizeHuman(plan.worktree.path ?? '')} branch=${sanitizeHuman(plan.worktree.branch ?? '')} base=${sanitizeHuman(plan.worktree.base_ref)}`,
    );
  } else {
    writeLine(io, 'Worktree: disabled');
  }
  const relay = plan.relay;
  writeLine(
    io,
    `Relay: ${relay.enabled ? 'enabled' : 'disabled'} poll=${relay.poll_seconds}s reminder=${relay.reminder_seconds}s attach=${relay.attach ? 'yes' : 'no'}`,
  );
  writeLine(io, paneBreakdown(plan.roster));
  writeLine(io, 'Roster:');
  for (const entry of plan.roster) {
    writeLine(io, `  ${entry.agent_id.padEnd(16)} role=${entry.role}`);
  }
  writePathBlock(io, 'Focus files', plan.focus.files);
  writePathBlock(io, 'Focus docs', plan.focus.docs);
  writeLine(io, 'Constraints:');
  if (plan.constraints.length === 0) writeLine(io, '  (none)');
  for (const constraint of plan.constraints) writeLine(io, `  - ${sanitizeHuman(constraint)}`);
  if (brief.present) {
    const lines = brief.lineCount === null ? '?' : String(brief.lineCount);
    writeLine(
      io,
      `Task brief: ${sanitizeHuman(brief.path)} (${lines} lines) → Manager, under guard`,
    );
  } else {
    writeLine(io, `Task brief: none (${sanitizeHuman(brief.path)} absent)`);
  }
  writePathBlock(io, 'Artifacts', plan.artifacts);
  writeLine(io, `schema_version: ${plan.schema_version}`);
}
