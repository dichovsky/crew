#!/usr/bin/env node
/**
 * Installed crew executable. Enforces the Node floor before loading the program,
 * builds the real process-backed {@link Io}, runs, and maps the result to a
 * process exit. The compiled `dist/bin/crew.js` is the published entry point; no
 * TypeScript source is ever the installed executable (DEC-8).
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assertNodeFloor } from '../src/node-floor.js';
import type { Io } from '../src/io.js';

/**
 * Report a failure: write to stderr and set the exit code without calling
 * `process.exit`, so Node drains buffered stdout/stderr (e.g. piped NDJSON)
 * before terminating instead of truncating it.
 */
function fail(message: string, code: number): void {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

export async function main(): Promise<void> {
  try {
    assertNodeFloor();
  } catch (err) {
    // Coerce inline rather than via format.ts: the floor must be checked before
    // any application module is loaded, so nothing from the app graph is
    // imported on this path. A too-old runtime is operational/platform, exit 1
    // (cli-contract.md "Exit status", FR-J05).
    fail(err instanceof Error ? err.message : String(err), 1);
    return;
  }

  // Import the application graph only after the floor passes. ESM evaluates
  // static imports before any module body, so importing `run` statically would
  // load its transitive deps (a future Node-24-only `node:sqlite`, etc.) before
  // the floor check — a too-old runtime would then fail during linking instead
  // of with the clear floor message above.
  const { run } = await import('../src/run.js');
  const { messageOf } = await import('../src/format.js');
  const { nodeRunProcess, nodeRunInteractive } = await import('../src/process.js');

  const io: Io = {
    cwd: process.cwd(),
    env: process.env,
    stdin: process.stdin,
    stdout: (t) => {
      process.stdout.write(t);
    },
    stderr: (t) => {
      process.stderr.write(t);
    },
    clock: () => Math.floor(Date.now() / 1000),
    random: Math.random,
    runProcess: nodeRunProcess,
    runInteractive: nodeRunInteractive,
  };

  try {
    process.exitCode = await run(process.argv.slice(2), io);
  } catch (err) {
    fail(messageOf(err), 1);
  }
}

function isMainEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    const resolvedPath = realpathSync(process.argv[1]);
    return import.meta.url === pathToFileURL(resolvedPath).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isMainEntry()) {
  void main().catch((err: unknown) => {
    fail(err instanceof Error ? err.message : String(err), 1);
  });
}
