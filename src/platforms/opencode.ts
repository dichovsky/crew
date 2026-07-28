/**
 * opencode CLI Setup Target (setup-integration.md §4.8). opencode discovers
 * custom commands as Markdown files under `~/.config/opencode/commands/` (user)
 * and `.opencode/commands/` (project); the file's basename becomes the slash
 * command, so `crew.md` exposes `/crew` and `$ARGUMENTS` interpolates the
 * operator's `<role> [id]`. Shell approval is scoped via opencode.json's
 * permission.bash glob map (see permissionNote); crew writes no opencode.json.
 */
import { type ParticipantTarget, renderSharedWorkflow, withContentHash } from './shared.js';

export const opencodeTarget: ParticipantTarget = {
  id: 'opencode-cli',
  category: 'participant',
  executable: 'opencode',
  versionArgs: ['--version'],
  userPath: '.config/opencode/commands/crew.md',
  projectPath: '.opencode/commands/crew.md',
  format: 'markdown',
  readinessNames: ['opencode'],
  // The npm `opencode` bin is a node launcher that spawns a native child, so the
  // live tmux pane title may briefly report `node` — Stage 1 waits for the pane
  // to stop being a shell. Re-probe live to tighten to readinessMode 'names' if
  // the pane cleanly reports `opencode`.
  readinessMode: 'not-shell',
  // Verified present on 2026-07-14 (opencode --version reported 1.17.19); the
  // maintainer re-confirms via tests/tools/release-smoke.test.ts. doctor WARNS below it.
  minimumVerifiedVersion: '1.17.19',
  verifiedOn: '2026-07-14',
  officialSources: ['https://opencode.ai/docs', 'https://github.com/anomalyco/opencode'],
  permissionNote:
    'Scope shell approval with the permission.bash glob map in opencode.json (last-match-wins): { "*": "ask", "crew *": "allow" } with the catch-all listed first, so only crew commands auto-approve. Do not enable --auto; it approves everything not explicitly denied and defeats the crew-only scope.',
  invocation(role, id, options) {
    return `/crew ${role} ${id}${options?.resume === true ? ' --resume' : ''}`;
  },
  render() {
    return withContentHash(
      'markdown',
      (marker) => `---
description: Join and coordinate through the local crew inbox and reviewed task workflow.
---

${marker}

Use the finite crew workflow below for \`$ARGUMENTS\`.
${renderSharedWorkflow('$ARGUMENTS')}
`,
    );
  },
};
