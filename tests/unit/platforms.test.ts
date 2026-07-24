import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureIo } from '../helpers/io.js';
import {
  ALL_TARGETS,
  BACKEND_TARGETS,
  getTarget,
  isSetupTargetId,
  PARTICIPANT_TARGETS,
  REGISTRY_REVISION,
} from '../../src/platforms/registry.js';
import { classifyArtifact, compareVersions, probeVersion } from '../../src/platforms/shared.js';
import { PARTICIPANT_IDS } from '../../src/participants.js';

/** Create a temp dir holding an executable named `exe`, and return the dir for PATH. */
function pathWithExecutable(exe: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-plat-'));
  const file = join(dir, exe);
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, 0o755);
  return dir;
}

describe('registry shape', () => {
  it('exposes the eight participants and two backends in canonical order', () => {
    expect(PARTICIPANT_TARGETS.map((t) => t.id)).toEqual([
      'claude-code',
      'codex-cli',
      'gemini-cli',
      'copilot-cli',
      'antigravity-cli',
      'pi-cli',
      'little-coder',
      'opencode-cli',
    ]);
    expect(BACKEND_TARGETS.map((t) => t.id)).toEqual(['ollama', 'lmstudio']);
    expect(ALL_TARGETS).toHaveLength(10);
  });

  it('every participant id is a known ParticipantId; backends are not', () => {
    for (const t of PARTICIPANT_TARGETS) expect(PARTICIPANT_IDS).toContain(t.id);
    for (const t of BACKEND_TARGETS) expect(PARTICIPANT_IDS).not.toContain(t.id);
  });

  it('resolves targets by id and rejects unknown ids', () => {
    expect(getTarget('claude-code')?.id).toBe('claude-code');
    expect(getTarget('ollama')?.category).toBe('backend');
    expect(getTarget('nope')).toBeUndefined();
    expect(isSetupTargetId('codex-cli')).toBe(true);
    expect(isSetupTargetId('nope')).toBe(false);
  });

  it('pins a valid version floor for every Participant CLI (FR-G13); backends stay unset', () => {
    // The Participant CLIs are pinned to versions verified present; the
    // maintainer re-confirms/adjusts via tests/tools/release-smoke.test.ts. Model Backends are
    // not launched and have no doctor floor, so they remain unset.
    for (const t of PARTICIPANT_TARGETS) {
      expect(t.minimumVerifiedVersion).toMatch(/^\d+\.\d+\.\d+$/);
    }
    for (const t of BACKEND_TARGETS) {
      expect(t.minimumVerifiedVersion).toBeNull();
    }
  });
});

describe('participant artifact rendering', () => {
  it('renders a self-verifying managed-current artifact for every participant', () => {
    for (const t of PARTICIPANT_TARGETS) {
      const body = t.render();
      expect(body).toContain('generated-by: crew setup;');
      expect(body).toContain(`registry-revision: ${REGISTRY_REVISION}`);
      expect(body).toMatch(/content-hash: sha256:[0-9a-f]{64}/);
      // The body hashes to its own stored digest -> managed-current.
      expect(classifyArtifact(body)).toBe('managed-current');
      // Only the ROLE_ARGS token is substituted; <target> stays a literal placeholder.
      expect(body).not.toContain('{{ROLE_ARGS}}');
      expect(body).toContain('--platform <target>');
      expect(body).toContain('crew receive <actual-id>');
      expect(body.endsWith('\n')).toBe(true);
    }
  });

  it('uses the documented per-platform comment syntax and intro tokens', () => {
    const md = PARTICIPANT_TARGETS.find((t) => t.id === 'claude-code')!.render();
    expect(md).toContain('<!-- generated-by: crew setup;');
    expect(md).toContain('Use the finite crew workflow below for `$ARGUMENTS`.');
    expect(md).toContain('allowed-tools: Bash(crew *)');

    const codex = PARTICIPANT_TARGETS.find((t) => t.id === 'codex-cli')!.render();
    expect(codex).toContain(
      'the role and optional id given after `$crew` (Codex CLI) or `/crew` (Antigravity CLI)',
    );

    const toml = PARTICIPANT_TARGETS.find((t) => t.id === 'gemini-cli')!.render();
    expect(toml.startsWith('# generated-by: crew setup;')).toBe(true);
    expect(toml).toContain('Role and optional id: {{args}}');
    expect(toml).toContain('prompt = """');

    const copilot = PARTICIPANT_TARGETS.find((t) => t.id === 'copilot-cli')!.render();
    expect(copilot).toContain('the role and optional id typed after selecting this agent');
    expect(copilot).toContain('tools:\n  - execute');
  });

  it('renders the exact per-platform invocation (FR-G07)', () => {
    const inv = (id: string) =>
      PARTICIPANT_TARGETS.find((t) => t.id === id)!.invocation('worker', 'worker-2');
    expect(inv('claude-code')).toBe('/crew worker worker-2');
    expect(inv('gemini-cli')).toBe('/crew worker worker-2');
    expect(inv('codex-cli')).toBe('$crew worker worker-2');
    expect(inv('copilot-cli')).toBe('/agent (select crew), then: worker worker-2');
    expect(inv('antigravity-cli')).toBe('/crew worker worker-2');
    expect(inv('pi-cli')).toBe('/crew worker worker-2');
    expect(inv('little-coder')).toBe('/crew worker worker-2');
    expect(inv('opencode-cli')).toBe('/crew worker worker-2');
  });

  it('appends --resume to every per-platform invocation when resuming a clean stop', () => {
    const inv = (id: string) =>
      PARTICIPANT_TARGETS.find((t) => t.id === id)!.invocation('worker', 'worker-2', {
        resume: true,
      });
    expect(inv('claude-code')).toBe('/crew worker worker-2 --resume');
    expect(inv('gemini-cli')).toBe('/crew worker worker-2 --resume');
    expect(inv('codex-cli')).toBe('$crew worker worker-2 --resume');
    expect(inv('copilot-cli')).toBe('/agent (select crew), then: worker worker-2 --resume');
    expect(inv('antigravity-cli')).toBe('/crew worker worker-2 --resume');
    expect(inv('pi-cli')).toBe('/crew worker worker-2 --resume');
    expect(inv('little-coder')).toBe('/crew worker worker-2 --resume');
    expect(inv('opencode-cli')).toBe('/crew worker worker-2 --resume');
  });

  it('keeps Copilot interactive guidance separate from its startup command', () => {
    const copilot = PARTICIPANT_TARGETS.find((target) => target.id === 'copilot-cli')!;
    expect(copilot.launchArgs?.('worker', 'worker-2')).toEqual([
      '--agent=crew',
      '--prompt',
      'worker worker-2',
    ]);
  });

  it('node-wrapped CLIs declare not-shell readiness; the rest match exact names', () => {
    // Live probe 2026-07-02: claude's pane command is its version string
    // (setproctitle), gemini's is its `node` interpreter — exact names cannot
    // track either, so Stage 1 waits for the pane to stop being a shell instead.
    // Pi, Little Coder, and opencode are node launchers too, so they default to
    // not-shell until a live pane confirms an exact name (see their modules).
    const mode = (id: string) => PARTICIPANT_TARGETS.find((t) => t.id === id)!.readinessMode;
    expect(mode('claude-code')).toBe('not-shell');
    expect(mode('gemini-cli')).toBe('not-shell');
    expect(mode('pi-cli')).toBe('not-shell');
    expect(mode('little-coder')).toBe('not-shell');
    expect(mode('opencode-cli')).toBe('not-shell');
    expect(mode('codex-cli')).toBeUndefined();
    expect(mode('copilot-cli')).toBeUndefined();
    expect(mode('antigravity-cli')).toBeUndefined();
  });

  it('copilot uses distinct global and project paths', () => {
    const copilot = PARTICIPANT_TARGETS.find((t) => t.id === 'copilot-cli')!;
    expect(copilot.userPath).toBe('.copilot/agents/crew.agent.md');
    expect(copilot.projectPath).toBe('.github/agents/crew.agent.md');
  });

  it('codex and gemini use their documented canonical paths', () => {
    const codex = PARTICIPANT_TARGETS.find((t) => t.id === 'codex-cli')!;
    expect(codex.userPath).toBe('.agents/skills/crew/SKILL.md');
    expect(codex.projectPath).toBe('.agents/skills/crew/SKILL.md');
    const gemini = PARTICIPANT_TARGETS.find((t) => t.id === 'gemini-cli')!;
    expect(gemini.userPath).toBe('.gemini/commands/crew.toml');
    expect(gemini.projectPath).toBe('.gemini/commands/crew.toml');
  });

  it('pi, little-coder, and opencode use their documented markdown command paths', () => {
    const pi = PARTICIPANT_TARGETS.find((t) => t.id === 'pi-cli')!;
    expect(pi.userPath).toBe('.pi/agent/prompts/crew.md');
    expect(pi.projectPath).toBe('.pi/prompts/crew.md');
    expect(pi.format).toBe('markdown');
    const littleCoder = PARTICIPANT_TARGETS.find((t) => t.id === 'little-coder')!;
    expect(littleCoder.userPath).toBe('.pi/agent/prompts/crew.md');
    expect(littleCoder.projectPath).toBe('.pi/prompts/crew.md');
    expect(littleCoder.format).toBe('markdown');
    expect(littleCoder.render()).toBe(pi.render());
    const opencode = PARTICIPANT_TARGETS.find((t) => t.id === 'opencode-cli')!;
    expect(opencode.userPath).toBe('.config/opencode/commands/crew.md');
    expect(opencode.projectPath).toBe('.opencode/commands/crew.md');
    expect(opencode.format).toBe('markdown');
  });

  it('pi, little-coder, and opencode define no launchArgs, so crew types after readiness', () => {
    // Neither CLI can reliably auto-submit a startup-argv prompt (opencode --prompt
    // only pre-fills; pi's positional is unconfirmed), so both rely on the
    // paste-invocation launch path rather than launchArgs.
    const pi = PARTICIPANT_TARGETS.find((t) => t.id === 'pi-cli')!;
    const littleCoder = PARTICIPANT_TARGETS.find((t) => t.id === 'little-coder')!;
    const opencode = PARTICIPANT_TARGETS.find((t) => t.id === 'opencode-cli')!;
    // Optional-chain call (never a bare unbound-method reference): an undefined
    // launchArgs short-circuits, so the launcher uses the paste-invocation path.
    expect(pi.launchArgs?.('worker', 'worker-2')).toBeUndefined();
    expect(littleCoder.launchArgs?.('worker', 'worker-2')).toBeUndefined();
    expect(opencode.launchArgs?.('worker', 'worker-2')).toBeUndefined();
  });

  it('antigravity uses a distinct global path and shares the codex project artifact byte-identically', () => {
    const antigravity = PARTICIPANT_TARGETS.find((t) => t.id === 'antigravity-cli')!;
    const codex = PARTICIPANT_TARGETS.find((t) => t.id === 'codex-cli')!;
    expect(antigravity.userPath).toBe('.gemini/antigravity-cli/skills/crew/SKILL.md');
    expect(antigravity.projectPath).toBe('.agents/skills/crew/SKILL.md');
    // Both targets discover the same project file, so `setup` from either must
    // produce identical bytes — otherwise the outcome depends on install order.
    expect(antigravity.projectPath).toBe(codex.projectPath);
    expect(antigravity.render()).toBe(codex.render());
  });

  it('renders byte-identical output across repeated calls (reproducible snapshots)', () => {
    for (const t of PARTICIPANT_TARGETS) {
      expect(t.render()).toBe(t.render());
    }
  });

  it('content-hash is byte-stable per platform (a renderer change must bump REGISTRY_REVISION)', () => {
    // Hard-coded digests guard the artifact bytes: if any renderer emits different
    // bytes, the digest changes and this fails, forcing both an update here AND a
    // REGISTRY_REVISION bump so previously-installed artifacts read as managed-outdated.
    const expected: Record<string, string> = {
      'claude-code': '836139943f352f9666e8f4a571800f25d1b5a13074bd138b9e6ed364ccba9846',
      'codex-cli': '23d654db4c2f3a9154a9dfdb73ede7205eee16b6613fd2e42adf77eb4e597163',
      'gemini-cli': '94ff656f119473d85dfc90858584d88e7555b262b72edd7bb65552a205abdf29',
      'copilot-cli': '7ae9e5276e6894dd5f18a8f0a6e8ba8ee767b947370acb8e3eec7a9f84d8a779',
      'antigravity-cli': '23d654db4c2f3a9154a9dfdb73ede7205eee16b6613fd2e42adf77eb4e597163',
      'pi-cli': '26853d7cfaafcc613c568bfa5ca07edee3914040745ab2d0e6cb8c9cef5cdd20',
      'little-coder': '26853d7cfaafcc613c568bfa5ca07edee3914040745ab2d0e6cb8c9cef5cdd20',
      'opencode-cli': 'dbe88df8e72e1fb719cc6d3b7667cf0fb0361a81ac0efdbb61cfbbfa4fd3541e',
    };
    expect(REGISTRY_REVISION).toBe(5); // bump together with the digests above
    for (const t of PARTICIPANT_TARGETS) {
      const hash = /content-hash: sha256:([0-9a-f]{64})/.exec(t.render())![1];
      expect(hash, `${t.id} artifact bytes changed`).toBe(expected[t.id]);
    }
  });
});

describe('classifyArtifact drift', () => {
  const claude = PARTICIPANT_TARGETS.find((t) => t.id === 'claude-code')!;

  it('absent when content is null', () => {
    expect(classifyArtifact(null)).toBe('absent');
  });

  it('unmanaged when no crew marker is present', () => {
    expect(classifyArtifact('# some other file\n')).toBe('unmanaged');
  });

  it('managed-edited when the body is changed after generation', () => {
    const edited = claude.render().replace('crew receive <actual-id>', 'crew receive HACKED');
    expect(classifyArtifact(edited)).toBe('managed-edited');
  });

  it('managed-outdated when the marker revision is older but the hash is consistent', () => {
    const blanked =
      '<!-- generated-by: crew setup; registry-revision: 0; content-hash: sha256: -->\nbody\n';
    const digest = createHash('sha256').update(blanked, 'utf8').digest('hex');
    const outdated = blanked.replace('content-hash: sha256:', `content-hash: sha256:${digest}`);
    expect(classifyArtifact(outdated)).toBe('managed-outdated');
  });

  it('managed-edited when the marker revision is NEWER than current (never downgrade)', () => {
    const blanked = `<!-- generated-by: crew setup; registry-revision: ${REGISTRY_REVISION + 1}; content-hash: sha256: -->\nbody\n`;
    const digest = createHash('sha256').update(blanked, 'utf8').digest('hex');
    const newer = blanked.replace('content-hash: sha256:', `content-hash: sha256:${digest}`);
    expect(classifyArtifact(newer)).toBe('managed-edited');
  });

  it('unmanaged when the marker is missing the content-hash field', () => {
    expect(
      classifyArtifact('<!-- generated-by: crew setup; registry-revision: 1 -->\nbody\n'),
    ).toBe('unmanaged');
  });

  it('unmanaged when the marker is missing the registry-revision field', () => {
    const blanked = '<!-- generated-by: crew setup; content-hash: sha256: -->\nbody\n';
    const digest = createHash('sha256').update(blanked, 'utf8').digest('hex');
    expect(
      classifyArtifact(blanked.replace('content-hash: sha256:', `content-hash: sha256:${digest}`)),
    ).toBe('unmanaged');
  });

  it('classifies a managed artifact identically under CRLF line endings', () => {
    const crlf = claude.render().replaceAll('\n', '\r\n');
    expect(classifyArtifact(crlf)).toBe('managed-current');
  });
});

describe('probeVersion', () => {
  const claude = PARTICIPANT_TARGETS.find((t) => t.id === 'claude-code')!;
  const littleCoder = PARTICIPANT_TARGETS.find((t) => t.id === 'little-coder')!;

  it('reports absent when the executable is not on PATH (no spawn)', async () => {
    let spawned = false;
    const { io } = captureIo({
      env: { PATH: '' },
      runProcess: () => {
        spawned = true;
        return Promise.resolve({ status: 0, stdout: '', stderr: '' });
      },
    });
    expect(await probeVersion(io, claude)).toEqual({ present: false, version: null });
    expect(spawned).toBe(false);
  });

  it('parses the first semver when the executable is present', async () => {
    const dir = pathWithExecutable('claude');
    const { io } = captureIo({
      env: { PATH: dir },
      runProcess: () =>
        Promise.resolve({ status: 0, stdout: '2.1.195 (Claude Code)\n', stderr: '' }),
    });
    expect(await probeVersion(io, claude)).toEqual({ present: true, version: '2.1.195' });
  });

  it('returns a null version when present output has no semver', async () => {
    const dir = pathWithExecutable('claude');
    const { io } = captureIo({
      env: { PATH: dir },
      runProcess: () => Promise.resolve({ status: 0, stdout: 'dev build\n', stderr: '' }),
    });
    expect(await probeVersion(io, claude)).toEqual({ present: true, version: null });
  });

  it('[security] spawns the exact absolute path the presence check resolved, never a CWD binary via an empty PATH element', async () => {
    const realDir = pathWithExecutable('claude');
    // A same-named executable planted at the invocation CWD (an untrusted repo).
    const cwdTrap = mkdtempSync(join(tmpdir(), 'crew-plat-cwd-'));
    const planted = join(cwdTrap, 'claude');
    writeFileSync(planted, '#!/bin/sh\necho HIJACKED-9.9.9\n');
    chmodSync(planted, 0o755);
    const previousCwd = process.cwd();
    process.chdir(cwdTrap);
    try {
      const spawnedFiles: string[] = [];
      const { io } = captureIo({
        // Leading empty PATH element: execvp would search the CWD first.
        env: { PATH: `:${realDir}` },
        runProcess: (file) => {
          spawnedFiles.push(file);
          return Promise.resolve({ status: 0, stdout: '2.1.195\n', stderr: '' });
        },
      });
      const probe = await probeVersion(io, claude);
      // The presence check and the spawn resolve to the SAME realDir binary.
      expect(probe).toEqual({ present: true, version: '2.1.195' });
      expect(spawnedFiles).toEqual([join(realDir, 'claude')]);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('reads Little Coder package metadata because --version reports bundled Pi', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-little-coder-'));
    const bin = join(root, 'bin');
    const shims = join(root, 'shims');
    mkdirSync(bin);
    mkdirSync(shims);
    writeFileSync(join(root, 'package.json'), '{"name":"little-coder","version":"1.11.0"}\n');
    const launcher = join(bin, 'little-coder.mjs');
    writeFileSync(launcher, '#!/usr/bin/env node\n');
    chmodSync(launcher, 0o755);
    symlinkSync(launcher, join(shims, 'little-coder'));
    const { io } = captureIo({
      env: { PATH: shims },
      runProcess: () => {
        throw new Error('Little Coder metadata probing must not spawn its Pi wrapper');
      },
    });
    expect(await probeVersion(io, littleCoder)).toEqual({ present: true, version: '1.11.0' });
  });
});

describe('official sources mirror setup-integration.md', () => {
  const doc = readFileSync(
    new URL('../../docs/design/setup-integration.md', import.meta.url),
    'utf8',
  );

  it('codex-cli lists the three §4.2 sources verbatim', () => {
    expect(getTarget('codex-cli')?.officialSources).toEqual([
      'https://developers.openai.com/codex/skills',
      'https://developers.openai.com/codex/rules',
      'https://developers.openai.com/codex/custom-prompts',
    ]);
  });

  it('every target cites only URLs the doc lists', () => {
    for (const target of ALL_TARGETS) {
      expect(target.officialSources.length).toBeGreaterThan(0);
      for (const url of target.officialSources) {
        expect(
          doc,
          `${target.id} cites ${url}, which setup-integration.md does not list`,
        ).toContain(url);
      }
    }
  });
});

describe('backend targets', () => {
  it('ollama checks presence then endpoint, and prints a complete recipe with no host env', async () => {
    const dir = pathWithExecutable('ollama');
    const { io } = captureIo({
      env: { PATH: dir, OLLAMA_SECRET: 'sk-should-not-appear' },
      runProcess: () => Promise.resolve({ status: 0, stdout: '', stderr: '' }),
    });
    const ollama = BACKEND_TARGETS.find((t) => t.id === 'ollama')!;
    const checks = await ollama.checks(io);
    expect(checks[0]).toEqual({ name: 'executable', ok: true, detail: 'ollama found on PATH' });
    expect(checks[1]?.name).toBe('endpoint');
    expect(checks[1]?.ok).toBe(true);
    const recipe = ollama.recipe().join('\n');
    expect(recipe).not.toContain('sk-should-not-appear');
    expect(recipe).toContain('ollama launch codex');
    expect(recipe).toContain('little-coder --model ollama/<model>');
    // The complete official auth env per the linked integration guides.
    expect(recipe).toContain('ANTHROPIC_AUTH_TOKEN=ollama');
    expect(recipe).toContain('unset ANTHROPIC_API_KEY');
    expect(recipe).toContain('COPILOT_PROVIDER_API_KEY=');
  });

  it('lmstudio reports a missing executable without spawning', async () => {
    let spawned = false;
    const { io } = captureIo({
      env: { PATH: '' },
      runProcess: () => {
        spawned = true;
        return Promise.resolve({ status: 0, stdout: '', stderr: '' });
      },
    });
    const lms = BACKEND_TARGETS.find((t) => t.id === 'lmstudio')!;
    const checks = await lms.checks(io);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toEqual({ name: 'executable', ok: false, detail: 'lms not found on PATH' });
    expect(spawned).toBe(false);
  });

  it('lmstudio reports the server running when lms server status reports running:true', async () => {
    const dir = pathWithExecutable('lms');
    const calls: string[][] = [];
    const { io } = captureIo({
      env: { PATH: dir },
      runProcess: (_f, args) => {
        calls.push([...args]);
        return Promise.resolve({ status: 0, stdout: '{"running":true,"port":1234}', stderr: '' });
      },
    });
    const lms = BACKEND_TARGETS.find((t) => t.id === 'lmstudio')!;
    const checks = await lms.checks(io);
    expect(checks.map((c) => c.name)).toEqual(['executable', 'server']);
    expect(checks[1]?.ok).toBe(true);
    // Uses the dedicated server-status probe, not `lms ps`.
    expect(calls.some((a) => a[0] === 'server' && a[1] === 'status')).toBe(true);
    expect(lms.recipe().join('\n')).toContain('lms server start --port 1234');
    expect(lms.recipe().join('\n')).toContain('little-coder --model lmstudio/local-model');
  });

  it('lmstudio reports the server NOT running when status reports running:false', async () => {
    const dir = pathWithExecutable('lms');
    const { io } = captureIo({
      env: { PATH: dir },
      runProcess: () => Promise.resolve({ status: 0, stdout: '{"running":false}', stderr: '' }),
    });
    const lms = BACKEND_TARGETS.find((t) => t.id === 'lmstudio')!;
    const checks = await lms.checks(io);
    expect(checks[1]).toMatchObject({ name: 'server', ok: false });
    expect(checks[1]?.detail).toContain('lms server start');
  });

  it('ollama reports an unreachable endpoint when the probe exits non-zero', async () => {
    const dir = pathWithExecutable('ollama');
    const { io } = captureIo({
      env: { PATH: dir },
      runProcess: () => Promise.resolve({ status: 1, stdout: '', stderr: 'connection refused' }),
    });
    const ollama = BACKEND_TARGETS.find((t) => t.id === 'ollama')!;
    const checks = await ollama.checks(io);
    expect(checks[1]).toMatchObject({ name: 'endpoint', ok: false });
    expect(checks[1]?.detail).toContain('ollama serve');
  });

  it('ollama with empty PATH yields only the executable check and never spawns', async () => {
    let spawned = false;
    const { io } = captureIo({
      env: { PATH: '' },
      runProcess: () => {
        spawned = true;
        return Promise.resolve({ status: 0, stdout: '', stderr: '' });
      },
    });
    const ollama = BACKEND_TARGETS.find((t) => t.id === 'ollama')!;
    const checks = await ollama.checks(io);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: 'executable', ok: false });
    expect(spawned).toBe(false);
  });

  it('lmstudio reports an unreachable server when the status probe exits non-zero (e.g. timeout)', async () => {
    const dir = pathWithExecutable('lms');
    const { io } = captureIo({
      env: { PATH: dir },
      runProcess: () => Promise.resolve({ status: null, stdout: '', stderr: '' }),
    });
    const lms = BACKEND_TARGETS.find((t) => t.id === 'lmstudio')!;
    const checks = await lms.checks(io);
    expect(checks[1]).toMatchObject({ name: 'server', ok: false });
    expect(checks[1]?.detail).toContain('lms server start');
  });
});

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    // numeric, so 10 > 9 (a lexical compare would get this wrong)
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('0.142.4', '0.142.10')).toBe(-1);
  });

  it('treats a missing component as 0 and ignores a pre-release suffix', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0', '1.2')).toBe(0);
    expect(compareVersions('1.2.3-rc.1', '1.2.3')).toBe(0);
    expect(compareVersions('2.1.197', '2.1.197')).toBe(0);
  });
});
