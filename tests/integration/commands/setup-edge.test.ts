/**
 * Focused branch coverage for `src/setup/index.ts`, hitting branch sides the
 * primary `setup.test.ts` suite leaves open:
 *   - displayPath USERPROFILE fallback + `~` collapse (lines 79-80)
 *   - computeState UNSAFE_PATH → unmanaged via a project-scope squat (line 97)
 *   - applyParticipant forced-backup display in project scope (lines 162-163)
 *   - runSetupBackend failed-check `[--]` marker (line 261)
 *   - detectTarget HOME-unset catch during human detection (line 291)
 *   - runSetupList human table: present + unknown-version + null global/project
 *     cells (lines 336-340)
 *
 * Helpers (fakeBin/sandbox/records/afterEach) are copied verbatim from
 * setup.test.ts so this file stays self-contained.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initWorkspace } from '../../../src/init.js';
import type { ProcessResult } from '../../../src/io.js';
import { run } from '../../../src/run.js';
import { captureIo } from '../../helpers/io.js';

const made: string[] = [];

/** A PATH dir holding empty executable stubs. */
function fakeBin(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-bin-'));
  made.push(dir);
  for (const name of names) {
    const file = join(dir, name);
    writeFileSync(file, '');
    chmodSync(file, 0o755);
  }
  return dir;
}

interface SandboxOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: () => number;
  readonly runProcess?: (file: string, args: readonly string[]) => Promise<ProcessResult>;
  readonly initWorkspaceCwd?: boolean;
}

function sandbox(opts: SandboxOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), 'crew-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'crew-proj-'));
  made.push(home, cwd);
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: '', ...opts.env };
  const capture = captureIo({
    cwd,
    clock: opts.clock ?? (() => 1000),
    env,
    ...(opts.runProcess
      ? { runProcess: (f: string, a: readonly string[]) => opts.runProcess!(f, a) }
      : {}),
  });
  if (opts.initWorkspaceCwd !== false) {
    initWorkspace(capture.io, { withGuides: false, json: false });
    capture.out.length = 0;
  }
  return { home, cwd, ...capture };
}

function records(output: readonly string[]): Array<Record<string, unknown>> {
  return output
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  while (made.length > 0) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('crew setup edge-branch coverage', () => {
  it('resolves and collapses the global path from USERPROFILE when HOME is undefined', async () => {
    // HOME undefined forces homeDir + displayPath onto the `?? USERPROFILE` branch;
    // the written path must still collapse to `~` in the report (lines 79-80).
    const profileDir = mkdtempSync(join(tmpdir(), 'crew-profile-'));
    made.push(profileDir);
    const { io, out } = sandbox({ env: { HOME: undefined, USERPROFILE: profileDir } });

    expect(await run(['setup', 'claude-code', '--json'], io)).toBe(0);
    const rec = records(out)[0]!;
    expect(rec.action).toBe('written');
    expect(rec.scope).toBe('global');
    expect(rec.path).toBe('~/.claude/skills/crew/SKILL.md');
    expect(existsSync(join(profileDir, '.claude/skills/crew/SKILL.md'))).toBe(true);
  });

  it('refuses a directory squatting the project artifact path as unmanaged (--project)', async () => {
    // A directory at the project artifact path makes readArtifact throw UNSAFE_PATH;
    // computeState must classify it unmanaged (line 97) so the write refuses, not crashes.
    const { io, err, cwd } = sandbox();
    mkdirSync(join(cwd, '.github/agents/crew.agent.md'), { recursive: true });
    expect(await run(['setup', 'copilot-cli', '--project'], io)).toBe(1);
    expect(err.join('')).toContain('[ALREADY_EXISTS]');
  });

  it('backs up an edited project artifact on --force with a workspace-relative backup path', async () => {
    // Forced overwrite of an edited project artifact: backupArtifact returns non-null,
    // so the backup path is rendered through the project (relative) toDisplay (line 163).
    const { io, out, cwd } = sandbox({ clock: () => 555 });
    expect(await run(['setup', 'copilot-cli', '--project'], io)).toBe(0);
    const target = join(cwd, '.github/agents/crew.agent.md');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nlocal edit\n');
    out.length = 0;
    expect(await run(['setup', 'copilot-cli', '--project', '--force', '--json'], io)).toBe(0);
    const rec = records(out)[0]!;
    expect(rec.action).toBe('written');
    expect(rec.state).toBe('managed-edited');
    expect(rec.scope).toBe('project');
    expect(rec.backup_path).toBe('.github/agents/crew.agent.md.bak.555');
  });

  it('renders a failed backend check with the [--] marker on the human surface', async () => {
    // ollama absent → the single `executable` check is not ok, exercising the `--`
    // side of the check-status ternary (line 261).
    const { io, out } = sandbox();
    expect(await run(['setup', 'ollama'], io)).toBe(0);
    const text = out.join('');
    expect(text).toContain('Backend ollama');
    expect(text).toContain('[--] executable: ollama not found on PATH');
  });

  it('renders present, unknown-version, absent, and null cells in the human detection table', async () => {
    // Human bare `setup` with two present participants (one with a parseable version,
    // one without), HOME unset (global cell -> null), and no workspace (project cell ->
    // null): covers the present branch + `?? '(unknown)'` (line 336), the absent branch
    // (line 337), and the `?? '-'` / `?? 'no workspace'` fallbacks (lines 339-340). The
    // HOME-unset detection also traverses detectTarget's DEPENDENCY_MISSING catch (line 291).
    const { io, out } = sandbox({
      env: { HOME: undefined, USERPROFILE: undefined, PATH: fakeBin('claude', 'codex') },
      // The probe spawns the resolved absolute path, so match its basename.
      runProcess: (file) =>
        Promise.resolve(
          basename(file) === 'claude'
            ? { status: 0, stdout: '2.3.4 (Claude Code)\n', stderr: '' }
            : { status: 0, stdout: 'codex build unknown\n', stderr: '' },
        ),
      initWorkspaceCwd: false,
    });

    expect(await run(['setup'], io)).toBe(0);
    const lines = out.join('').split('\n');

    // Present + parsed version -> left side of `d.version ?? '(unknown)'`; both state
    // cells fall back (global `-`, project `no workspace`).
    const claudeRow = lines.find((l) => l.startsWith('claude-code'))!;
    expect(claudeRow).toMatch(/participant\s+claude 2\.3\.4\s+-\s+no workspace/);

    // Present but unparseable version -> right side of the `?? '(unknown)'` fallback.
    const codexRow = lines.find((l) => l.startsWith('codex-cli'))!;
    expect(codexRow).toMatch(/participant\s+codex \(unknown\)\s+-\s+no workspace/);

    // Absent participant -> `${executable} (absent)` branch (line 337).
    const geminiRow = lines.find((l) => l.startsWith('gemini-cli'))!;
    expect(geminiRow).toContain('gemini (absent)');
  });
});
