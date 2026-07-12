/**
 * `crew init` (FR-B04/B08/B11/B13).
 *
 * Creates the `.crew/{roles,teams,state,generated}` tree in the current
 * directory, seeds missing built-in Role/Team files without overwriting, keeps a
 * selective `.crew/.gitignore` (state + generated only, never all of `.crew/`),
 * and — with `--with-guides` — appends one marked section to each *existing*
 * `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`. It never writes under `$HOME`. Every write
 * is atomic and goes through the containment-checked managed-path helpers.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureManagedDir,
  readManagedFile,
  resolveManagedTarget,
  writeFileAtomic,
} from './fs-safe.js';
import { writeJsonLine, writeLine } from './format.js';
import type { Io } from './io.js';
import { PACKAGED_ROLES, PACKAGED_TEAMS } from './templates.js';
import { gitignoreRelPath, roleRelPath, teamRelPath, WORKSPACE_DIRNAME } from './workspace.js';

const GUIDE_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'] as const;
const GUIDE_BEGIN = '<!-- crew:begin -->';
const GUIDE_END = '<!-- crew:end -->';
const GUIDE_SECTION = `
${GUIDE_BEGIN}
## crew

This repository uses crew for local agent coordination. Run \`crew --help\` for
commands; Roles and Teams live under \`.crew/\`.
${GUIDE_END}
`;
const GITIGNORE_ENTRIES = ['state/', 'generated/'];
const GITIGNORE_HEADER = '# Managed by crew: local state and generated artifacts are not tracked.';

export interface InitOptions {
  readonly withGuides: boolean;
  readonly json: boolean;
}

export interface InitResult {
  readonly workspace: string;
  readonly seeded: string[];
  readonly skipped: string[];
  readonly gitignoreUpdated: boolean;
  readonly guidesAppended: string[];
}

/** Seed a managed file relative to `root` only when it does not already exist. */
function seedIfMissing(
  root: string,
  rel: string,
  content: string,
  seeded: string[],
  skipped: string[],
): void {
  const target = resolveManagedTarget(root, rel);
  if (existsSync(target)) {
    skipped.push(rel);
    return;
  }
  writeFileAtomic(root, rel, content);
  seeded.push(rel);
}

/** Ensure `.crew/.gitignore` ignores state + generated; returns true if it changed. */
function ensureGitignore(root: string): boolean {
  const rel = gitignoreRelPath();
  const target = resolveManagedTarget(root, rel);
  const existing = existsSync(target) ? readManagedFile(root, rel) : '';
  const present = new Set(existing.split('\n').map((line) => line.trim()));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !present.has(entry));
  if (existing !== '' && missing.length === 0) {
    return false;
  }
  const body =
    existing === ''
      ? `${GITIGNORE_HEADER}\n${missing.join('\n')}\n`
      : existing.replace(/\n*$/, '\n') + missing.join('\n') + '\n';
  writeFileAtomic(root, rel, body);
  return true;
}

/**
 * Append the marked crew section to an existing guide file, once. Skips a guide
 * that is missing, a symlink, or not a regular file so the option can never
 * write through a link outside the Workspace; writes atomically.
 */
function appendGuides(root: string): string[] {
  const appended: string[] = [];
  for (const name of GUIDE_FILES) {
    const path = join(root, name);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      continue; // does not exist — never create a guide
    }
    if (!st.isFile()) {
      continue; // symlink or non-regular file — refuse to follow/replace it
    }
    // Keep the pre-existing guide byte-for-byte intact.  Guide files are not
    // crew-managed UTF-8 documents, so a permissive string decode here could
    // replace malformed bytes before the atomic rewrite.
    const content = readFileSync(path);
    if (content.includes(Buffer.from(GUIDE_BEGIN, 'utf8'))) {
      continue; // already appended once
    }
    // Preserve the existing bytes exactly while retaining the blank line that
    // separates the appended CommonMark block from the existing guide.
    const section = content.at(-1) === 0x0a ? GUIDE_SECTION : `\n${GUIDE_SECTION}`;
    writeFileAtomic(root, path, Buffer.concat([content, Buffer.from(section, 'utf8')]));
    appended.push(name);
  }
  return appended;
}

/** Perform the filesystem effects of `init` and return a structured result. */
export function initWorkspace(io: Io, options: InitOptions): InitResult {
  const root = io.cwd;

  // Create the managed tree with symlinked-component rejection at each level, so
  // a symlinked `.crew` cannot redirect writes outside the Workspace.
  for (const rel of [
    WORKSPACE_DIRNAME,
    join(WORKSPACE_DIRNAME, 'roles'),
    join(WORKSPACE_DIRNAME, 'teams'),
    join(WORKSPACE_DIRNAME, 'state'),
    join(WORKSPACE_DIRNAME, 'generated'),
  ]) {
    ensureManagedDir(root, rel);
  }

  const seeded: string[] = [];
  const skipped: string[] = [];
  for (const [name, content] of Object.entries(PACKAGED_ROLES)) {
    seedIfMissing(root, roleRelPath(name), content, seeded, skipped);
  }
  for (const [name, content] of Object.entries(PACKAGED_TEAMS)) {
    seedIfMissing(root, teamRelPath(name), content, seeded, skipped);
  }

  const gitignoreUpdated = ensureGitignore(root);
  const guidesAppended = options.withGuides ? appendGuides(root) : [];

  return {
    workspace: join(root, WORKSPACE_DIRNAME),
    seeded,
    skipped,
    gitignoreUpdated,
    guidesAppended,
  };
}

/** Run `init`, performing effects and writing human or JSON output. */
export function runInit(io: Io, options: InitOptions): void {
  const result = initWorkspace(io, options);
  if (options.json) {
    // Record fields use snake_case per the CLI contract (FR-J02).
    writeJsonLine(io, {
      type: 'init',
      schema_version: 1,
      workspace: result.workspace,
      seeded: result.seeded,
      skipped: result.skipped,
      gitignore_updated: result.gitignoreUpdated,
      guides_appended: result.guidesAppended,
    });
    return;
  }
  writeLine(io, `Initialized crew workspace at ${result.workspace}`);
  writeLine(io, `  seeded:  ${result.seeded.length ? result.seeded.join(', ') : 'none'}`);
  writeLine(io, `  skipped: ${result.skipped.length ? result.skipped.join(', ') : 'none'}`);
  if (result.gitignoreUpdated) {
    writeLine(io, '  updated: .crew/.gitignore');
  }
  if (result.guidesAppended.length) {
    writeLine(io, `  guides:  appended to ${result.guidesAppended.join(', ')}`);
  }
}
