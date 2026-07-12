/**
 * GitHub Copilot CLI Setup Target (setup-integration.md §4.4). Agent profiles
 * live at `~/.copilot/agents/*.agent.md` (user) or `.github/agents/*.agent.md`
 * (project). In interactive mode the user runs `/agent`, selects `crew`, then
 * enters the role/id prompt. `tools: [execute]` exposes the shell tool; the
 * permission grant remains separate.
 */
import {
  type ParticipantTarget,
  renderSharedWorkflow,
  VERIFIED_ON,
  withContentHash,
} from './shared.js';

export const copilotTarget: ParticipantTarget = {
  id: 'copilot-cli',
  category: 'participant',
  executable: 'copilot',
  versionArgs: ['--version'],
  userPath: '.copilot/agents/crew.agent.md',
  projectPath: '.github/agents/crew.agent.md',
  format: 'markdown',
  readinessNames: ['copilot'],
  // Verified present on 2026-07-01; maintainer re-confirms via tests/tools/release-smoke.test.ts. doctor WARNS below it.
  minimumVerifiedVersion: '1.0.67',
  verifiedOn: VERIFIED_ON,
  officialSources: [
    'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli',
    'https://docs.github.com/en/copilot/how-tos/copilot-cli/allowing-tools',
  ],
  permissionNote:
    "tools: [execute] exposes the shell tool; the permission grant is separate. Prefer a scoped --allow-tool='shell(crew:*)' rule once your installed version confirms the syntax; --allow-all-tools and --yolo are broad and risky.",
  invocation(role, id, options) {
    return `/agent (select crew), then: ${role} ${id}${options?.resume === true ? ' --resume' : ''}`;
  },
  launchArgs(role, id, options) {
    return [
      '--agent=crew',
      '--prompt',
      `${role} ${id}${options?.resume === true ? ' --resume' : ''}`,
    ];
  },
  render() {
    return withContentHash(
      'markdown',
      (marker) => `---
name: crew
description: Join and coordinate through the local crew inbox and reviewed task workflow.
tools:
  - execute
---

${marker}

${renderSharedWorkflow('the role and optional id typed after selecting this agent')}
`,
    );
  },
};
