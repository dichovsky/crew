/**
 * Google Antigravity CLI Setup Target (setup-integration.md §4.5). Skill
 * discovery uses the CLI-specific `~/.gemini/antigravity-cli/skills` (user) and
 * the cross-agent `<repo>/.agents/skills` (project, shared byte-identically with
 * Codex CLI — see agent-skills.ts); the user types `/crew` and arguments.
 */
import { renderAgentSkillsArtifact } from './agent-skills.js';
import type { ParticipantTarget } from './shared.js';

export const antigravityTarget: ParticipantTarget = {
  id: 'antigravity-cli',
  category: 'participant',
  executable: 'agy',
  versionArgs: ['--version'],
  userPath: '.gemini/antigravity-cli/skills/crew/SKILL.md',
  projectPath: '.agents/skills/crew/SKILL.md',
  format: 'markdown',
  readinessNames: ['agy'],
  // Verified present on 2026-07-02; maintainer re-confirms via tests/tools/release-smoke.test.ts. doctor WARNS below it.
  minimumVerifiedVersion: '1.0.14',
  verifiedOn: '2026-07-02',
  officialSources: [
    'https://antigravity.google/docs/skills',
    'https://github.com/google-antigravity/antigravity-cli',
  ],
  permissionNote:
    'crew runs bounded one-shot commands inside the Workspace, so it fits Antigravity’s default request-review approval; do not enable --dangerously-skip-permissions. If crew still prompts, add a scoped permissions.allow command rule for "crew" in settings.json.',
  invocation(role, id, options) {
    return `/crew ${role} ${id}${options?.resume === true ? ' --resume' : ''}`;
  },
  render() {
    return renderAgentSkillsArtifact();
  },
};
