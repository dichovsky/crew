/**
 * The real (Node-backed) implementation of {@link Io.runProcess}.
 *
 * Capture-only: spawn `file` with an argument array (`shell: false` — no shell
 * interpolation of any argument), enforce a bounded timeout, and resolve with
 * the captured exit status and streams. It never throws for a non-zero exit, a
 * missing executable, or a timeout — those are reported through the result so
 * callers (the platform registry's version probes and the tmux adapter) can
 * classify them.
 */
import { execFile, spawn } from 'node:child_process';
import type { ProcessResult } from './io.js';

/** Cap captured output; a `--version` probe needs only a few bytes. */
const MAX_CAPTURE_BYTES = 1024 * 1024;

export function nodeRunProcess(
  file: string,
  args: readonly string[],
  opts: { readonly timeoutMs: number },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        timeout: opts.timeoutMs,
        shell: false,
        windowsHide: true,
        maxBuffer: MAX_CAPTURE_BYTES,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const out = stdout ?? '';
        const err = stderr ?? '';
        if (error === null) {
          resolve({ status: 0, stdout: out, stderr: err, killed: false, signal: null });
          return;
        }
        // `error` is an ExecFileException: `code` is the child's exit status
        // (number) for a non-zero exit, or a string (ENOENT/EACCES) for a spawn
        // failure; a killed child (timeout/signal) has no numeric code. No cast is
        // needed — narrowing `error.code` to `number` stays visible to the checker.
        const status = !error.killed && typeof error.code === 'number' ? error.code : null;
        resolve({
          status,
          stdout: out,
          stderr: err,
          ...(error.killed !== undefined ? { killed: error.killed } : {}),
          ...(error.signal !== undefined ? { signal: error.signal } : {}),
        });
      },
    );
  });
}

/**
 * The real (Node-backed) implementation of {@link Io.runInteractive}.
 *
 * Spawn `file` with an argument array (`shell: false`), inheriting this
 * process's stdio so the child owns the terminal, with NO timeout. Resolves
 * with the child's exit code; a child terminated by signal or a spawn failure
 * resolves with a non-zero code rather than throwing, so the caller maps the
 * outcome to an exit status. Reserved for `tmux attach`.
 */
export function nodeRunInteractive(file: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(file, [...args], { stdio: 'inherit', shell: false, windowsHide: true });
    child.on('error', () => {
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      resolve(code ?? (signal !== null ? 1 : 0));
    });
  });
}
