/**
 * Teams model and `teams` / display-only `team` (FR-F08/F10/F11/F13).
 *
 * A Team is a strict v1 YAML document: a project `.crew/teams/<name>.yaml`
 * overrides the packaged Team of the same name. Members expand into a roster of
 * Agent ids (`worker`, `worker-2`, ...) with collisions and over-long ids
 * detected before display, and every member Role must resolve. `team` renders
 * the roster and the exact `crew join` steps; the per-platform paste invocation
 * comes from the platform registry.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ID_PATTERN } from './agent-id.js';
import { CrewError } from './errors.js';
import { MAX_CONFIG_BYTES, readManagedFile } from './fs-safe.js';
import { writeJsonLine, writeLine } from './format.js';
import type { Io } from './io.js';
import { isParticipantId, PARTICIPANT_IDS, type ParticipantId } from './participants.js';
import { getTarget } from './platforms/registry.js';
import { roleExists } from './roles.js';
import { PACKAGED_TEAMS } from './templates.js';
import { resolveWorkspaceRoot, teamRelPath, workspacePaths } from './workspace.js';
import { loadYamlMapping } from './yaml-load.js';

/**
 * Shell-capable Participant CLI ids valid as a Team member `platform` hint. The
 * platform registry is the authoritative source; this minimal
 * vocabulary only validates the display-only hint.
 */
const PARTICIPANT_PLATFORMS = PARTICIPANT_IDS;
export type ParticipantPlatform = ParticipantId;

// AGENT_ID forbids a leading `@`, so the reserved `@all` is already rejected by
// the pattern; no separate literal check is needed.
const TEAM_NAME = /^[a-z0-9-]{1,64}$/;
// Literal `crew team <verb>` session verbs shadow `crew team <name>`, so those
// names can never address a Team (see the CLI contract's reserved-word clause).
const RESERVED_TEAM_NAMES = new Set(['stop', 'resume']);
const AGENT_ID = AGENT_ID_PATTERN;
const ROLE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_MEMBERS = 32;
const MAX_AGENTS = 64;
const MAX_REPLICAS = 32;
const TEAM_KEYS = new Set(['version', 'name', 'members']);
const MEMBER_KEYS = new Set(['id', 'role', 'replicas', 'platform']);

export interface TeamMember {
  readonly id: string;
  readonly role: string;
  readonly replicas: number;
  readonly platform: ParticipantPlatform | null;
}

export interface Team {
  readonly version: 1;
  readonly name: string;
  readonly members: readonly TeamMember[];
}

export interface RosterEntry {
  readonly agentId: string;
  readonly role: string;
  readonly replicaBase: string;
  readonly platform: ParticipantPlatform | null;
}

function invalid(label: string, detail: string): never {
  throw new CrewError('INVALID_CONFIG', `${label}: ${detail}`);
}

function assertTeamNameNotReserved(name: string): void {
  if (RESERVED_TEAM_NAMES.has(name)) {
    throw new CrewError('USAGE', `team name "${name}" is reserved`);
  }
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  const extras = Object.keys(obj).filter((key) => !allowed.has(key));
  if (extras.length > 0) {
    invalid(label, `unknown key(s): ${extras.join(', ')}`);
  }
}

function parseMember(raw: unknown, index: number, label: string): TeamMember {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    invalid(label, `member ${index} must be a mapping`);
  }
  const member = raw as Record<string, unknown>;
  rejectUnknownKeys(member, MEMBER_KEYS, `${label} member ${index}`);

  const id = member.id;
  if (typeof id !== 'string' || !AGENT_ID.test(id)) {
    invalid(label, `member ${index} id must match ${AGENT_ID.source}`);
  }
  const role = member.role;
  if (typeof role !== 'string' || !ROLE_NAME.test(role)) {
    invalid(label, `member "${id}" role must match ${ROLE_NAME.source}`);
  }

  let replicas = 1;
  if (member.replicas !== undefined) {
    if (
      typeof member.replicas !== 'number' ||
      !Number.isInteger(member.replicas) ||
      member.replicas < 1 ||
      member.replicas > MAX_REPLICAS
    ) {
      invalid(label, `member "${id}" replicas must be an integer 1-${MAX_REPLICAS}`);
    }
    replicas = member.replicas;
  }

  let platform: ParticipantPlatform | null = null;
  if (member.platform !== undefined) {
    if (typeof member.platform !== 'string' || !isParticipantId(member.platform)) {
      invalid(label, `member "${id}" platform must be one of ${PARTICIPANT_PLATFORMS.join(', ')}`);
    }
    platform = member.platform;
  }

  return { id, role, replicas, platform };
}

/** Validate a Team document, checking the `name` field against `expectedName`. */
export function parseTeam(src: string, expectedName: string, label: string): Team {
  const doc = loadYamlMapping(src, label);
  rejectUnknownKeys(doc, TEAM_KEYS, label);

  if (doc.version !== 1) {
    invalid(label, 'version must be exactly 1');
  }
  if (typeof doc.name !== 'string' || !TEAM_NAME.test(doc.name)) {
    invalid(label, `name must match ${TEAM_NAME.source}`);
  }
  assertTeamNameNotReserved(doc.name);
  if (doc.name !== expectedName) {
    invalid(label, `name "${doc.name}" must match the filename stem "${expectedName}"`);
  }
  if (!Array.isArray(doc.members) || doc.members.length < 1 || doc.members.length > MAX_MEMBERS) {
    invalid(label, `members must be a sequence of 1-${MAX_MEMBERS} templates`);
  }

  const members = doc.members.map((raw, i) => parseMember(raw, i, label));
  return { version: 1, name: doc.name, members };
}

/**
 * Expand replica templates into a roster, rejecting id collisions and any
 * generated id that violates the Agent-id grammar (e.g. a 64-char base whose
 * `-2` suffix overflows) before it reaches a `crew join` instruction (FR-F12).
 */
export function expandRoster(team: Team, label: string): RosterEntry[] {
  const roster: RosterEntry[] = [];
  const seen = new Set<string>();
  for (const member of team.members) {
    for (let n = 1; n <= member.replicas; n++) {
      const agentId = n === 1 ? member.id : `${member.id}-${n}`;
      if (!AGENT_ID.test(agentId)) {
        invalid(label, `expanded agent id "${agentId}" violates ${AGENT_ID.source}`);
      }
      if (seen.has(agentId)) {
        invalid(label, `replica expansion collides on agent id "${agentId}"`);
      }
      seen.add(agentId);
      roster.push({
        agentId,
        role: member.role,
        replicaBase: member.id,
        platform: member.platform,
      });
    }
  }
  if (roster.length > MAX_AGENTS) {
    invalid(label, `expands to ${roster.length} agents, exceeding the limit of ${MAX_AGENTS}`);
  }
  return roster;
}

function assertTeamNameArg(name: string): void {
  if (!TEAM_NAME.test(name)) {
    throw new CrewError('USAGE', `invalid team name "${name}"; expected ${TEAM_NAME.source}`);
  }
  assertTeamNameNotReserved(name);
}

/** Validate that every distinct member Role resolves to a known Role (FR-F08). */
function assertRolesResolvable(io: Io, name: string, team: Team): void {
  const roles = [...new Set(team.members.map((m) => m.role))];
  for (const role of roles) {
    if (!roleExists(io, role)) {
      invalid(`team "${name}"`, `member role "${role}" does not resolve to a known Role`);
    }
  }
}

/** Load and validate a Team by name; project file overrides the packaged Team. */
export function loadTeam(io: Io, name: string): Team {
  assertTeamNameArg(name);
  const root = resolveWorkspaceRoot(io.cwd);
  const path = join(workspacePaths(root).teams, `${name}.yaml`);
  let team: Team;
  if (existsSync(path)) {
    team = parseTeam(
      readManagedFile(root, teamRelPath(name), MAX_CONFIG_BYTES),
      name,
      `team "${name}"`,
    );
  } else if (Object.prototype.hasOwnProperty.call(PACKAGED_TEAMS, name)) {
    team = parseTeam(PACKAGED_TEAMS[name]!, name, `packaged team "${name}"`);
  } else {
    throw new CrewError('NOT_FOUND', `no team named "${name}"`);
  }
  assertRolesResolvable(io, name, team);
  return team;
}

export interface TeamSummary {
  readonly name: string;
  readonly source: 'packaged' | 'project';
  /** True when a packaged Team of this name exists (so a project file overrides it). */
  readonly builtin: boolean;
}

/** A project Team file whose managed read failed during a tolerant listing. */
export interface TeamListFailure {
  readonly name: string;
  readonly error: unknown;
}

export interface TeamListing {
  readonly teams: TeamSummary[];
  readonly failures: TeamListFailure[];
}

/**
 * List Teams tolerantly: one unreadable or invalid project file becomes a
 * per-file failure instead of aborting the whole listing, so `doctor` can
 * degrade each bad file to a finding while still checking every remaining
 * valid Team. Enumeration matches `listTeams` exactly.
 */
export function listTeamsWithFailures(io: Io): TeamListing {
  const root = resolveWorkspaceRoot(io.cwd);
  const teamsDir = workspacePaths(root).teams;
  const projectNames = existsSync(teamsDir)
    ? readdirSync(teamsDir, { withFileTypes: true })
        .filter((d) => (d.isFile() || d.isSymbolicLink()) && d.name.endsWith('.yaml'))
        .map((d) => d.name.slice(0, -'.yaml'.length))
        .filter((stem) => TEAM_NAME.test(stem) && !RESERVED_TEAM_NAMES.has(stem))
    : [];
  const names = [...new Set([...Object.keys(PACKAGED_TEAMS), ...projectNames])].sort();
  const teams: TeamSummary[] = [];
  const failures: TeamListFailure[] = [];
  for (const name of names) {
    const builtin = Object.prototype.hasOwnProperty.call(PACKAGED_TEAMS, name);
    if (!projectNames.includes(name)) {
      teams.push({ name, source: 'packaged', builtin });
      continue;
    }
    try {
      const content = readManagedFile(root, teamRelPath(name), MAX_CONFIG_BYTES);
      const source = builtin && content === PACKAGED_TEAMS[name] ? 'packaged' : 'project';
      teams.push({ name, source, builtin });
    } catch (err) {
      failures.push({ name, error: err });
    }
  }
  return { teams, failures };
}

/**
 * List available Teams (packaged plus project), sorted, with their source. Only
 * regular files with valid Team-name stems are enumerated; a project file
 * byte-identical to the packaged Team reports as `packaged` (mirrors `roles`).
 * Strict: the first unreadable project file aborts the listing.
 */
export function listTeams(io: Io): TeamSummary[] {
  const { teams, failures } = listTeamsWithFailures(io);
  if (failures.length > 0) throw failures[0]!.error;
  return teams;
}

/** `crew teams`: list available Teams. */
export function runTeamsList(io: Io, options: { json: boolean }): void {
  const teams = listTeams(io);
  if (options.json) {
    for (const team of teams) {
      writeJsonLine(io, { type: 'team', schema_version: 1, name: team.name, source: team.source });
    }
    return;
  }
  writeLine(io, 'NAME              SOURCE');
  for (const team of teams) {
    writeLine(io, `${team.name.padEnd(17)} ${team.source}`);
  }
}

function joinCommand(entry: RosterEntry, platform: ParticipantPlatform | null): string {
  const base = `crew join ${entry.agentId} --role ${entry.role}`;
  return platform ? `${base} --platform ${platform}` : base;
}

/**
 * The exact per-platform paste invocation from the authoritative registry
 * (FR-F13), or `null` when no platform resolves for this member.
 */
function platformInvocation(
  platform: ParticipantPlatform | null,
  entry: RosterEntry,
): string | null {
  if (platform === null) return null;
  const target = getTarget(platform);
  if (target === undefined || target.category !== 'participant') return null;
  return target.invocation(entry.role, entry.agentId);
}

/**
 * `crew team <name> [--client <platform>]`: display the expanded roster and the
 * exact `crew join` steps. `--client` overrides every member's platform hint.
 */
export function runTeamShow(
  io: Io,
  name: string,
  options: { client?: string; json: boolean },
): void {
  let client: ParticipantPlatform | null = null;
  if (options.client !== undefined) {
    if (!isParticipantId(options.client)) {
      throw new CrewError(
        'USAGE',
        `invalid --client "${options.client}"; expected one of ${PARTICIPANT_PLATFORMS.join(', ')}`,
      );
    }
    client = options.client;
  }

  const team = loadTeam(io, name);
  const roster = expandRoster(team, `team "${name}"`);
  const effective = (entry: RosterEntry): ParticipantPlatform | null => client ?? entry.platform;

  if (options.json) {
    for (const entry of roster) {
      const platform = effective(entry);
      const invocation = platformInvocation(platform, entry);
      writeJsonLine(io, {
        type: 'team_member',
        schema_version: 1,
        team: team.name,
        agent_id: entry.agentId,
        role: entry.role,
        replica_base: entry.replicaBase,
        platform,
        join_command: joinCommand(entry, platform),
        ...(invocation !== null ? { invocation } : {}),
      });
    }
    return;
  }

  writeLine(io, `TEAM ${team.name} (${roster.length} agents)`);
  for (const entry of roster) {
    const platform = effective(entry);
    const invocation = platformInvocation(platform, entry);
    writeLine(
      io,
      ` ${entry.agentId.padEnd(16)} role=${entry.role.padEnd(10)} platform=${platform ?? '-'}` +
        (invocation !== null ? ` invoke=${invocation}` : ''),
    );
  }
  writeLine(io, 'Join:');
  for (const entry of roster) {
    writeLine(io, `  ${joinCommand(entry, effective(entry))}`);
  }
}
