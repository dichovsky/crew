/**
 * Setup-owned guarded filesystem primitives for writing Participant artifacts to
 * global ($HOME) and project paths *outside* the workspace `.crew/`.
 *
 * This is deliberately separate from `fs-safe.ts`, whose strict
 * workspace-containment and total symlink-component rejection are correct for
 * paths influenced by stored, untrusted Task/Message content. Setup writes go to
 * a fixed canonical path from the platform registry (no user-supplied path
 * reaches here — ADR-0006). For *global* scope that path lands in the user's own
 * home/dotfiles, where symlinked parent/config directories (chezmoi, GNU stow,
 * bare-git) are normal: the narrower rule there only refuses a symlinked *leaf*
 * file unless forced. For *project* scope the registry-relative path is joined
 * onto an untrusted repository, where a pre-planted symlink component would
 * redirect the fixed path outside the workspace: project paths resolve
 * through {@link resolveProjectArtifact} (fs-safe's workspace containment and
 * symlink-component rejection) and are written through
 * {@link writeProjectArtifactAtomic}, which re-runs those assertions at write
 * time so the intervening classification/backup I/O cannot be raced. Both
 * scopes always write atomically with a temp sibling + rename.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { CrewError } from '../errors.js';
import { assertNoSymlinkComponents, assertRealParentWithin, assertWithin } from '../fs-safe.js';

/** A generated artifact is small UTF-8 text; anything larger is not crew-managed. */
const MAX_ARTIFACT_BYTES = 256 * 1024;

/** Assert the writer only ever receives an absolute, registry-derived path. */
function assertAbsolute(absPath: string): void {
  if (!isAbsolute(absPath)) {
    throw new CrewError('UNSAFE_PATH', `setup path must be absolute: ${absPath}`);
  }
}

/**
 * Resolve a project-scope artifact path under the workspace root with the
 * strict workspace rules: lexical containment plus rejection of any symlinked
 * path component between the root and the artifact leaf. A repository
 * is untrusted data, so a repo-planted symlink at `.claude`/`skills`/… must not
 * redirect the fixed registry path outside the workspace. Global ($HOME) scope
 * deliberately keeps its symlink-following (stow/chezmoi) and never comes here.
 */
export function resolveProjectArtifact(root: string, relPath: string): string {
  const resolved = assertWithin(root, relPath);
  assertNoSymlinkComponents(root, resolved);
  return resolved;
}

/** True when the final path component is itself a symbolic link (a symlinked leaf). */
export function isSymlinkLeaf(absPath: string): boolean {
  try {
    return lstatSync(absPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True when a file or a (possibly dangling) symlink exists at `absPath`. */
export function artifactExists(absPath: string): boolean {
  return existsSync(absPath) || isSymlinkLeaf(absPath);
}

/**
 * Read an existing artifact for drift classification, following symlinks. Returns
 * null when absent. Throws when the path is a non-regular file; a binary or
 * oversized file is reported as `null`-unreadable via {@link UnreadableArtifact}
 * so the caller treats it as unmanaged rather than silently overwriting it.
 */
export class UnreadableArtifact extends Error {}

export function readArtifact(absPath: string): string | null {
  assertAbsolute(absPath);
  if (!existsSync(absPath)) return null;
  const st = statSync(absPath); // follows a symlink to its target
  if (!st.isFile()) {
    throw new CrewError('UNSAFE_PATH', `setup target is not a regular file: ${absPath}`);
  }
  if (st.size > MAX_ARTIFACT_BYTES) {
    throw new UnreadableArtifact(`setup target exceeds the size limit: ${absPath}`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(absPath));
  } catch {
    throw new UnreadableArtifact(`setup target is not valid UTF-8: ${absPath}`);
  }
}

/**
 * Move the existing entry at `absPath` to a fresh `<path>.bak.<epoch>` name and return it, or
 * `null` when there is nothing to back up. Rename (not copy) preserves the entry exactly —
 * including a symlink, dangling or not — and never follows a link into a `copyFileSync` ENOENT.
 * The name is allocated with no-clobber semantics: a `.N` suffix is added when a backup from the
 * same epoch second already exists, so a second `--force` in the same second cannot overwrite
 * the first backup (FR-G06: a backup is never silently discarded).
 */
export function backupArtifact(absPath: string, epochSeconds: number): string | null {
  assertAbsolute(absPath);
  // `existsSync` follows links (false for a dangling link); `isSymlinkLeaf` catches the link
  // itself. Together they detect any entry worth preserving.
  if (!existsSync(absPath) && !isSymlinkLeaf(absPath)) return null;
  let backup = `${absPath}.bak.${epochSeconds}`;
  for (let n = 1; existsSync(backup) || isSymlinkLeaf(backup); n++) {
    backup = `${absPath}.bak.${epochSeconds}.${n}`;
  }
  renameSync(absPath, backup);
  return backup;
}

/**
 * Write a uniquely named temporary sibling, then rename it over `absPath`. On any
 * failure the temporary sibling is removed so no orphan `.tmp` file is left behind.
 * Shared by both artifact writers; the caller owns parent creation and any
 * containment policy.
 */
function replaceAtomically(absPath: string, content: string): void {
  let tmp: string | undefined = `${absPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, absPath);
    tmp = undefined;
  } finally {
    if (tmp !== undefined) {
      try {
        unlinkSync(tmp);
      } catch {
        // best-effort cleanup; surface the original write/rename error
      }
    }
  }
}

/**
 * Atomically write `content` to a *global* ($HOME) artifact at `absPath`: create
 * parent directories (user-only by default), then temp-write + rename. A symlinked
 * parent is deliberately followed (chezmoi/stow/bare-git dotfiles); a symlinked
 * leaf is replaced by the real file (the caller gates this behind --force +
 * backup). Project-scope writes must use {@link writeProjectArtifactAtomic}, which
 * adds workspace containment.
 */
export function writeArtifactAtomic(absPath: string, content: string, dirMode = 0o700): void {
  assertAbsolute(absPath);
  mkdirSync(dirname(absPath), { recursive: true, mode: dirMode });
  replaceAtomically(absPath, content);
}

/**
 * Atomically write `content` to a *project* artifact at the registry-relative
 * `relPath` under the workspace `root`, re-establishing containment at write time
 * (mirroring fs-safe's `writeFileAtomic`): the caller's earlier
 * {@link resolveProjectArtifact} check is not trusted across the intervening
 * drift-classification/backup I/O — the containment and symlink-component
 * assertions are re-run here, immediately before the write, and the temp write +
 * rename go through the realpath-verified physical parent, so a component swapped
 * for an outside-pointing symlink after the up-front check is rejected
 * (`UNSAFE_PATH`) with no file written outside the root. Parent directories are
 * created world-readable so co-developers and CI can use the committed file.
 */
export function writeProjectArtifactAtomic(
  root: string,
  relPath: string,
  content: string,
  dirMode = 0o755,
): void {
  const resolved = resolveProjectArtifact(root, relPath);
  mkdirSync(dirname(resolved), { recursive: true, mode: dirMode });
  const physical = assertRealParentWithin(root, resolved);
  replaceAtomically(physical, content);
}
