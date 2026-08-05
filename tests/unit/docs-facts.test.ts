/**
 * Documentation-site facts: generator and drift guard in one file.
 *
 * The interactive documentation site under `docs-site/` never restates volatile
 * facts about crew — the Participant roster, the schema version, the command
 * surface, the ADR index. Restating them is exactly the parallel-table failure
 * ADR-0006 forbids for the platform registry, and it has already happened once in
 * prose (commit 8820be7 reconciled the Participant count after two engines landed).
 *
 * So the site reads `docs-site/generated/facts.json`, and that file is derived
 * here from the authoritative modules themselves. The file is committed, not
 * git-ignored, for two reasons: the site's typecheck and bundle need it present
 * without a prior build step, and a reviewer sees every fact change as a diff.
 *
 * Regenerate after changing the registry, the schema, the CLI, or the ADRs:
 *
 *   UPDATE_DOCS_FACTS=1 npx vitest run tests/unit/docs-facts.test.ts
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli.js';
import {
  BACKEND_TARGETS,
  PARTICIPANT_TARGETS,
  REGISTRY_REVISION,
} from '../../src/platforms/registry.js';
import { CURRENT_SCHEMA_VERSION, TABLE_SQL } from '../../src/store/schema.js';
import { captureIo } from '../helpers/io.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FACTS_PATH = join(ROOT, 'docs-site', 'generated', 'facts.json');

/** Example identity used to render each Participant's exact start command. */
const EXAMPLE_ROLE = 'manager';
const EXAMPLE_ID = 'mgr';

/** Read one required whole number out of a source file, failing loudly if absent. */
function requiredNumber(source: string, label: string, pattern: RegExp): number {
  const match = pattern.exec(source);
  const captured = match?.[1];
  if (captured === undefined) {
    throw new Error(`Could not read ${label} from vitest.config.ts — update docs-facts.test.ts`);
  }
  return Number(captured);
}

function collectAdrs(): { id: string; slug: string; title: string }[] {
  const adrDir = join(ROOT, 'docs', 'adr');
  return readdirSync(adrDir)
    .filter((name) => /^\d{4}-.+\.md$/.test(name))
    .sort()
    .map((name) => {
      const body = readFileSync(join(adrDir, name), 'utf8');
      const heading = /^#\s+(.+)$/m.exec(body)?.[1];
      if (heading === undefined) {
        throw new Error(`ADR ${name} has no level-1 heading`);
      }
      return {
        id: name.slice(0, 4),
        slug: name.replace(/\.md$/, ''),
        title: heading.trim(),
      };
    });
}

function collectCommands(): { name: string; description: string; subcommands: string[] }[] {
  const { io } = captureIo();
  return buildProgram(io)
    .commands.map((command) => ({
      name: command.name(),
      description: command.description(),
      subcommands: command.commands.map((sub) => sub.name()).sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildFacts(): unknown {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    engines: { node: string };
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const vitestSource = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');

  return {
    package: {
      name: pkg.name,
      version: pkg.version,
      nodeEngine: pkg.engines.node,
      runtimeDependencies: pkg.dependencies,
      devDependencies: Object.keys(pkg.devDependencies).sort(),
    },
    registry: {
      revision: REGISTRY_REVISION,
      participants: PARTICIPANT_TARGETS.map((target) => ({
        id: target.id,
        executable: target.executable,
        minimumVerifiedVersion: target.minimumVerifiedVersion,
        verifiedOn: target.verifiedOn,
        userPath: target.userPath,
        projectPath: target.projectPath,
        format: target.format,
        invocation: target.invocation(EXAMPLE_ROLE, EXAMPLE_ID),
        permissionNote: target.permissionNote,
        officialSources: [...target.officialSources],
      })),
      backends: BACKEND_TARGETS.map((target) => ({
        id: target.id,
        executable: target.executable,
        minimumVerifiedVersion: target.minimumVerifiedVersion,
        verifiedOn: target.verifiedOn,
        officialSources: [...target.officialSources],
      })),
    },
    schema: {
      version: CURRENT_SCHEMA_VERSION,
      tables: Object.keys(TABLE_SQL).sort(),
    },
    coverageThresholds: {
      statements: requiredNumber(vitestSource, 'statements', /statements:\s*(\d+)/),
      branches: requiredNumber(vitestSource, 'branches', /branches:\s*(\d+)/),
      functions: requiredNumber(vitestSource, 'functions', /functions:\s*(\d+)/),
      lines: requiredNumber(vitestSource, 'lines', /lines:\s*(\d+)/),
    },
    commands: collectCommands(),
    adrs: collectAdrs(),
  };
}

/** Canonical serializer: JSON.stringify with 2-space indent, exactly as the
 *  launch-plan fixture uses. `.prettierignore` covers the output for the same reason. */
function serialize(facts: unknown): string {
  return `${JSON.stringify(facts, null, 2)}\n`;
}

describe('documentation-site facts', () => {
  it('match the authoritative sources', () => {
    const expected = serialize(buildFacts());

    if (process.env.UPDATE_DOCS_FACTS === '1') {
      mkdirSync(dirname(FACTS_PATH), { recursive: true });
      writeFileSync(FACTS_PATH, expected);
      return;
    }

    if (!existsSync(FACTS_PATH)) {
      mkdirSync(dirname(FACTS_PATH), { recursive: true });
      writeFileSync(FACTS_PATH, expected);
      throw new Error(
        'docs-site/generated/facts.json was missing and has been written — commit it.',
      );
    }

    expect(readFileSync(FACTS_PATH, 'utf8')).toBe(expected);
  });

  it('cover every Participant the registry declares', () => {
    // Guards the failure this file exists to prevent: a new engine landing in the
    // registry while the documentation still describes the old roster.
    const facts = JSON.parse(readFileSync(FACTS_PATH, 'utf8')) as {
      registry: { participants: { id: string }[] };
    };
    expect(facts.registry.participants.map((p) => p.id)).toEqual(
      PARTICIPANT_TARGETS.map((t) => t.id),
    );
  });
});
