/**
 * Release-smoke RECORDER (release Gates 2 & 3) — a MAINTAINER-run helper,
 * not a per-PR test and NOT part of the shipped package. It reuses the authoritative
 * platform registry (single source of truth) to capture, against an isolated
 * HOME, each target's `--version`, its generated-artifact content-hash, and a
 * pass/warn/absent result, then writes a redaction-clean JSON artifact under
 * `docs/release/` for the release-evidence trail. The interactive/credentialed steps
 * (the Copilot scoped shell-rule, and Ollama / LM Studio tool-call smoke through a
 * Participant CLI) cannot be automated in fork CI — they are the guided manual
 * checklist in `docs/release/live-smoke-checklist.md`.
 *
 * It is a gated vitest test rather than a standalone `scripts/*.mjs` only because the
 * repo's lint/typecheck project cannot include a loose script; the required properties hold — unshipped, registry-reused, committed artifact, no new CLI surface.
 *
 * Run it (with the five Participant CLIs / backends installed):
 *   npm run build && CREW_RELEASE_SMOKE=1 npx vitest run tests/tools/release-smoke.test.ts
 * The default per-PR run SKIPS it (a visible skip).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKEND_TARGETS, PARTICIPANT_TARGETS } from '../../src/platforms/registry.js';
import { compareVersions, probeVersion } from '../../src/platforms/shared.js';
import { nodeRunProcess } from '../../src/process.js';
import { captureIo } from '../helpers/io.js';

const RUN = process.env.CREW_RELEASE_SMOKE === '1';
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Temp isolated-HOME dirs to remove after the run so the recorder leaves nothing in /tmp. */
const madeDirs: string[] = [];
afterEach(() => {
  while (madeDirs.length) rmSync(madeDirs.pop()!, { recursive: true, force: true });
});

/** The 64-hex content-hash crew embeds in a generated artifact's marker. */
function artifactContentHash(rendered: string): string | null {
  const match = /content-hash: sha256:([0-9a-f]{64})/.exec(rendered);
  return match ? `sha256:${match[1]!}` : null;
}

function isoDate(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

describe.skipIf(!RUN)('release smoke recorder', () => {
  it('records Participant + Backend facts into a docs/release artifact', async () => {
    // Isolated HOME so the recorder never reads or writes the maintainer's real setup;
    // real PATH so installed CLIs resolve for the `--version` probe.
    const home = mkdtempSync(join(tmpdir(), 'crew-smoke-home-'));
    madeDirs.push(home);
    const io = captureIo({ env: { ...process.env, HOME: home }, runProcess: nodeRunProcess }).io;

    const participants = [];
    for (const target of PARTICIPANT_TARGETS) {
      const probe = await probeVersion(io, target);
      const floor = target.minimumVerifiedVersion;
      const meetsFloor =
        probe.version !== null && floor !== null
          ? compareVersions(probe.version, floor) >= 0
          : null;
      participants.push({
        id: target.id,
        executable: target.executable,
        present: probe.present,
        version: probe.version,
        minimum_verified: floor,
        meets_floor: meetsFloor,
        artifact_content_hash: artifactContentHash(target.render()),
        result: !probe.present
          ? 'absent'
          : probe.version === null
            ? 'unknown-version' // present but --version unparseable: never record as pass
            : meetsFloor === false
              ? 'below-floor'
              : 'pass',
      });
    }

    const backends = [];
    for (const target of BACKEND_TARGETS) {
      const probe = await probeVersion(io, target);
      const checks = await target.checks(io);
      backends.push({
        id: target.id,
        executable: target.executable,
        present: probe.present,
        version: probe.version,
        // Static prerequisite hints only (FR-J08: the registry never emits host env
        // values), so this carries no secret to redact.
        checks: checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
        result: !probe.present ? 'absent' : checks.every((c) => c.ok) ? 'pass' : 'checks-failed',
      });
    }

    const artifact = {
      type: 'release_smoke',
      schema_version: 1,
      date: isoDate(),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      note: 'Automated capture (versions + generated-artifact content-hashes + prerequisite checks). The interactive/credentialed steps are recorded by hand per docs/release/live-smoke-checklist.md.',
      participants,
      backends,
    };

    const dir = join(repoRoot, 'docs', 'release');
    mkdirSync(dir, { recursive: true });
    const outPath = join(dir, `artifacts-${isoDate()}.json`);
    writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

    process.stdout.write(`release-smoke artifact written: ${outPath}\n`);
    expect(participants).toHaveLength(PARTICIPANT_TARGETS.length);
    expect(backends).toHaveLength(BACKEND_TARGETS.length);
  }, 60_000);
});
