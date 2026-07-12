/**
 * Safe filesystem primitives for managed Workspace IO (FR-B14/B15, security.md
 * "Symlink and path traversal").
 *
 * Managed paths must resolve under their expected root, must not be reached
 * through a symlink at any path component, are size-limited and strictly
 * UTF-8 decoded on read, and are written atomically (temp sibling + rename).
 */
import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CrewError } from './errors.js';

/** Maximum size for a tracked/managed config document (configuration.md). */
export const MAX_CONFIG_BYTES = 256 * 1024;

/**
 * Resolve `target` (absolute, or relative to `root`) and assert it stays
 * strictly inside `root`. Rejects `..` traversal and absolute escapes
 * lexically. Returns the resolved absolute path.
 */
export function assertWithin(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(resolvedRoot, target);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new CrewError('UNSAFE_PATH', `path escapes the workspace root: ${target}`);
  }
  return resolvedTarget;
}

/**
 * Walk every path component from `root` down to `resolvedTarget` and reject if
 * any existing component is a symbolic link. This forbids a symlinked component
 * even when it points back inside the root (security.md: existing symlinks are
 * rejected for managed output).
 */
export function assertNoSymlinkComponents(root: string, resolvedTarget: string): void {
  const rel = relative(resolve(root), resolvedTarget);
  if (rel === '') {
    return;
  }
  let current = resolve(root);
  for (const segment of rel.split(sep)) {
    current = resolve(current, segment);
    let st;
    try {
      st = lstatSync(current);
    } catch {
      st = null; // does not exist yet — nothing to follow
    }
    if (st?.isSymbolicLink()) {
      throw new CrewError(
        'UNSAFE_PATH',
        `refusing to traverse a symlink under the workspace: ${current}`,
      );
    }
  }
}

/**
 * Resolve a managed path: assert lexical containment, reject any symlinked path
 * component, and verify the real root exists. Returns the safe absolute path.
 * Used for both reads and writes of managed files/directories.
 */
export function resolveManagedTarget(root: string, target: string): string {
  const resolvedTarget = assertWithin(root, target);
  try {
    realpathSync(root);
  } catch {
    throw new CrewError('UNSAFE_PATH', `workspace root does not exist: ${root}`);
  }
  assertNoSymlinkComponents(root, resolvedTarget);
  return resolvedTarget;
}

/** Create a managed directory (and parents), rejecting symlinked components. */
export function ensureManagedDir(root: string, target: string): string {
  const resolved = resolveManagedTarget(root, target);
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

/** Create a directory (and parents) if absent. Use only for unmanaged scratch paths. */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

/**
 * Read a managed file safely: reject symlink/escape, require a regular file,
 * enforce `maxBytes` before reading, and decode strictly as UTF-8. The caller is
 * responsible for checking existence first (e.g. via {@link managedPathExists}).
 */
export function readManagedFile(
  root: string,
  target: string,
  maxBytes: number = MAX_CONFIG_BYTES,
): string {
  const resolved = resolveManagedTarget(root, target);
  const st = statSync(resolved);
  if (!st.isFile()) {
    throw new CrewError('INVALID_CONFIG', `${target} is not a regular file`);
  }
  if (st.size > maxBytes) {
    throw new CrewError(
      'INVALID_CONFIG',
      `${target} exceeds the ${maxBytes}-byte limit (${st.size} bytes)`,
    );
  }
  const buf = readFileSync(resolved);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new CrewError('INVALID_CONFIG', `${target} is not valid UTF-8`);
  }
}

/**
 * Realpath-verify that the directory holding `resolvedTarget` physically lies
 * under the real `root`, and return the physical (symlink-free) target path.
 * Called by {@link writeFileAtomic} after creating the parent, immediately
 * before the temp write and rename: a component swapped for an
 * outside-pointing symlink between validation and the write is rejected here,
 * and the write/rename below run against the verified physical parent instead
 * of re-traversing the swapped path.
 */
export function assertRealParentWithin(root: string, resolvedTarget: string): string {
  const realRoot = realpathSync(resolve(root));
  const realParent = realpathSync(dirname(resolvedTarget));
  const rel = relative(realRoot, realParent);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new CrewError(
      'UNSAFE_PATH',
      `write parent escapes the workspace root: ${resolvedTarget}`,
    );
  }
  return join(realParent, basename(resolvedTarget));
}

/**
 * Write `data` to a managed `target` (absolute, or relative to `root`)
 * atomically: write a uniquely named temporary sibling, then rename it over the
 * target (atomic on the same filesystem). Creates parent directories as needed.
 *
 * Containment is re-established at write time, not trusted from an earlier
 * caller-side check: the symlink/containment assertions run here,
 * immediately before the write, and the temp write + rename go through the
 * realpath-verified physical parent. The remaining assertion-to-syscall window
 * is not fully atomic (Node exposes no `openat`/`renameat`), which security.md
 * documents as in-scope for the same-user threat model.
 */
export function writeFileAtomic(root: string, target: string, data: string | Uint8Array): void {
  const resolved = resolveManagedTarget(root, target);
  mkdirSync(dirname(resolved), { recursive: true });
  const physical = assertRealParentWithin(root, resolved);
  const tmp = `${physical}.${randomUUID()}.tmp`;
  writeFileSync(tmp, data, { encoding: 'utf8', flag: 'wx' });
  renameSync(tmp, physical);
}
