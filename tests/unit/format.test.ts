import { describe, it, expect } from 'vitest';
import { CrewError } from '../../src/errors.js';
import {
  errorEnvelope,
  redactSecrets,
  renderTeamResumeResult,
  renderTeamStopResult,
  sanitizeHuman,
  writeError,
  writeJsonLine,
  writeLine,
} from '../../src/format.js';
import type { Io } from '../../src/io.js';
import {
  SECRET_LIKE,
  REDACTION_SAFE,
  WRAPPERS,
  generateCombinations,
} from '../helpers/security-corpus.js';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const DOCUMENTED_ERROR_CODES = new Set([
  'USAGE',
  'INVALID_CONFIG',
  'NOT_WORKSPACE',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'AGENT_INACTIVE',
  'TASK_CONFLICT',
  'TEAM_DRIFT',
  'CONTENTION',
  'INTEGRITY',
  'UNSUPPORTED_SCHEMA',
  'UNSUPPORTED_PLATFORM',
  'UNSAFE_PATH',
  'DEPENDENCY_MISSING',
  'ACTIVE_AGENTS',
  'STALE_STORE',
  'ERROR',
  'LAUNCH_FAILED',
]);

function captureIo(): { out: string[]; err: string[]; io: Io } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd: '/tmp',
    env: {},
    stdin: process.stdin,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    clock: () => 0,
    random: () => 0.5,
    runProcess: () => Promise.resolve({ status: null, stdout: '', stderr: '' }),
    runInteractive: () => Promise.resolve(0),
  };
  return { out, err, io };
}

describe('errorEnvelope', () => {
  it('includes details when present', () => {
    const e = new CrewError('TASK_CONFLICT', 'msg', { task_id: 'x' });
    expect(errorEnvelope(e)).toEqual({
      ok: false,
      error: { code: 'TASK_CONFLICT', message: 'msg', details: { task_id: 'x' } },
    });
  });

  it('omits details when absent', () => {
    expect(errorEnvelope(new CrewError('USAGE', 'bad'))).toEqual({
      ok: false,
      error: { code: 'USAGE', message: 'bad' },
    });
  });

  it('wraps unknown throwables under the ERROR code', () => {
    expect(errorEnvelope(new Error('boom'))).toEqual({
      ok: false,
      error: { code: 'ERROR', message: 'boom' },
    });
  });
});

describe('writeError', () => {
  it('renders human errors as [CODE] message on stderr', () => {
    const { out, err, io } = captureIo();
    writeError(io, new CrewError('USAGE', 'bad flag'), false);
    expect(err.join('')).toBe('[USAGE] bad flag\n');
    expect(out).toEqual([]);
  });

  it('renders JSON errors as one object line on stderr', () => {
    const { out, err, io } = captureIo();
    writeError(io, new CrewError('USAGE', 'bad flag'), true);
    expect(err.join('')).toBe('{"ok":false,"error":{"code":"USAGE","message":"bad flag"}}\n');
    expect(out).toEqual([]);
  });

  it('renders an unknown throwable under a documented machine-readable code', () => {
    const { err, io } = captureIo();
    writeError(io, new Error('x'), true);
    const parsed = JSON.parse(err.join('')) as { error: { code: string; message: string } };
    expect(DOCUMENTED_ERROR_CODES.has(parsed.error.code)).toBe(true);
    expect(parsed.error.code).toBe('ERROR');
    expect(parsed.error.message).toBe('x');
  });

  it('sanitizes human error stderr from terminal escape injection', () => {
    const { out, err: stderr, io } = captureIo();
    const badMessage = 'x\x1b[31m\x1b]0;PWNED\x07y';
    writeError(io, new CrewError('INVALID_CONFIG', badMessage), false);
    expect(stderr.join('')).toBe('[INVALID_CONFIG] xy\n');
    expect(stderr.join('')).not.toContain('\x1b');
    expect(stderr.join('')).not.toContain('\x07');
    expect(out).toEqual([]);

    const jsonIo = captureIo();
    writeError(jsonIo.io, new CrewError('INVALID_CONFIG', badMessage), true);
    expect(jsonIo.err.join('')).toBe(
      '{"ok":false,"error":{"code":"INVALID_CONFIG","message":"x\\u001b[31m\\u001b]0;PWNED\\u0007y"}}\n',
    );
  });

  it('escapes newlines in the human error surface so a message cannot forge a line', () => {
    const { err: stderr, io } = captureIo();
    writeError(io, new CrewError('INVALID_CONFIG', 'a\n[OK] task approved'), false);
    const rendered = stderr.join('');
    // The injected newline is rendered literally (\n), not as a real break, so the
    // forged "[OK] task approved" cannot appear on its own line.
    expect(rendered).toBe('[INVALID_CONFIG] a\\n[OK] task approved\n');
    // The only real newline is the trailing one writeError itself appends.
    expect(rendered.indexOf('\n')).toBe(rendered.length - 1);
  });
});

describe('redactSecrets (FR-J14)', () => {
  it('masks provider-prefixed tokens', () => {
    expect(redactSecrets('token sk-test-ABCDEF0123456789xyz here')).toBe('token [REDACTED] here');
    expect(redactSecrets('ghp_ABCDEFGHIJKLMNOPQRSTUVWX0123456789')).toBe('[REDACTED]');
  });

  it('masks the value of credential-named assignments but keeps the key', () => {
    expect(redactSecrets('password=hunter2supersecret')).toBe('password=[REDACTED]');
    expect(redactSecrets('api_key: abcDEF123ghiJKL')).toBe('api_key: [REDACTED]');
  });

  it('masks namespaced credential keys (launch_token, CREW_LAUNCH_TOKEN) even for short values [security]', () => {
    // The launch token's real 64-hex value is already caught by the 20+ run rule;
    // the name-based pair rule masks it regardless of value length.
    expect(redactSecrets('CREW_LAUNCH_TOKEN=deadbeef')).toBe('CREW_LAUNCH_TOKEN=[REDACTED]');
    expect(redactSecrets('launch_token: abc123')).toBe('launch_token: [REDACTED]');
    expect(redactSecrets('my_password=hunter2')).toBe('my_password=[REDACTED]');
    // No false positives on ordinary words that merely end in a key-like suffix.
    expect(redactSecrets('a monkey=banana and the author=jane')).toBe(
      'a monkey=banana and the author=jane',
    );
  });

  it('masks the full documented credential-name set (security.md name-based guardrail) [security]', () => {
    // The value-redactor keyword set mirrors the name-based env-guardrail set in
    // security.md: token, key, secret, password, credential, auth, session, cookie,
    // private, and `_pat`. Each is masked as a key=value / key: value pair, bare or
    // namespaced (so `signing_key` and `db_credential` match too).
    expect(redactSecrets('signing_key=abcdef')).toBe('signing_key=[REDACTED]');
    expect(redactSecrets('db_credential=s3cr3t')).toBe('db_credential=[REDACTED]');
    expect(redactSecrets('session: abc123')).toBe('session: [REDACTED]');
    expect(redactSecrets('cookie=chocolate')).toBe('cookie=[REDACTED]');
    expect(redactSecrets('PRIVATE_KEY: xxxx')).toBe('PRIVATE_KEY: [REDACTED]');
    expect(redactSecrets('client_secret=abc')).toBe('client_secret=[REDACTED]');
    expect(redactSecrets('GITHUB_PAT=ghp_short')).toBe('GITHUB_PAT=[REDACTED]');
    expect(redactSecrets('Authorization: Bearer abc')).toBe('Authorization: [REDACTED] abc');
    // False-positive guards: words ending in a credential-like fragment are not
    // pairs of a credential key (no `^`/`_`/`-` boundary before the fragment).
    expect(redactSecrets('donkey=grey and turkey=big')).toBe('donkey=grey and turkey=big');
    expect(redactSecrets('worker-2 joined')).toBe('worker-2 joined');
  });

  it('does not degrade to quadratic time on a long hyphenated non-secret key (ReDoS regression) [security]', () => {
    // The old `(?:[a-z0-9]+[_-])*` prefix was O(n^2) on hyphen-separated identifiers
    // and reachable through user-controlled error text (e.g. an unreadable
    // `--task-file` path). The rewritten matcher is linear and the input is bounded
    // before any pattern runs; this pathological input took >1s pre-fix and is a few
    // ms now. A generous bound cleanly separates the two without CI flakiness.
    const pathological = 'a-'.repeat(20_000) + 'ordinary=value';
    const start = performance.now();
    const out = redactSecrets(pathological);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(250);
    // The key is not credential-like, so nothing is masked (the value is preserved).
    expect(out).not.toContain('[REDACTED]');
    expect(out.startsWith('a-a-a-')).toBe(true);
  });

  it('masks a symbol-bearing base64 value in a keyed pair but preserves filesystem paths (security.md scope) [security]', () => {
    // The standalone 20+ run rule is deliberately alphanumeric so it cannot corrupt
    // paths/URLs in error text; a base64 secret with `+`/`/` is instead masked when
    // it appears as a keyed value (the common case).
    expect(redactSecrets('token=+///+///+///+///+///+///')).toBe('token=[REDACTED]');
    // A long path segment must survive untouched (the reason `/` is excluded).
    const path = 'cannot read /home/user/Projects/crew/state/crew.db';
    expect(redactSecrets(path)).toBe(path);
    // The documented limitation: a standalone `+/`-bearing base64 run (no key, no
    // scheme) is intentionally NOT masked by the alphanumeric backstop.
    expect(redactSecrets('value +///+///+///+///+///+/// done')).toBe(
      'value +///+///+///+///+///+/// done',
    );
  });

  it('masks long opaque tokens but preserves UUIDs', () => {
    expect(redactSecrets('hash 0123456789ABCDEF0123456789ABCDEF done')).toBe(
      'hash [REDACTED] done',
    );
    const uuid = '11111111-1111-4111-8111-111111111111';
    expect(redactSecrets(`no task ${uuid}`)).toBe(`no task ${uuid}`);
  });

  it('masks credential values that are quoted and contain spaces', () => {
    expect(redactSecrets('password="my secret value"')).toBe('password="[REDACTED]"');
    expect(redactSecrets("token: 'a b c'")).toBe("token: '[REDACTED]'");
  });

  it('masks 20+ char base64/hex runs and JWTs (security.md threshold)', () => {
    // 24 hex characters — below the old 32-char rule, redacted under the 20 rule.
    expect(redactSecrets('value 0123456789abcdef01234567 end')).toBe('value [REDACTED] end');
    expect(redactSecrets('auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln done')).toBe(
      'auth [REDACTED] done',
    );
  });

  it('masks the password in a connection-string credential, keeping scheme/user/host', () => {
    expect(redactSecrets('fatal: cannot fetch https://git:s3cret@example.com/r.git')).toBe(
      'fatal: cannot fetch https://git:[REDACTED]@example.com/r.git',
    );
    expect(redactSecrets('postgres://user:pw@db:5432/app')).toBe(
      'postgres://user:[REDACTED]@db:5432/app',
    );
  });

  it('masks user-less connection-string credentials (Redis/Mongo style, C4)', () => {
    // `scheme://:password@host` — no username before the colon.
    expect(redactSecrets('redis://:s3cretpw@localhost:6379')).toBe(
      'redis://:[REDACTED]@localhost:6379',
    );
    // `scheme://password@host` — credential with no colon at all.
    expect(redactSecrets('mongodb://s3cretpw@localhost')).toBe('mongodb://[REDACTED]@localhost');
  });

  it('leaves ordinary text unchanged', () => {
    expect(redactSecrets('agent "worker" is archived')).toBe('agent "worker" is archived');
  });

  it('truncates oversized strings', () => {
    const big = 'word '.repeat(1000); // 5000 chars, no token-like runs
    const out = redactSecrets(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });

  it('masks every secret-shaped corpus string [security]', () => {
    for (const s of SECRET_LIKE) {
      expect(redactSecrets(s)).toContain('[REDACTED]');
    }
    // The masked output must not carry the high-entropy secret substring through,
    // even when the secret is embedded in benign context (assert the body is gone).
    expect(redactSecrets('password=hunter2supersecret')).not.toContain('hunter2supersecret');
    expect(redactSecrets('postgres://user:s3cr3tpassword@host:5432/db')).not.toContain(
      's3cr3tpassword',
    );
    expect(redactSecrets('a'.repeat(64))).not.toContain('a'.repeat(64));
    expect(redactSecrets(`sk-${'A'.repeat(24)}`)).not.toContain('A'.repeat(24));
    expect(redactSecrets(`ghp_${'B'.repeat(36)}`)).not.toContain('B'.repeat(36));
    expect(redactSecrets(`AKIA${'0'.repeat(16)}`)).not.toContain('0'.repeat(16));
    expect(redactSecrets(`eyJ${'a'.repeat(10)}.${'b'.repeat(10)}.${'c'.repeat(10)}`)).not.toContain(
      'b'.repeat(10),
    );
  });

  it('preserves non-secret corpus strings unchanged [security]', () => {
    for (const s of REDACTION_SAFE) {
      expect(redactSecrets(s)).toBe(s);
    }
  });

  it('masks every generated adversarial combination of an entropy-based secret [security]', () => {
    // "Wrap-robust" = masked under EVERY wrapper (derived from the actual wrappers, so
    // the classification can't drift from what the loop asserts). Boundary-anchored
    // rules (`\bghp_`, `\beyJ`) and the name-based key=value rule can be defeated by an
    // ANSI/duplication glue that erases the word boundary they need, so those bases
    // (ghp_/gho_/eyJ/password=) fall out here and are instead exercised directly,
    // unwrapped, by "masks every secret-shaped corpus string" above.
    const wrapRobust = SECRET_LIKE.filter((base) =>
      WRAPPERS.every((wrap) => !redactSecrets(wrap(base)).includes(base)),
    );
    expect(wrapRobust.length).toBeGreaterThan(0);

    // The generator is deterministic from its seed, so a discovered failure can be
    // pinned as a permanent fixture.
    expect(generateCombinations(wrapRobust, 42, 12)).toEqual(
      generateCombinations(wrapRobust, 42, 12),
    );

    // Every generated combination embeds one base inside a benign wrapper (prefix/
    // suffix, ANSI colour, duplication, long padding, multiline). Each must still be
    // masked, and the embedded base must not survive verbatim — this is what actually
    // exercises wrapper-specific regressions, not just generator determinism.
    for (const combo of generateCombinations(wrapRobust, 42, 240)) {
      const out = redactSecrets(combo);
      expect(out).toContain('[REDACTED]');
      for (const base of wrapRobust) {
        if (combo.includes(base)) {
          expect(out).not.toContain(base);
        }
      }
    }

    // The "padded" shape as an explicit fixture: a high-entropy token after a long
    // benign (space-separated, non-run) preamble is still found and masked.
    const token = `sk-${'A'.repeat(30)}`;
    const out = redactSecrets(`${'benign words '.repeat(20)}${token} and after`);
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain(token);
  });
});

describe('writeError redaction (FR-J14)', () => {
  it('redacts a token in the message and details on both surfaces', () => {
    const err = new CrewError('INVALID_CONFIG', 'bad token sk-live-ABCDEF0123456789zzz', {
      secret: 'password=hunter2supersecret',
    });

    const human = captureIo();
    writeError(human.io, err, false);
    expect(human.err.join('')).toBe('[INVALID_CONFIG] bad token [REDACTED]\n');

    const json = captureIo();
    writeError(json.io, err, true);
    const parsed = JSON.parse(json.err.join('')) as {
      error: { message: string; details: { secret: string } };
    };
    expect(parsed.error.message).toBe('bad token [REDACTED]');
    expect(parsed.error.details.secret).toBe('password=[REDACTED]');
  });
});

describe('sanitizeHuman', () => {
  it('leaves plain text and preserves tab and newline', () => {
    expect(sanitizeHuman('a\tb\nc')).toBe('a\tb\nc');
  });

  it('strips an ANSI CSI colour sequence but keeps the text', () => {
    expect(sanitizeHuman(`${ESC}[31mRED${ESC}[0m`)).toBe('RED');
  });

  it('strips an OSC sequence terminated by BEL', () => {
    expect(sanitizeHuman(`${ESC}]0;pwned${BEL}done`)).toBe('done');
  });

  it('strips an OSC sequence terminated by ST (ESC backslash)', () => {
    expect(sanitizeHuman(`${ESC}]0;pwned${ESC}\\done`)).toBe('done');
  });

  it('drops a lone ESC and C0/C1 control characters', () => {
    const input = `x${ESC}y${String.fromCharCode(0x01)}z${String.fromCharCode(0x90)}w`;
    expect(sanitizeHuman(input)).toBe('xyzw');
  });

  it('strips Unicode bidi reordering controls (Trojan Source) but keeps normal text', () => {
    // RLO, the isolates (LRI/PDI), PDF, and LRM must not survive to reorder a line.
    const input = `admin\u202e\u2066/etc\u2069\u202c\u200e.md`;
    expect(sanitizeHuman(input)).toBe('admin/etc.md');
    // A zero-width joiner (U+200D) is legitimate (emoji/scripts) and is NOT stripped.
    expect(sanitizeHuman('a\u200db')).toBe('a\u200db');
  });

  it('returns plain text unchanged', () => {
    expect(sanitizeHuman('# Manager\nDo the thing.')).toBe('# Manager\nDo the thing.');
  });
});

describe('record output', () => {
  it('writes NDJSON one object per line on stdout', () => {
    const { out, io } = captureIo();
    writeJsonLine(io, { type: 'agent', schema_version: 1, id: 'worker' });
    expect(out.join('')).toBe('{"type":"agent","schema_version":1,"id":"worker"}\n');
  });

  it('writes human lines on stdout', () => {
    const { out, io } = captureIo();
    writeLine(io, 'No agents.');
    expect(out.join('')).toBe('No agents.\n');
  });
});

describe('renderTeamStopResult (FR-U29)', () => {
  const result = { sessionName: 'crew-demo', killed: true, agentsArchived: 3 };

  it('emits exactly one stop_result NDJSON record with the contract fields', () => {
    const { out, err, io } = captureIo();
    renderTeamStopResult(io, result, true);
    expect(err).toEqual([]);
    const lines = out.join('').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      type: 'stop_result',
      schema_version: 1,
      session_name: 'crew-demo',
      killed: true,
      agents_archived: 3,
    });
  });

  it('reports killed:false when the session was already gone', () => {
    const { out, io } = captureIo();
    renderTeamStopResult(io, { ...result, killed: false }, true);
    const record = JSON.parse(out.join('').trim()) as { killed: boolean };
    expect(record.killed).toBe(false);
  });

  it('writes a human summary line with the archived count when not --json', () => {
    const { out, io } = captureIo();
    renderTeamStopResult(io, result, false);
    expect(out.join('')).toBe('Stopped crew-demo; archived 3 Agents.\n');
  });

  it('sanitizes the session name in human output', () => {
    const { out, io } = captureIo();
    renderTeamStopResult(io, { ...result, sessionName: `crew${ESC}[31mX` }, false);
    expect(out.join('')).not.toContain(ESC);
    expect(out.join('')).toContain('crew');
  });
});

describe('renderTeamResumeResult (FR-U32)', () => {
  const result = { sessionName: 'crew-demo', panes: 4, relay: true, attached: false };

  it('emits exactly one resume_result NDJSON record with the contract fields', () => {
    const { out, err, io } = captureIo();
    renderTeamResumeResult(io, result, true);
    expect(err).toEqual([]);
    const lines = out.join('').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      type: 'resume_result',
      schema_version: 1,
      session_name: 'crew-demo',
      panes: 4,
      relay: true,
      attached: false,
    });
  });

  it('writes a human summary with relay on when not --json', () => {
    const { out, io } = captureIo();
    renderTeamResumeResult(io, result, false);
    expect(out.join('')).toBe('Resumed session crew-demo (4 panes, relay on).\n');
  });

  it('writes a human summary with relay off and sanitizes the session name', () => {
    const { out, io } = captureIo();
    renderTeamResumeResult(io, { ...result, sessionName: `crew${ESC}[31mX`, relay: false }, false);
    expect(out.join('')).toContain('relay off');
    expect(out.join('')).not.toContain(ESC);
  });
});
