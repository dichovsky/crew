/**
 * The tmux adapter: the ONLY module that builds tmux argv
 * and drives it through the injected process seams. `session.ts` depends on the
 * SEMANTIC {@link TmuxAdapter} interface (so orchestration is tested against a
 * fake adapter), while this real implementation is proven argv-exact via the
 * recording process double.
 *
 * Every call is `shell:false` argv (FR-H09/H11) — the Participant executable and
 * the per-pane command are passed as separate argv elements, never a shell
 * string. A non-zero exit becomes a `LAUNCH_FAILED` CrewError; a spawn failure
 * (tmux not runnable) becomes `DEPENDENCY_MISSING`; a killed / timed-out child
 * — for the `tmux -V` availability probe and every control command alike —
 * becomes a generic operational `ERROR`: it proves neither success nor absence,
 * and these ops also serve non-launch flows (`team stop`,
 * owned-session listing, pane peek, the Relay, resume eligibility), so it is
 * never shaped as a launch failure — and never as missing tmux.
 * Diagnostics surfaced from tmux stderr are control-stripped,
 * secret-redacted, and truncated at this boundary
 * so raw subprocess output never leaks.
 */
import { CrewError } from '../errors.js';
import { redactSecrets, sanitizeHuman } from '../format.js';
import type { Io, ProcessResult } from '../io.js';

const TMUX = 'tmux';
/** Bounded timeout for each (short-lived) tmux control command. Attach is unbounded. */
const TMUX_TIMEOUT_MS = 5_000;
/** Display cap on surfaced tmux stderr (applied AFTER redaction). */
const STDERR_SNIPPET = 240;
/** Bound the input handed to the redactor so its regexes never scan a huge buffer. */
const REDACT_INPUT_MAX = 4_096;

export interface NewSessionOpts {
  readonly session: string;
  readonly window: string;
  readonly width: number;
  readonly height: number;
  readonly cwd: string;
  /** The pane's command as argv (e.g. `['claude']`); run by tmux, never a shell string. */
  readonly command: readonly string[];
  /** Environment set on the pane (`tmux -e KEY=VALUE`), e.g. the launch token. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface SplitOpts {
  /** `session:window` target whose space is split. */
  readonly target: string;
  readonly cwd: string;
  readonly command: readonly string[];
  /** Environment set on the pane (`tmux -e KEY=VALUE`), e.g. the launch token. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface NewWindowOpts {
  readonly session: string;
  readonly window: string;
  readonly cwd: string;
  readonly command: readonly string[];
}

export interface PasteOpts {
  readonly bufferName: string;
  /** The destination pane id (e.g. `%3`). */
  readonly target: string;
}

/**
 * Semantic tmux operations the Launcher needs. `session.ts` depends on this, not
 * on `Io`, so orchestration tests inject a fake adapter and assert the call
 * sequence; the real adapter (below) is tested for exact argv via recording `Io`.
 */
export interface TmuxAdapter {
  /**
   * True when the tmux executable runs at all (FR-H02 missing-tmux gate);
   * false only when spawning it proves tmux absent. A probe child that was
   * killed/timed out proves neither, so it throws a generic operational
   * `ERROR` — never `DEPENDENCY_MISSING` ("tmux is not available") and never
   * a launch-shaped `LAUNCH_FAILED`, because this probe also gates the
   * non-launch flows (`team stop`, owned-session listing, pane peek).
   */
  isPresent(): Promise<boolean>;
  /** True when a session of this name already exists (the create refuses on it). */
  hasSession(session: string): Promise<boolean>;
  /** Create a detached session; returns the first pane id. */
  newSession(opts: NewSessionOpts): Promise<string>;
  /** Split a window; returns the new pane id. */
  splitPane(opts: SplitOpts): Promise<string>;
  /** Re-balance a window's panes to the tiled layout. */
  tileLayout(target: string): Promise<void>;
  /** The pane's current foreground command name (readiness stage 1). */
  paneCommand(paneId: string): Promise<string>;
  /** Stamp a random launch-instance marker on the owned session. */
  setSessionOwner(session: string, ownershipToken: string): Promise<void>;
  /** Read the launch-instance marker from a live session, or null when absent. */
  sessionOwner(session: string): Promise<string | null>;
  /**
   * A target's visible pane text (`capture-pane -p`), RAW and unsanitized —
   * the FR-U24 control-stripping happens at the Console peek route, never here
   * (the adapter stays a pure argv boundary).
   */
  capturePane(target: string): Promise<string>;
  /** Load a tmux buffer from a literal string (argv — short, validated text). */
  setBufferArg(bufferName: string, content: string): Promise<void>;
  /** Load a tmux buffer from a file (untrusted/large brief — never via argv). */
  loadBufferFile(bufferName: string, filePath: string): Promise<void>;
  /** Bracketed-paste a buffer into a pane and delete it afterwards. */
  pasteBuffer(opts: PasteOpts): Promise<void>;
  /** Submit the pane's current input (a single Enter key). */
  sendEnter(paneId: string): Promise<void>;
  /** Create a new window running a command (the Relay window); return its pane id. */
  newWindow(opts: NewWindowOpts): Promise<string>;
  /** Tear down a whole session (only ever called on a session crew owns). */
  killSession(session: string): Promise<void>;
  /** Attach the terminal to a session (the one interactive, unbounded call). */
  attach(session: string): Promise<number>;
}

/**
 * Control-strip, secret-redact, and truncate a tmux stderr snippet for safe
 * surfacing. Redaction runs on the COMPLETE (bounded) input BEFORE the display
 * cap, so truncation can never cut through a secret before its delimiter and
 * defeat the redactor. The input is first bounded so the regexes
 * never run over a pathologically large buffer.
 */
function safeStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length === 0) return '';
  const bounded = trimmed.length > REDACT_INPUT_MAX ? trimmed.slice(0, REDACT_INPUT_MAX) : trimmed;
  const redacted = redactSecrets(sanitizeHuman(bounded));
  return redacted.length > STDERR_SNIPPET ? `${redacted.slice(0, STDERR_SNIPPET)}…` : redacted;
}

/** Expand a pane environment map into repeated `-e KEY=VALUE` tmux flags. */
function envArgs(env: Readonly<Record<string, string>> | undefined): string[] {
  if (env === undefined) return [];
  return Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
}

function killedDetail(result: ProcessResult): string | null {
  if (result.status !== null) return null;
  if (result.signal !== undefined && result.signal !== null) return `signal ${result.signal}`;
  if (result.killed === true) return 'killed before exit';
  return null;
}

export function createTmuxAdapter(io: Io): TmuxAdapter {
  /** Run a tmux control command that must succeed; return stdout. */
  async function run(op: string, args: readonly string[]): Promise<string> {
    const result = await io.runProcess(TMUX, args, { timeoutMs: TMUX_TIMEOUT_MS });
    if (result.status !== 0) {
      const detail = safeStderr(result.stderr);
      const suffix = detail.length > 0 ? `: ${detail}` : '';
      if (result.status === null) {
        const killed = killedDetail(result);
        if (killed !== null) {
          // A killed/timed-out child proves nothing about the operation and
          // may be serving a non-launch flow: generic operational ERROR, not
          // LAUNCH_FAILED and not missing tmux.
          throw new CrewError('ERROR', `tmux ${op} did not exit cleanly (${killed})${suffix}`);
        }
        throw new CrewError('DEPENDENCY_MISSING', `tmux is not available (${op})${suffix}`);
      }
      throw new CrewError('LAUNCH_FAILED', `tmux ${op} failed (exit ${result.status})${suffix}`);
    }
    return result.stdout;
  }

  return {
    async isPresent() {
      const result = await io.runProcess(TMUX, ['-V'], { timeoutMs: TMUX_TIMEOUT_MS });
      const killed = killedDetail(result);
      if (killed !== null) {
        const detail = safeStderr(result.stderr);
        const suffix = detail.length > 0 ? `: ${detail}` : '';
        throw new CrewError(
          'ERROR',
          `the tmux availability probe (tmux -V) did not exit cleanly (${killed})${suffix}`,
        );
      }
      return result.status === 0;
    },

    async hasSession(session) {
      // has-session exits 0 when present, non-zero when absent; null = tmux
      // missing unless the child was killed/signaled first.
      const result = await io.runProcess(TMUX, ['has-session', '-t', `=${session}`], {
        timeoutMs: TMUX_TIMEOUT_MS,
      });
      if (result.status === null) {
        const killed = killedDetail(result);
        if (killed !== null) {
          const detail = safeStderr(result.stderr);
          const suffix = detail.length > 0 ? `: ${detail}` : '';
          // Same classification as `run()`: a killed/timed-out child in a
          // possibly non-launch flow is a generic operational ERROR.
          throw new CrewError(
            'ERROR',
            `tmux has-session did not exit cleanly (${killed})${suffix}`,
          );
        }
        throw new CrewError('DEPENDENCY_MISSING', 'tmux is not available (has-session)');
      }
      return result.status === 0;
    },

    async newSession(o) {
      const out = await run('new-session', [
        'new-session',
        '-d',
        '-s',
        o.session,
        '-n',
        o.window,
        '-x',
        String(o.width),
        '-y',
        String(o.height),
        '-c',
        o.cwd,
        '-P',
        '-F',
        '#{pane_id}',
        ...envArgs(o.env),
        ...o.command,
      ]);
      return out.trim();
    },

    async splitPane(o) {
      const out = await run('split-window', [
        'split-window',
        '-t',
        o.target,
        '-c',
        o.cwd,
        '-P',
        '-F',
        '#{pane_id}',
        ...envArgs(o.env),
        ...o.command,
      ]);
      return out.trim();
    },

    async tileLayout(target) {
      await run('select-layout', ['select-layout', '-t', target, 'tiled']);
    },

    async paneCommand(paneId) {
      const out = await run('display-message', [
        'display-message',
        '-p',
        '-t',
        paneId,
        '#{pane_current_command}',
      ]);
      return out.trim();
    },

    async setSessionOwner(session, ownershipToken) {
      await run('set-option', ['set-option', '-t', session, '@crew_ownership', ownershipToken]);
    },

    async sessionOwner(session) {
      const out = await run('display-message', [
        'display-message',
        '-p',
        '-t',
        session,
        '#{@crew_ownership}',
      ]);
      const value = out.trim();
      return value.length === 0 ? null : value;
    },

    async capturePane(target) {
      return run('capture-pane', ['capture-pane', '-p', '-t', target]);
    },

    async setBufferArg(bufferName, content) {
      await run('set-buffer', ['set-buffer', '-b', bufferName, '--', content]);
    },

    async loadBufferFile(bufferName, filePath) {
      await run('load-buffer', ['load-buffer', '-b', bufferName, filePath]);
    },

    async pasteBuffer(o) {
      await run('paste-buffer', ['paste-buffer', '-d', '-p', '-b', o.bufferName, '-t', o.target]);
    },

    async sendEnter(paneId) {
      await run('send-keys', ['send-keys', '-t', paneId, 'Enter']);
    },

    async newWindow(o) {
      // `-d`: create the window WITHOUT making it active, so a later `attach` lands
      // on the participant `crew` window, not this internal Relay window.
      const out = await run('new-window', [
        'new-window',
        '-d',
        '-t',
        o.session,
        '-n',
        o.window,
        '-c',
        o.cwd,
        '-P',
        '-F',
        '#{pane_id}',
        ...o.command,
      ]);
      return out.trim();
    },

    async killSession(session) {
      await run('kill-session', ['kill-session', '-t', `=${session}`]);
    },

    attach(session) {
      return io.runInteractive(TMUX, ['attach-session', '-t', `=${session}`]);
    },
  };
}
