/**
 * Executable lookup on the injected `PATH`. Shared by `doctor`'s dependency
 * checks and the platform registry's presence detection so both use one rule:
 * a name is present when some `PATH` entry holds an executable regular file of
 * that name. `statSync` follows symlinks (a symlink to a real executable
 * counts), but an executable directory named like the command does not.
 *
 * Only absolute `PATH` entries are considered: an empty or relative element
 * (``, `.`, `bin`) resolves through the process CWD, so honoring it would let a
 * same-named binary planted in an untrusted repository be validated — or spawned
 * — instead of the real one. Callers that spawn what they validated
 * must use {@link resolveExecutableOnPath} and pass the returned absolute path
 * to the spawn, so execvp performs no second `PATH` search of its own.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * Resolve `name` to the absolute path of the first executable regular file on
 * the injected `PATH`, or null when no absolute `PATH` entry holds one. Empty
 * and relative entries are skipped — they would resolve through the CWD.
 */
export function resolveExecutableOnPath(env: NodeJS.ProcessEnv, name: string): string | null {
  const pathVar = env.PATH ?? '';
  for (const dir of pathVar.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep scanning the remaining PATH entries
    }
  }
  return null;
}

/** True when `name` resolves to an executable regular file on the injected `PATH`. */
export function isExecutableOnPath(env: NodeJS.ProcessEnv, name: string): boolean {
  return resolveExecutableOnPath(env, name) !== null;
}
