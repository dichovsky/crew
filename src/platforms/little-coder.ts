/**
 * Little Coder Setup Target (setup-integration.md §4.7). Little Coder is a
 * Pi-based Participant CLI optimized for small local models. It discovers the
 * same Pi Prompt Templates as Pi CLI, so both targets render byte-identical
 * `crew.md` artifacts at the standard Pi global and project paths.
 *
 * Little Coder's Bash gate does not allow `crew` by default. Setup prints the
 * narrow LITTLE_CODER_BASH_ALLOW opt-in from permissionNote; crew never writes
 * Little Coder configuration or enables its broad accept-all permission mode.
 */
import { renderPiPromptArtifact } from './pi.js';
import type { ParticipantTarget } from './shared.js';

export const littleCoderTarget: ParticipantTarget = {
  id: 'little-coder',
  category: 'participant',
  executable: 'little-coder',
  versionArgs: ['--version'],
  // The launcher forwards --version to Pi, which reports Pi's version rather
  // than Little Coder's. Resolve the npm package beside the real launcher.
  versionPackageJson: '../package.json',
  userPath: '.pi/agent/prompts/crew.md',
  projectPath: '.pi/prompts/crew.md',
  format: 'markdown',
  readinessNames: ['little-coder'],
  // The executable is a Node launcher for Pi, so Stage 1 waits for the pane to
  // stop being a shell rather than relying on a process title.
  readinessMode: 'not-shell',
  // Initial support floor selected for the integration. The release smoke
  // checklist must verify this exact version before publication.
  minimumVerifiedVersion: '1.11.0',
  verifiedOn: '2026-07-24',
  officialSources: [
    'https://github.com/itayinbarr/little-coder',
    'https://github.com/itayinbarr/little-coder#permissions',
  ],
  permissionNote:
    'Little Coder blocks crew in its default Bash allowlist. Add only the crew prefix while preserving existing additions: export LITTLE_CODER_BASH_ALLOW="${LITTLE_CODER_BASH_ALLOW:+$LITTLE_CODER_BASH_ALLOW,}crew ". Do not use LITTLE_CODER_PERMISSION_MODE=accept-all; it bypasses the Bash gate for every command.',
  invocation(role, id, options) {
    return `/crew ${role} ${id}${options?.resume === true ? ' --resume' : ''}`;
  },
  render() {
    return renderPiPromptArtifact();
  },
};
