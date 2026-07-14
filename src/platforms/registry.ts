/**
 * The authoritative platform registry (ADR-0006, FR-G01). Setup, doctor, Team
 * display, and the Launcher resolve Setup Target facts here — install paths,
 * invocations, executables, version probes, and backend recipes — so no caller
 * keeps a parallel path/invocation table that could drift across Modules.
 */
import { antigravityTarget } from './antigravity.js';
import { claudeTarget } from './claude.js';
import { codexTarget } from './codex.js';
import { copilotTarget } from './copilot.js';
import { geminiTarget } from './gemini.js';
import { lmstudioTarget } from './lmstudio.js';
import { ollamaTarget } from './ollama.js';
import { opencodeTarget } from './opencode.js';
import { piTarget } from './pi.js';
import type { BackendTarget, ParticipantTarget, SetupTarget, SetupTargetId } from './shared.js';

/** Participant CLI targets, in canonical display order. */
export const PARTICIPANT_TARGETS: readonly ParticipantTarget[] = [
  claudeTarget,
  codexTarget,
  geminiTarget,
  copilotTarget,
  antigravityTarget,
  piTarget,
  opencodeTarget,
];

/** Model Backend targets, in canonical display order. */
export const BACKEND_TARGETS: readonly BackendTarget[] = [ollamaTarget, lmstudioTarget];

/** Every Setup Target (participants then backends). */
export const ALL_TARGETS: readonly SetupTarget[] = [...PARTICIPANT_TARGETS, ...BACKEND_TARGETS];

const BY_ID: ReadonlyMap<string, SetupTarget> = new Map(ALL_TARGETS.map((t) => [t.id, t]));

/** True when `id` names a known Setup Target. */
export function isSetupTargetId(id: string): id is SetupTargetId {
  return BY_ID.has(id);
}

/** Resolve a Setup Target by id, or `undefined` when unknown. */
export function getTarget(id: string): SetupTarget | undefined {
  return BY_ID.get(id);
}

export type {
  ArtifactFormat,
  BackendCheck,
  BackendTarget,
  DriftState,
  ParticipantTarget,
  SetupCategory,
  SetupTarget,
  SetupTargetId,
  VersionProbe,
} from './shared.js';
export { REGISTRY_REVISION } from './shared.js';
