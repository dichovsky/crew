/**
 * Ollama Model Backend (setup-integration.md §5.1). `crew setup ollama` checks
 * that `ollama` exists and whether the local endpoint is reachable, then prints
 * a Participant-CLI recipe. It never starts a server, pulls a model, or edits
 * shell startup files, and contacts no remote endpoint.
 */
import type { Io } from '../io.js';
import { resolveExecutableOnPath } from '../which.js';
import {
  type BackendCheck,
  type BackendTarget,
  VERIFIED_ON,
  VERSION_PROBE_TIMEOUT_MS,
} from './shared.js';

export const ollamaTarget: BackendTarget = {
  id: 'ollama',
  category: 'backend',
  executable: 'ollama',
  versionArgs: ['--version'],
  minimumVerifiedVersion: null,
  verifiedOn: VERIFIED_ON,
  officialSources: [
    'https://docs.ollama.com/integrations/codex',
    'https://docs.ollama.com/integrations/claude-code',
    'https://docs.ollama.com/integrations/copilot-cli',
  ],
  async checks(io: Io): Promise<readonly BackendCheck[]> {
    // Spawn the exact absolute path the presence check resolved.
    const executable = resolveExecutableOnPath(io.env, 'ollama');
    const present = executable !== null;
    const checks: BackendCheck[] = [
      {
        name: 'executable',
        ok: present,
        detail: present ? 'ollama found on PATH' : 'ollama not found on PATH',
      },
    ];
    if (executable !== null) {
      const result = await io.runProcess(executable, ['list'], {
        timeoutMs: VERSION_PROBE_TIMEOUT_MS,
      });
      const reachable = result.status === 0;
      checks.push({
        name: 'endpoint',
        ok: reachable,
        detail: reachable
          ? 'local Ollama endpoint reachable'
          : 'local Ollama endpoint not reachable (start it with: ollama serve)',
      });
    }
    return checks;
  },
  recipe(): readonly string[] {
    return [
      'Ollama serves a Participant CLI; crew never contacts it. Pick your CLI:',
      'Codex:      ollama launch codex   (or: codex --oss)',
      '            persistent profile: base_url = "http://localhost:11434/v1/", wire_api = "responses"',
      'Claude Code: ollama launch claude',
      '            manual: ANTHROPIC_BASE_URL=http://localhost:11434,',
      '                    ANTHROPIC_AUTH_TOKEN=ollama, and unset ANTHROPIC_API_KEY',
      'Copilot CLI: ollama launch copilot',
      '            manual: COPILOT_PROVIDER_BASE_URL=http://localhost:11434/v1,',
      '                    COPILOT_PROVIDER_WIRE_API=responses, COPILOT_PROVIDER_API_KEY=,',
      '                    COPILOT_MODEL=<model>',
      'Little Coder: OLLAMA_API_KEY=noop little-coder --model ollama/<model>',
      'Use at least a 64k context window for the Codex/Copilot paths.',
    ];
  },
};
