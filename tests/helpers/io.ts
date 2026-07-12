import type { Io, ProcessResult } from '../../src/io.js';

/** One recorded {@link Io.runProcess} invocation (argv form, captured for assertions). */
export interface RecordedProcessCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

/** A scripted response: a fixed {@link ProcessResult} or a function of the call. */
export type ProcessScriptEntry = ProcessResult | ((call: RecordedProcessCall) => ProcessResult);

/**
 * A recording {@link Io.runProcess} double: records every call (file, args,
 * timeout) in order and returns scripted results. Each call consumes the next
 * script entry (a function entry is invoked with the call for dynamic
 * responses); when the script is exhausted it returns `fallback`. Used to prove
 * the worktree resolver's exact argv and `shell:false` argument-array form
 * without spawning git.
 */
export function recordingRunProcess(
  script: readonly ProcessScriptEntry[] = [],
  fallback: ProcessResult = { status: 0, stdout: '', stderr: '' },
): { runProcess: Io['runProcess']; calls: RecordedProcessCall[] } {
  const calls: RecordedProcessCall[] = [];
  let index = 0;
  const runProcess: Io['runProcess'] = (file, args, opts) => {
    const call: RecordedProcessCall = { file, args: [...args], timeoutMs: opts.timeoutMs };
    calls.push(call);
    const entry = script[index++];
    const result = typeof entry === 'function' ? entry(call) : (entry ?? fallback);
    return Promise.resolve(result);
  };
  return { runProcess, calls };
}

/** One recorded {@link Io.runInteractive} invocation. */
export interface RecordedInteractiveCall {
  readonly file: string;
  readonly args: readonly string[];
}

/**
 * A recording {@link Io.runInteractive} double: records every call (file, args)
 * in order and resolves with `exitCode` (default 0). Used to prove the Launcher
 * issues exactly one `tmux attach` with the expected argv and that `--no-attach`
 * issues none, without owning a real terminal.
 */
export function recordingRunInteractive(exitCode = 0): {
  runInteractive: Io['runInteractive'];
  calls: RecordedInteractiveCall[];
} {
  const calls: RecordedInteractiveCall[] = [];
  const runInteractive: Io['runInteractive'] = (file, args) => {
    calls.push({ file, args: [...args] });
    return Promise.resolve(exitCode);
  };
  return { runInteractive, calls };
}

/** Build an in-memory {@link Io} that captures stdout/stderr for assertions. */
export function captureIo(overrides: Partial<Io> = {}): {
  io: Io;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd: '/tmp',
    env: {},
    stdin: process.stdin,
    stdout: (t) => {
      out.push(t);
    },
    stderr: (t) => {
      err.push(t);
    },
    clock: () => 0,
    // Deterministic by default; stress tests override with a seeded stream.
    random: () => 0.5,
    // Default: no executable resolves (status null = could-not-spawn). Tests that
    // exercise version probing override `runProcess` with a programmable fake.
    runProcess: () => Promise.resolve({ status: null, stdout: '', stderr: '' }),
    // Default: attach is a no-op resolving 0. Launcher tests override with
    // `recordingRunInteractive` to assert the exact `tmux attach` argv.
    runInteractive: () => Promise.resolve(0),
    ...overrides,
  };
  return { io, out, err };
}
