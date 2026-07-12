/**
 * The injected boundary between crew and its process environment.
 *
 * `run(argv, io)` takes everything it touches as data so the whole CLI is
 * testable in-process: stdout/stderr are sinks, stdin/cwd/env are inputs, and
 * `clock` is the single source of "now" (epoch seconds) shared by an operation.
 *
 * `runProcess` is the capture-only subprocess seam: it spawns a child with an
 * argument array (`shell: false`), waits with a bounded timeout, and resolves
 * with the captured exit status and streams. It is used by the platform
 * registry's version probes.
 *
 * `runInteractive` is its deliberate inverse: a single foreground, TTY-owning,
 * UNbounded child (argument array, `shell: false`) that inherits this process's
 * stdio and resolves with the child's exit code. The Launcher uses it ONLY for
 * `tmux attach` — the one long-lived, terminal-owning process crew ever spawns.
 * Every other tmux/git call is short-lived and goes through `runProcess`.
 */
export interface ProcessResult {
  /**
   * Exit code, or `null` when the child never produced one because it could not
   * be spawned or was terminated before exit.
   */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when Node reports the child was killed before it exited cleanly. */
  readonly killed?: boolean;
  /** The terminating signal, when Node reported one. */
  readonly signal?: NodeJS.Signals | null;
}

export interface Io {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly clock: () => number;
  /**
   * Uniform random in [0, 1) — the single source of nondeterminism for the
   * Store's contention-retry jitter. Production wires `Math.random`; tests and
   * the test-only fault build inject a seeded stream so a flaky stress failure
   * replays exactly. Never seeded in production.
   */
  readonly random: () => number;
  /**
   * Test-only fault seam: a callback invoked at labeled points inside Store
   * transitions so the
   * test-only fault build can crash deterministically mid-transaction. Production
   * leaves this undefined — a no-op, so no fault code lives in the shipped path.
   */
  readonly onTransactionStep?: (label: string) => void;
  readonly runProcess: (
    file: string,
    args: readonly string[],
    opts: { readonly timeoutMs: number },
  ) => Promise<ProcessResult>;
  /**
   * Spawn a single foreground child (argument array, `shell: false`) that
   * inherits this process's stdio and has NO timeout, resolving with its exit
   * code (a child killed by signal or a spawn failure resolves non-zero, never
   * throws). Reserved for `tmux attach`.
   */
  readonly runInteractive: (file: string, args: readonly string[]) => Promise<number>;
}
