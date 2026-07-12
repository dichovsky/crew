import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initWorkspace } from '../../../src/init.js';
import type { ProcessResult } from '../../../src/io.js';
import { classifyArtifact } from '../../../src/platforms/shared.js';
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

describe('crew setup --list (detection, FR-G02)', () => {
  it('emits one setup_target per target and writes nothing', async () => {
    const { io, out, home } = sandbox();
    expect(await run(['setup', '--list', '--json'], io)).toBe(0);
    const recs = records(out);
    expect(recs.map((r) => r.id)).toEqual([
      'claude-code',
      'codex-cli',
      'gemini-cli',
      'copilot-cli',
      'antigravity-cli',
      'ollama',
      'lmstudio',
    ]);
    for (const r of recs) {
      expect(r.type).toBe('setup_target');
      expect(r.schema_version).toBe(1);
    }
    // Detect-only: nothing written under HOME.
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('reports present + parsed version for an installed participant', async () => {
    const { io, out } = sandbox({
      env: { PATH: fakeBin('claude') },
      runProcess: () =>
        Promise.resolve({ status: 0, stdout: '2.1.195 (Claude Code)\n', stderr: '' }),
    });
    expect(await run(['setup', '--list', '--json'], io)).toBe(0);
    const claude = records(out).find((r) => r.id === 'claude-code')!;
    expect(claude.present).toBe(true);
    expect(claude.version).toBe('2.1.195');
    expect(claude.global_state).toBe('absent');
  });

  it('bare setup with --project or --force is a usage error', async () => {
    const { io } = sandbox();
    expect(await run(['setup', '--project'], io)).toBe(2);
    expect(await run(['setup', '--force'], io)).toBe(2);
  });
});

describe('crew setup <participant> (install, FR-G04/G05)', () => {
  it('writes a self-verifying global artifact and reports it', async () => {
    const { io, out, home } = sandbox();
    expect(await run(['setup', 'claude-code', '--json'], io)).toBe(0);
    const rec = records(out)[0]!;
    expect(rec.type).toBe('setup_result');
    expect(rec.action).toBe('written');
    expect(rec.scope).toBe('global');
    expect(rec.path).toBe('~/.claude/skills/crew/SKILL.md');
    expect(rec.registry_revision).toBe(3);
    const body = readFileSync(join(home, '.claude/skills/crew/SKILL.md'), 'utf8');
    expect(classifyArtifact(body)).toBe('managed-current');
  });

  it('is a no-op on an unchanged re-run', async () => {
    const { io, out } = sandbox();
    expect(await run(['setup', 'claude-code'], io)).toBe(0);
    out.length = 0;
    expect(await run(['setup', 'claude-code', '--json'], io)).toBe(0);
    expect(records(out)[0]!.action).toBe('noop');
    expect(records(out)[0]!.state).toBe('managed-current');
  });

  it('refuses an edited artifact without --force, then backs up and overwrites with --force', async () => {
    const { io, out, home, err } = sandbox({ clock: () => 4242 });
    expect(await run(['setup', 'claude-code'], io)).toBe(0);
    const target = join(home, '.claude/skills/crew/SKILL.md');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nlocal edit\n');
    out.length = 0;
    err.length = 0;
    expect(await run(['setup', 'claude-code'], io)).toBe(1);
    expect(err.join('')).toContain('[ALREADY_EXISTS]');
    out.length = 0;
    expect(await run(['setup', 'claude-code', '--force', '--json'], io)).toBe(0);
    const rec = records(out)[0]!;
    expect(rec.action).toBe('written');
    expect(rec.state).toBe('managed-edited');
    expect(rec.backup_path).toBe('~/.claude/skills/crew/SKILL.md.bak.4242');
    const files = readdirSync(join(home, '.claude/skills/crew'));
    expect(files).toContain('SKILL.md.bak.4242');
    expect(classifyArtifact(readFileSync(target, 'utf8'))).toBe('managed-current');
  });

  it('refuses a symlinked leaf without --force (tolerating symlinked parent dirs)', async () => {
    const { io, home, err } = sandbox();
    // A symlinked LEAF at the target path: refuse without --force.
    const dir = join(home, '.claude/skills/crew');
    mkdirSync(dir, { recursive: true });
    const elsewhere = join(home, 'real-skill.md');
    writeFileSync(elsewhere, 'pre-existing\n');
    symlinkSync(elsewhere, join(dir, 'SKILL.md'));
    expect(await run(['setup', 'claude-code'], io)).toBe(1);
    expect(err.join('')).toContain('[ALREADY_EXISTS]');
  });

  it('writes the project artifact at a workspace-relative path', async () => {
    const { io, out, cwd } = sandbox();
    expect(await run(['setup', 'copilot-cli', '--project', '--json'], io)).toBe(0);
    const rec = records(out)[0]!;
    expect(rec.scope).toBe('project');
    // Copilot's project path differs from its global path.
    expect(rec.path).toBe('.github/agents/crew.agent.md');
    expect(existsSync(join(cwd, '.github/agents/crew.agent.md'))).toBe(true);
  });

  it('[security] --project refuses a symlinked repo component and writes nothing outside the root', async () => {
    const { io, cwd, err } = sandbox();
    // A cloned/untrusted repo can ship `.claude` as a symlink pointing anywhere.
    const escape = mkdtempSync(join(tmpdir(), 'crew-escape-'));
    made.push(escape);
    symlinkSync(escape, join(cwd, '.claude'));
    expect(await run(['setup', 'claude-code', '--project'], io)).toBe(1);
    expect(err.join('')).toContain('[UNSAFE_PATH]');
    // Nothing materialized outside the workspace root.
    expect(readdirSync(escape)).toEqual([]);
  });

  it('[security] --project refuses a symlinked intermediate repo component', async () => {
    const { io, cwd, err } = sandbox();
    const escape = mkdtempSync(join(tmpdir(), 'crew-escape-'));
    made.push(escape);
    mkdirSync(join(cwd, '.claude'), { recursive: true });
    symlinkSync(escape, join(cwd, '.claude', 'skills'));
    expect(await run(['setup', 'claude-code', '--project'], io)).toBe(1);
    expect(err.join('')).toContain('[UNSAFE_PATH]');
    expect(readdirSync(escape)).toEqual([]);
  });

  it('--project without a workspace is NOT_WORKSPACE', async () => {
    const { io } = sandbox({ initWorkspaceCwd: false });
    expect(await run(['setup', 'claude-code', '--project'], io)).toBe(1);
  });

  it('rejects an unknown target as UNSUPPORTED_PLATFORM', async () => {
    const { io, err } = sandbox();
    expect(await run(['setup', 'bogus'], io)).toBe(1);
    expect(err.join('')).toContain('[UNSUPPORTED_PLATFORM]');
  });

  it('rejects --list combined with a target', async () => {
    const { io } = sandbox();
    expect(await run(['setup', 'claude-code', '--list'], io)).toBe(2);
  });
});

describe('crew setup <backend> (recipe, FR-G10)', () => {
  it('prints checks and a recipe, writes no file, and never echoes host env', async () => {
    const { io, out, home } = sandbox({
      env: { PATH: fakeBin('ollama'), OLLAMA_KEY: 'sk-livetoken-shouldnotappear' },
      runProcess: () => Promise.resolve({ status: 0, stdout: '', stderr: '' }),
    });
    expect(await run(['setup', 'ollama', '--json'], io)).toBe(0);
    const rec = records(out)[0]!;
    expect(rec.type).toBe('setup_recipe');
    expect(rec.id).toBe('ollama');
    expect(Array.isArray(rec.checks)).toBe(true);
    expect(JSON.stringify(rec)).not.toContain('sk-livetoken-shouldnotappear');
    expect(existsSync(join(home, '.ollama'))).toBe(false);
  });

  it('rejects --project and --force for a backend', async () => {
    const { io } = sandbox();
    expect(await run(['setup', 'ollama', '--project'], io)).toBe(2);
    expect(await run(['setup', 'lmstudio', '--force'], io)).toBe(2);
  });
});

describe('crew setup edge cases (review hardening)', () => {
  it('preserves a dangling symlink leaf as a backup on --force, then writes a real file', async () => {
    const { io, out, home } = sandbox({ clock: () => 1000 });
    const dir = join(home, '.claude/skills/crew');
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(home, 'missing-target.md'), join(dir, 'SKILL.md')); // dangling leaf
    expect(await run(['setup', 'claude-code', '--force', '--json'], io)).toBe(0);
    const rec = records(out)[0]!;
    expect(rec.action).toBe('written');
    // The dangling link is moved aside (FR-G06 backup), not silently destroyed.
    expect(rec.backup_path).toBe('~/.claude/skills/crew/SKILL.md.bak.1000');
    expect(readdirSync(dir)).toContain('SKILL.md.bak.1000');
    expect(classifyArtifact(readFileSync(join(dir, 'SKILL.md'), 'utf8'))).toBe('managed-current');
  });

  it('reports a directory squatting an artifact path as unmanaged without crashing', async () => {
    const { io, out, err } = sandbox();
    // A directory at the artifact path makes readArtifact throw UNSAFE_PATH; detection
    // must classify it as unmanaged rather than crashing.
    mkdirSync(join(io.env.HOME!, '.claude/skills/crew/SKILL.md'), { recursive: true });
    expect(await run(['setup', '--list', '--json'], io)).toBe(0);
    expect(records(out).find((r) => r.id === 'claude-code')!.global_state).toBe('unmanaged');
    out.length = 0;
    err.length = 0;
    // And an install refuses (unmanaged) rather than throwing.
    expect(await run(['setup', 'claude-code'], io)).toBe(1);
    expect(err.join('')).toContain('[ALREADY_EXISTS]');
  });

  it('treats a binary file squatting the path as unmanaged: refuse, then --force backs up', async () => {
    const { io, out, home, err } = sandbox({ clock: () => 7 });
    const target = join(home, '.claude/skills/crew/SKILL.md');
    mkdirSync(join(home, '.claude/skills/crew'), { recursive: true });
    writeFileSync(target, Buffer.from([0xff, 0xfe, 0x00, 0x01])); // invalid UTF-8
    expect(await run(['setup', 'claude-code'], io)).toBe(1);
    expect(err.join('')).toContain('[ALREADY_EXISTS]');
    out.length = 0;
    expect(await run(['setup', 'claude-code', '--force', '--json'], io)).toBe(0);
    const rec = records(out)[0]!;
    expect(rec.action).toBe('written');
    expect(rec.state).toBe('unmanaged');
    expect(rec.backup_path).toBe('~/.claude/skills/crew/SKILL.md.bak.7');
  });

  it('prints the human backup line on a forced overwrite', async () => {
    const { io, out, home } = sandbox();
    expect(await run(['setup', 'claude-code'], io)).toBe(0);
    const target = join(home, '.claude/skills/crew/SKILL.md');
    writeFileSync(target, readFileSync(target, 'utf8') + '\nedit\n');
    out.length = 0;
    expect(await run(['setup', 'claude-code', '--force'], io)).toBe(0);
    expect(out.join('')).toContain(
      'Backed up existing file to ~/.claude/skills/crew/SKILL.md.bak.',
    );
  });

  it('setup <participant> with HOME unset is DEPENDENCY_MISSING', async () => {
    const { io, err } = sandbox({ env: { HOME: '', USERPROFILE: '' } });
    expect(await run(['setup', 'claude-code'], io)).toBe(1);
    expect(err.join('')).toContain('[DEPENDENCY_MISSING]');
  });

  it('setup --list with HOME unset still lists every target with a null global state', async () => {
    const { io, out } = sandbox({ env: { HOME: '', USERPROFILE: '' } });
    expect(await run(['setup', '--list', '--json'], io)).toBe(0);
    const recs = records(out);
    expect(recs).toHaveLength(7);
    expect(recs.find((r) => r.id === 'claude-code')!.global_state).toBeNull();
  });

  it('backend rows and missing-workspace project state are null in setup_target', async () => {
    const { io, out } = sandbox({ initWorkspaceCwd: false });
    expect(await run(['setup', '--list', '--json'], io)).toBe(0);
    const recs = records(out);
    const ollama = recs.find((r) => r.id === 'ollama')!;
    expect(ollama.category).toBe('backend');
    expect(ollama.global_path).toBeNull();
    expect(ollama.global_state).toBeNull();
    expect(ollama.project_state).toBeNull();
    expect(recs.find((r) => r.id === 'claude-code')!.project_state).toBeNull();
  });
});

describe('crew setup human output', () => {
  it('renders the detection table for bare setup', async () => {
    const { io, out } = sandbox();
    expect(await run(['setup'], io)).toBe(0);
    const text = out.join('');
    expect(text).toContain('TARGET');
    expect(text).toContain('claude-code');
    expect(text).toContain('ollama');
    expect(text).toContain('backend');
  });

  it('prints the invocation, permission, and shared-trust notes on a participant write', async () => {
    const { io, out } = sandbox();
    expect(await run(['setup', 'claude-code'], io)).toBe(0);
    const text = out.join('');
    expect(text).toContain('Wrote claude-code (global)');
    expect(text).toContain('Invoke: /crew <role> [id]');
    expect(text).toContain('Bash(crew *)');
    expect(text).toContain('Trust: crew cannot authenticate Agents');
  });

  it('prints backend checks and recipe on the human surface', async () => {
    const { io, out } = sandbox({
      env: { PATH: fakeBin('ollama') },
      runProcess: () => Promise.resolve({ status: 0, stdout: '', stderr: '' }),
    });
    expect(await run(['setup', 'ollama'], io)).toBe(0);
    const text = out.join('');
    expect(text).toContain('Backend ollama');
    expect(text).toContain('[ok] executable');
    expect(text).toContain('ollama launch codex');
  });

  it('regenerates an outdated artifact in place without a backup', async () => {
    const { io, out, home } = sandbox();
    // Craft an internally-consistent artifact from an older registry revision (0).
    const blanked =
      '<!-- generated-by: crew setup; registry-revision: 0; content-hash: sha256: -->\nold body\n';
    const digest = createHash('sha256').update(blanked, 'utf8').digest('hex');
    const outdated = blanked.replace('content-hash: sha256:', `content-hash: sha256:${digest}`);
    const target = join(home, '.claude/skills/crew/SKILL.md');
    mkdirSync(join(home, '.claude/skills/crew'), { recursive: true });
    writeFileSync(target, outdated);

    expect(await run(['setup', 'claude-code', '--json'], io)).toBe(0);
    const rec = records(out)[0]!;
    expect(rec.action).toBe('regenerated');
    expect(rec.state).toBe('managed-outdated');
    expect(rec.backup_path).toBeNull();
    // The file is now a current managed artifact.
    expect(classifyArtifact(readFileSync(target, 'utf8'))).toBe('managed-current');
  });
});

describe('crew setup human output sanitization', () => {
  it('sanitizes a control-character $HOME segment in the write confirmation', async () => {
    // A user-controlled $HOME whose directory name carries an ANSI escape must not
    // reach the terminal raw or forge a following line — the write-confirmation path
    // is run through the same sanitize-and-escape treatment as every other surface.
    const base = mkdtempSync(join(tmpdir(), 'crew-evilhome-'));
    made.push(base);
    const esc = '\x1b';
    const evilHome = join(base, `home${esc}[31mX`); // ANSI escape in the dir name
    mkdirSync(evilHome, { recursive: true });
    const { io, out } = sandbox({ env: { HOME: evilHome } });

    expect(await run(['setup', 'claude-code'], io)).toBe(0);
    const text = out.join('');
    expect(text).toContain('Wrote claude-code (global) at');
    // The raw ESC from the $HOME segment is stripped from the human surface, while
    // the artifact is still written to the real (unsanitized) path on disk.
    expect(text).not.toContain(esc);
    expect(existsSync(join(evilHome, '.claude', 'skills', 'crew', 'SKILL.md'))).toBe(true);
  });
});
