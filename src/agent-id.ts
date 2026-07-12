/** Shared Agent-id grammar and argument validation. */
import { CrewError } from './errors.js';

export const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Reject malformed or reserved Agent ids before any State Store mutation. */
export function assertAgentId(id: string): void {
  if (!AGENT_ID_PATTERN.test(id) || id === '@all') {
    throw new CrewError(
      'USAGE',
      `invalid agent id "${id}"; expected ${AGENT_ID_PATTERN.source} and not @all`,
    );
  }
}
