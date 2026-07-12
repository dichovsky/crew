/**
 * Gemini CLI Setup Target (setup-integration.md §4.3). Custom commands are TOML
 * files under `.gemini/commands`; project files override user files and the user
 * types `/crew`. The workflow is a single prompt — never a `!{crew ...}` shell
 * injection, which cannot implement a multi-step Agent turn.
 */
import {
  type ParticipantTarget,
  renderSharedWorkflow,
  VERIFIED_ON,
  withContentHash,
} from './shared.js';

export const geminiTarget: ParticipantTarget = {
  id: 'gemini-cli',
  category: 'participant',
  executable: 'gemini',
  versionArgs: ['--version'],
  userPath: '.gemini/commands/crew.toml',
  projectPath: '.gemini/commands/crew.toml',
  format: 'toml',
  readinessNames: ['gemini'],
  // Live tmux reports gemini's `node` interpreter as the pane command, never
  // "gemini" — Stage 1 waits for the pane to stop being a shell instead.
  readinessMode: 'not-shell',
  // Verified present on 2026-07-01; maintainer re-confirms via tests/tools/release-smoke.test.ts. doctor WARNS below it.
  minimumVerifiedVersion: '0.46.0',
  verifiedOn: VERIFIED_ON,
  officialSources: [
    'https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/custom-commands.md',
  ],
  permissionNote:
    'Tool confirmation stays governed by Gemini policy; the model calls run_shell_command for crew. crew prints the narrowest version-appropriate guidance and never enables --yolo.',
  invocation(role, id, options) {
    return `/crew ${role} ${id}${options?.resume === true ? ' --resume' : ''}`;
  },
  render() {
    return withContentHash(
      'toml',
      (marker) => `${marker}
description = "Join and coordinate through the local crew inbox and reviewed task workflow"
prompt = """
Role and optional id: {{args}}
${renderSharedWorkflow('{{args}}')}
"""
`,
    );
  },
};
