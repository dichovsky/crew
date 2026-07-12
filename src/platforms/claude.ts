/**
 * Claude Code Setup Target (setup-integration.md §4.1). Skills live under
 * `.claude/skills/<name>/SKILL.md` and expose `/crew`. `allowed-tools:
 * Bash(crew *)` scopes the grant to crew commands while the skill is active.
 */
import {
  type ParticipantTarget,
  renderSharedWorkflow,
  VERIFIED_ON,
  withContentHash,
} from './shared.js';

export const claudeTarget: ParticipantTarget = {
  id: 'claude-code',
  category: 'participant',
  executable: 'claude',
  versionArgs: ['--version'],
  userPath: '.claude/skills/crew/SKILL.md',
  projectPath: '.claude/skills/crew/SKILL.md',
  format: 'markdown',
  readinessNames: ['claude'],
  // Live tmux reports claude's versioned process title (e.g. "2.1.198"), never
  // "claude" — Stage 1 waits for the pane to stop being a shell instead.
  readinessMode: 'not-shell',
  // Verified present on 2026-07-01; the maintainer re-confirms functional behaviour
  // via tests/tools/release-smoke.test.ts and adjusts this floor before publish.
  // `doctor` WARNS (never blocks) below it.
  minimumVerifiedVersion: '2.1.197',
  verifiedOn: VERIFIED_ON,
  officialSources: ['https://code.claude.com/docs/en/slash-commands'],
  permissionNote:
    'allowed-tools: Bash(crew *) scopes approval to crew commands while the skill is active; a project skill needs accepted workspace trust. crew never enables --dangerously-skip-permissions.',
  invocation(role, id, options) {
    return `/crew ${role} ${id}${options?.resume === true ? ' --resume' : ''}`;
  },
  render() {
    return withContentHash(
      'markdown',
      (marker) => `---
name: crew
description: Join and coordinate through the local crew inbox and reviewed task workflow.
disable-model-invocation: true
allowed-tools: Bash(crew *)
argument-hint: <manager|worker|inspector> [agent-id]
---

${marker}

Use the finite crew workflow below for \`$ARGUMENTS\`.
${renderSharedWorkflow('$ARGUMENTS')}
`,
    );
  },
};
