/**
 * OpenAI Codex CLI Setup Target (setup-integration.md §4.2). Skill discovery uses
 * `~/.agents/skills` (user) and `<repo>/.agents/skills` (project, shared
 * byte-identically with Antigravity CLI — see agent-skills.ts); the user types
 * `$crew` and arguments. Deprecated `.codex/prompts` is never generated.
 */
import { renderAgentSkillsArtifact } from './agent-skills.js';
import { type ParticipantTarget, VERIFIED_ON } from './shared.js';

export const codexTarget: ParticipantTarget = {
  id: 'codex-cli',
  category: 'participant',
  executable: 'codex',
  versionArgs: ['--version'],
  userPath: '.agents/skills/crew/SKILL.md',
  projectPath: '.agents/skills/crew/SKILL.md',
  format: 'markdown',
  readinessNames: ['codex'],
  // Verified present on 2026-07-01; maintainer re-confirms via tests/tools/release-smoke.test.ts. doctor WARNS below it.
  minimumVerifiedVersion: '0.142.4',
  verifiedOn: VERIFIED_ON,
  officialSources: [
    'https://developers.openai.com/codex/skills',
    'https://developers.openai.com/codex/rules',
    'https://developers.openai.com/codex/custom-prompts',
  ],
  permissionNote:
    'crew writes only inside the Workspace, so it fits Codex’s workspace-write sandbox; do not default to --ask-for-approval never. If crew still prompts, print and review a scoped ["crew"] prefix rule with codex execpolicy check.',
  invocation(role, id, options) {
    return `$crew ${role} ${id}${options?.resume === true ? ' --resume' : ''}`;
  },
  render() {
    return renderAgentSkillsArtifact();
  },
};
