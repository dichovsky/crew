/**
 * LM Studio Model Backend (setup-integration.md §5.2). `crew setup lmstudio`
 * checks for `lms` and a reachable server, then prints (but never runs) the
 * server/model commands and a Participant-CLI recipe. It edits no third-party
 * model configuration and contacts no remote endpoint.
 */
import type { Io } from '../io.js';
import { resolveExecutableOnPath } from '../which.js';
import {
  type BackendCheck,
  type BackendTarget,
  VERIFIED_ON,
  VERSION_PROBE_TIMEOUT_MS,
} from './shared.js';

export const lmstudioTarget: BackendTarget = {
  id: 'lmstudio',
  category: 'backend',
  executable: 'lms',
  versionArgs: ['version'],
  minimumVerifiedVersion: null,
  verifiedOn: VERIFIED_ON,
  officialSources: [
    'https://lmstudio.ai/docs/integrations/codex',
    'https://lmstudio.ai/docs/integrations/claude-code',
    'https://lmstudio.ai/docs/cli/local-models/load',
  ],
  async checks(io: Io): Promise<readonly BackendCheck[]> {
    // Spawn the exact absolute path the presence check resolved.
    const executable = resolveExecutableOnPath(io.env, 'lms');
    const present = executable !== null;
    const checks: BackendCheck[] = [
      {
        name: 'executable',
        ok: present,
        detail: present ? 'lms found on PATH' : 'lms not found on PATH',
      },
    ];
    if (executable !== null) {
      // `lms server status` is the dedicated HTTP-server readiness probe; `lms ps`
      // only lists loaded models and can cold-wake the service past the timeout.
      const result = await io.runProcess(executable, ['server', 'status', '--json', '--quiet'], {
        timeoutMs: VERSION_PROBE_TIMEOUT_MS,
      });
      const running = result.status === 0 && /"running"\s*:\s*true/.test(result.stdout);
      checks.push({
        name: 'server',
        ok: running,
        detail: running
          ? 'LM Studio server is running'
          : 'LM Studio server not running (start it with: lms server start --port 1234)',
      });
    }
    return checks;
  },
  recipe(): readonly string[] {
    return [
      'LM Studio serves a Participant CLI; crew never contacts it. First (run yourself):',
      '  lms server start --port 1234',
      '  lms load <model-key>',
      'Then pick your CLI:',
      'Codex:       codex --oss with oss_provider = "lmstudio"  (LM Studio exposes /v1/responses)',
      'Claude Code: ANTHROPIC_BASE_URL=http://localhost:1234, ANTHROPIC_AUTH_TOKEN=lmstudio',
      '             (LM Studio exposes /v1/messages)',
    ];
  },
};
