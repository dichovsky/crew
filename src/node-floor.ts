/**
 * Node.js runtime floor enforcement.
 *
 * crew targets Node >=24.15 — the first Node 24 line where `node:sqlite` is
 * release-candidate rather than active-development stability (DEC-8, FR-A09).
 * The bin shim calls {@link assertNodeFloor} before loading the application so a
 * too-old runtime fails clearly instead of crashing deep inside the program.
 */

export const NODE_FLOOR = '24.15.0';

interface SemverParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parse(version: string): SemverParts {
  const core = version.trim().replace(/^v/, '').split('-', 1)[0] ?? '';
  const [major, minor, patch] = core.split('.');
  return {
    major: Number(major) || 0,
    minor: Number(minor) || 0,
    patch: Number(patch) || 0,
  };
}

/** True when `current` is strictly below `floor` by major/minor/patch order. */
export function isNodeBelow(current: string, floor: string): boolean {
  const c = parse(current);
  const f = parse(floor);
  if (c.major !== f.major) return c.major < f.major;
  if (c.minor !== f.minor) return c.minor < f.minor;
  return c.patch < f.patch;
}

/**
 * Throw a clear, version-bearing error when the running Node is below the floor.
 * Defaults to the live runtime version and the pinned {@link NODE_FLOOR}.
 */
export function assertNodeFloor(
  current: string = process.versions.node,
  floor: string = NODE_FLOOR,
): void {
  if (isNodeBelow(current, floor)) {
    throw new Error(`crew requires Node >=${floor} (found v${current}). Upgrade Node to run crew.`);
  }
}
