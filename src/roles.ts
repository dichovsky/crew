/**
 * Roles model and `roles` / `role show` / `role export` (FR-F01/F02/F04).
 *
 * A Role is resolved by name: a project `.crew/roles/<name>.md` overrides the
 * packaged Role of the same name. Listing and show identify the source; export
 * copies a packaged Role into the project and never overwrites without --force.
 * Project files are read through the containment-checked, size-limited,
 * strictly-UTF-8 managed-read path.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CrewError } from './errors.js';
import {
  MAX_CONFIG_BYTES,
  readManagedFile,
  resolveManagedTarget,
  writeFileAtomic,
} from './fs-safe.js';
import { sanitizeHuman, writeJsonLine, writeLine } from './format.js';
import type { Io } from './io.js';
import { PACKAGED_ROLES } from './templates.js';
import { resolveWorkspaceRoot, roleRelPath, workspacePaths } from './workspace.js';

const ROLE_NAME = /^[a-z][a-z0-9-]{0,63}$/;

export type RoleSource = 'packaged' | 'project';

export interface RoleInfo {
  readonly name: string;
  readonly source: RoleSource;
  /** True when a packaged Role of this name exists (so a project file overrides it). */
  readonly builtin: boolean;
  readonly version: number | null;
}

export interface ResolvedRole extends RoleInfo {
  readonly body: string;
}

/** Validate a Role name argument; malformed names are a usage error. */
function assertRoleName(name: string): void {
  if (!ROLE_NAME.test(name)) {
    throw new CrewError('USAGE', `invalid role name "${name}"; expected ${ROLE_NAME.source}`);
  }
}

/** Read the packaged Role version from its frontmatter, or null. */
function parseVersion(content: string): number | null {
  const block = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!block) {
    return null;
  }
  const match = /^crew_version:[ \t]*(\d+)[ \t]*$/m.exec(block[1]!);
  return match ? Number(match[1]) : null;
}

/**
 * Classify a Role by name and (optional) on-disk project content. A project file
 * byte-identical to the packaged Role is an unmodified seed and reports as
 * `packaged`; an edited file, or one with no packaged counterpart, is `project`.
 */
function infoFor(name: string, projectContent: string | null): RoleInfo {
  const builtin = Object.prototype.hasOwnProperty.call(PACKAGED_ROLES, name);
  const unmodifiedSeed =
    builtin && projectContent !== null && projectContent === PACKAGED_ROLES[name];
  const source: RoleSource = projectContent === null || unmodifiedSeed ? 'packaged' : 'project';
  const effective = projectContent ?? (builtin ? PACKAGED_ROLES[name]! : null);
  return { name, source, builtin, version: effective === null ? null : parseVersion(effective) };
}

/** A project Role file whose managed read failed during a tolerant listing. */
export interface RoleListFailure {
  readonly name: string;
  readonly error: unknown;
}

export interface RoleListing {
  readonly roles: RoleInfo[];
  readonly failures: RoleListFailure[];
}

/**
 * List Roles tolerantly: one unreadable or invalid project file becomes a
 * per-file failure instead of aborting the whole listing, so `doctor` can
 * degrade each bad file to a finding while still checking every remaining
 * valid Role. Enumeration matches `listRoles` exactly.
 */
export function listRolesWithFailures(io: Io): RoleListing {
  const root = resolveWorkspaceRoot(io.cwd);
  const rolesDir = workspacePaths(root).roles;
  const projectNames = existsSync(rolesDir)
    ? readdirSync(rolesDir, { withFileTypes: true })
        .filter((d) => (d.isFile() || d.isSymbolicLink()) && d.name.endsWith('.md'))
        .map((d) => d.name.slice(0, -'.md'.length))
        .filter((stem) => ROLE_NAME.test(stem))
    : [];
  const names = [...new Set([...Object.keys(PACKAGED_ROLES), ...projectNames])].sort();
  const roles: RoleInfo[] = [];
  const failures: RoleListFailure[] = [];
  for (const name of names) {
    try {
      const projectContent = projectNames.includes(name)
        ? readManagedFile(root, roleRelPath(name), MAX_CONFIG_BYTES)
        : null;
      roles.push(infoFor(name, projectContent));
    } catch (err) {
      failures.push({ name, error: err });
    }
  }
  return { roles, failures };
}

/**
 * List all available Roles (packaged plus project), sorted, with their source.
 * Regular files and symlinks with valid Role-name stems are enumerated; a
 * symlink is then rejected by managed reads rather than silently masked by a
 * packaged Role. Directories and malformed names are ignored. Strict: the
 * first unreadable project file aborts the listing.
 */
export function listRoles(io: Io): RoleInfo[] {
  const { roles, failures } = listRolesWithFailures(io);
  if (failures.length > 0) throw failures[0]!.error;
  return roles;
}

/** True when `name` resolves to a project or packaged Role (no content read). */
export function roleExists(io: Io, name: string): boolean {
  if (!ROLE_NAME.test(name)) {
    return false;
  }
  const root = resolveWorkspaceRoot(io.cwd);
  if (existsSync(join(workspacePaths(root).roles, `${name}.md`))) {
    return true;
  }
  return Object.prototype.hasOwnProperty.call(PACKAGED_ROLES, name);
}

/** Resolve a single Role's content and source; project overrides packaged. */
export function resolveRole(io: Io, name: string): ResolvedRole {
  assertRoleName(name);
  const root = resolveWorkspaceRoot(io.cwd);
  const path = join(workspacePaths(root).roles, `${name}.md`);
  if (existsSync(path)) {
    const body = readManagedFile(root, roleRelPath(name), MAX_CONFIG_BYTES);
    return { ...infoFor(name, body), body };
  }
  if (Object.prototype.hasOwnProperty.call(PACKAGED_ROLES, name)) {
    const body = PACKAGED_ROLES[name]!;
    return { ...infoFor(name, null), body };
  }
  throw new CrewError('NOT_FOUND', `no role named "${name}"`);
}

export interface RoleExportResult {
  readonly name: string;
  readonly path: string;
  readonly forced: boolean;
}

/** Copy a packaged Role into the project, refusing to overwrite without --force. */
export function exportRole(io: Io, name: string, force: boolean): RoleExportResult {
  assertRoleName(name);
  if (!Object.prototype.hasOwnProperty.call(PACKAGED_ROLES, name)) {
    throw new CrewError('NOT_FOUND', `no built-in role named "${name}" to export`);
  }
  const root = resolveWorkspaceRoot(io.cwd);
  const rel = roleRelPath(name);
  const target = resolveManagedTarget(root, rel);
  const overwriting = existsSync(target);
  if (overwriting && !force) {
    throw new CrewError(
      'ALREADY_EXISTS',
      `role "${name}" already exists at ${rel}; pass --force to overwrite`,
    );
  }
  writeFileAtomic(root, rel, PACKAGED_ROLES[name]!);
  return { name, path: rel, forced: overwriting };
}

function roleRecord(info: RoleInfo): Record<string, unknown> {
  return {
    type: 'role',
    schema_version: 1,
    name: info.name,
    source: info.source,
    builtin: info.builtin,
    version: info.version,
  };
}

/** `crew roles`: list available Roles. */
export function runRolesList(io: Io, options: { json: boolean }): void {
  const roles = listRoles(io);
  if (options.json) {
    for (const role of roles) {
      writeJsonLine(io, roleRecord(role));
    }
    return;
  }
  writeLine(io, 'NAME              SOURCE     VERSION');
  for (const role of roles) {
    const version = role.version === null ? '-' : String(role.version);
    writeLine(io, `${role.name.padEnd(17)} ${role.source.padEnd(10)} ${version}`);
  }
}

/** `crew role show <name>`: print a Role's source and body. */
export function runRoleShow(io: Io, name: string, options: { json: boolean }): void {
  const role = resolveRole(io, name);
  if (options.json) {
    // JSON preserves the stored body verbatim (FR-J11).
    writeJsonLine(io, { ...roleRecord(role), body: role.body });
    return;
  }
  writeLine(io, `Role    ${role.name}`);
  writeLine(io, `Source  ${role.source}${role.builtin ? ' (built-in available)' : ''}`);
  writeLine(io, `Version ${role.version === null ? '-' : String(role.version)}`);
  writeLine(io, '');
  // Human surface strips ANSI/control sequences so a Role body cannot manipulate
  // the terminal or impersonate crew output (FR-J08).
  const safe = sanitizeHuman(role.body);
  io.stdout(safe.endsWith('\n') ? safe : `${safe}\n`);
}

/** `crew role export <name> [--force]`: copy a packaged Role into the project. */
export function runRoleExport(
  io: Io,
  name: string,
  options: { force: boolean; json: boolean },
): void {
  const result = exportRole(io, name, options.force);
  if (options.json) {
    writeJsonLine(io, {
      type: 'role_export',
      schema_version: 1,
      name: result.name,
      path: result.path,
      forced: result.forced,
    });
    return;
  }
  writeLine(
    io,
    `${result.forced ? 'Overwrote' : 'Exported'} role "${result.name}" to ${result.path}`,
  );
}
