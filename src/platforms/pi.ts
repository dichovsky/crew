/**
 * Pi CLI Setup Target (setup-integration.md §4.6). Pi discovers Prompt Templates
 * as Markdown files under `~/.pi/agent/prompts/` (user) and `.pi/prompts/`
 * (project); the file's basename becomes the slash command, so `crew.md` exposes
 * `/crew` and `$ARGUMENTS` interpolates the operator's `<role> [id]`. Pi has no
 * permission/approval model by design, so crew ships no gating code and relies on
 * the Workspace/OS boundary (see permissionNote).
 */
import { type ParticipantTarget, renderSharedWorkflow, withContentHash } from './shared.js';

/** Shared Pi Prompt Template bytes discovered by both Pi CLI and Little Coder. */
export function renderPiPromptArtifact(): string {
  return withContentHash(
    'markdown',
    (marker) => `---
description: Join and coordinate through the local crew inbox and reviewed task workflow.
argument-hint: <manager|worker|inspector> [agent-id]
---

${marker}

Use the finite crew workflow below for \`$ARGUMENTS\`.
${renderSharedWorkflow('$ARGUMENTS')}
`,
  );
}

export const piTarget: ParticipantTarget = {
  id: 'pi-cli',
  category: 'participant',
  executable: 'pi',
  versionArgs: ['--version'],
  userPath: '.pi/agent/prompts/crew.md',
  projectPath: '.pi/prompts/crew.md',
  format: 'markdown',
  readinessNames: ['pi'],
  // pi runs under a node interpreter, so the live tmux pane title may report
  // `node` rather than `pi` — Stage 1 waits for the pane to stop being a shell.
  // Re-probe live to tighten to readinessMode 'names' if the pane cleanly
  // reports `pi`.
  readinessMode: 'not-shell',
  // Verified present on 2026-07-14 (pi --version reported 0.80.6); the maintainer
  // re-confirms functional behaviour via tests/tools/release-smoke.test.ts and
  // adjusts this floor before publish. `doctor` WARNS (never blocks) below it.
  minimumVerifiedVersion: '0.80.6',
  verifiedOn: '2026-07-14',
  officialSources: ['https://pi.dev/docs/latest', 'https://github.com/earendil-works/pi'],
  permissionNote:
    'pi has no per-command approval or sandbox by design; every shell command (including crew) runs unrestricted and crew ships no gating code. Scope by running pi inside crew’s Workspace boundary — crew writes only inside the Workspace and runs bounded one-shot crew commands — plus any OS/container isolation.',
  invocation(role, id, options) {
    return `/crew ${role} ${id}${options?.resume === true ? ' --resume' : ''}`;
  },
  render() {
    return renderPiPromptArtifact();
  },
};
