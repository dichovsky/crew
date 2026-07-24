/**
 * Shared v1 vocabulary for shell-capable Participant CLI ids.
 *
 * This is intentionally only an id vocabulary. Invocation, setup, version, and
 * executable facts remain owned by the platform registry.
 */
export const PARTICIPANT_IDS = [
  'claude-code',
  'codex-cli',
  'gemini-cli',
  'copilot-cli',
  'antigravity-cli',
  'pi-cli',
  'little-coder',
  'opencode-cli',
] as const;

export type ParticipantId = (typeof PARTICIPANT_IDS)[number];

/** Runtime check for values arriving from CLI arguments or configuration. */
export function isParticipantId(value: string): value is ParticipantId {
  return PARTICIPANT_IDS.includes(value as ParticipantId);
}
