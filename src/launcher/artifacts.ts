/**
 * Write the launch's generated artifacts under `.crew/generated/<session>/`
 * (configuration.md "Generated artifacts"). Every write is a
 * containment-checked, atomic managed write via fs-safe; the directory is
 * Git-ignored and never re-loaded as trusted config.
 *
 * Two moments: `writePlanArtifacts` runs before tmux (launch-plan.json + the
 * Manager/Inspector prompts + run-summary), returning the Manager prompt's
 * absolute path so the brief step can `load-buffer` it; the
 * pane-map — the only artifact carrying realized pane ids and invocation text —
 * is written by `writePaneMap` after the panes exist.
 */
import { join } from 'node:path';
import { CrewError } from '../errors.js';
import {
  ensureManagedDir,
  readManagedFile,
  writeFileAtomic,
  MAX_CONFIG_BYTES,
} from '../fs-safe.js';
import { serializeLaunchPlan } from '../format.js';
import type { LaunchPlan } from './plan.js';

const LAUNCH_PLAN = 'launch-plan.json';
const MANAGER_PROMPT = 'manager-prompt.md';
const INSPECTOR_PROMPT = 'inspector-prompt.md';
const RUN_SUMMARY = 'run-summary.md';
const PANE_MAP = 'pane-map.json';
const RESUME_MARKER = 'resume.json';

/** Stable 2-space JSON with a trailing newline, matching the launch-plan fixture. */
function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export interface PlanArtifacts {
  readonly launchPlan: LaunchPlan;
  readonly managerPrompt: string;
  /** Null when the roster has no Inspector (no inspector-prompt.md is written). */
  readonly inspectorPrompt: string | null;
  readonly runSummary: string;
}

export interface GeneratedPaths {
  readonly dir: string;
  /** Absolute path of the Manager prompt — the file the brief step load-buffers. */
  readonly managerPromptPath: string;
}

/** Workspace-relative generated directory for a session (containment-checked on use). */
function generatedRel(sessionName: string): string {
  return join('.crew', 'generated', sessionName);
}

/** Write the pre-tmux artifacts; returns the generated dir and Manager prompt path. */
export function writePlanArtifacts(
  root: string,
  sessionName: string,
  artifacts: PlanArtifacts,
): GeneratedPaths {
  const dir = ensureManagedDir(root, generatedRel(sessionName));
  writeFileAtomic(root, join(dir, LAUNCH_PLAN), serializeLaunchPlan(artifacts.launchPlan));
  const managerPromptPath = join(dir, MANAGER_PROMPT);
  writeFileAtomic(root, managerPromptPath, artifacts.managerPrompt);
  if (artifacts.inspectorPrompt !== null) {
    writeFileAtomic(root, join(dir, INSPECTOR_PROMPT), artifacts.inspectorPrompt);
  }
  writeFileAtomic(root, join(dir, RUN_SUMMARY), artifacts.runSummary);
  return { dir, managerPromptPath };
}

export interface PaneMapPane {
  readonly pane_id: string;
  readonly window: string;
  readonly agent_id: string;
  readonly role: string;
  readonly executable: string;
  readonly invocation: string;
  readonly readiness_names: readonly string[];
}

export interface PaneMap {
  readonly schema_version: 1;
  readonly session_name: string;
  /** Random launch-instance marker mirrored into the live tmux session. */
  readonly ownership_token: string;
  readonly relay_window: {
    readonly present: boolean;
    readonly name: string;
    /** The realized Relay pane; null only in the pre-Relay map used during startup. */
    readonly pane_id: string | null;
  };
  readonly panes: readonly PaneMapPane[];
}

/** Write pane-map.json (realized pane assignment) after the session exists. */
export function writePaneMap(root: string, sessionName: string, paneMap: PaneMap): string {
  const dir = ensureManagedDir(root, generatedRel(sessionName));
  const path = join(dir, PANE_MAP);
  writeFileAtomic(root, path, serializeJson(paneMap));
  return path;
}

export interface ResumeMarker {
  readonly schema_version: 1;
  readonly session_name: string;
  readonly stopped_at: number;
  readonly agents_archived: number;
  readonly cleanly_stopped: true;
}

/** Write resume.json when a Team stop completed cleanly. */
export function writeResumeMarker(root: string, sessionName: string, marker: ResumeMarker): string {
  const dir = ensureManagedDir(root, generatedRel(sessionName));
  const path = join(dir, RESUME_MARKER);
  writeFileAtomic(root, path, serializeJson(marker));
  return path;
}

/** Read and validate a clean-stop resume marker. */
export function readResumeMarker(root: string, sessionName: string): ResumeMarker {
  const rel = join('.crew', 'generated', sessionName, RESUME_MARKER);
  const raw = readManagedFile(root, rel, MAX_CONFIG_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CrewError('INVALID_CONFIG', `${rel} is not valid JSON`);
  }
  const marker = parsed as Partial<ResumeMarker>;
  if (
    marker.schema_version !== 1 ||
    marker.session_name !== sessionName ||
    marker.cleanly_stopped !== true ||
    typeof marker.stopped_at !== 'number' ||
    typeof marker.agents_archived !== 'number'
  ) {
    throw new CrewError(
      'INVALID_CONFIG',
      `${rel} is not a valid resume marker for "${sessionName}"`,
    );
  }
  return marker as ResumeMarker;
}
