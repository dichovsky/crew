/**
 * Retention-duration parsing for maintenance commands (`prune`).
 *
 * A duration is a positive integer followed by a single unit: `s`, `m`, `h`,
 * `d`, or `w`. Compound forms (`1d12h`), fractions, zero, and negatives are
 * rejected. The result is a whole number of seconds; a value so large that
 * `now - seconds` could not stay a safe integer is rejected to mirror the
 * Store's operation-clock safe-integer guard.
 */
import { CrewError } from './errors.js';

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

const DURATION = /^(\d+)([smhdw])$/;

/** Parse a `<integer><s|m|h|d|w>` duration into whole seconds (>= 1). */
export function parseDuration(input: string): number {
  const match = DURATION.exec(input);
  if (match === null) {
    throw new CrewError(
      'USAGE',
      `invalid duration "${input}"; expected <integer><s|m|h|d|w>, for example 30d`,
    );
  }
  const count = Number(match[1]);
  const unit = UNIT_SECONDS[match[2]!]!;
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new CrewError('USAGE', `duration "${input}" must be a positive whole number of units`);
  }
  const seconds = count * unit;
  if (!Number.isSafeInteger(seconds)) {
    throw new CrewError('USAGE', `duration "${input}" is too large to compute a retention cutoff`);
  }
  return seconds;
}
