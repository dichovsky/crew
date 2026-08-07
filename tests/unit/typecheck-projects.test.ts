/**
 * Drift guard for the compile gates: every TypeScript project in the repo must
 * be one an npm script actually compiles. A tsconfig no script references gives
 * a false impression of coverage — its sources escape the repo's otherwise
 * universal gate and only fail at runtime.
 *
 * Matching is by exact `-p` ARGUMENT, never by substring: the root
 * `tsconfig.json` is a suffix of `web/tsconfig.json`, `docs-site/tsconfig.json`,
 * and `e2e/ui/tsconfig.json`, so a substring test would report the root project
 * as covered even after it was dropped from the script entirely — and the root
 * is the one covering `src/`, `bin/`, and `tests/`.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-docs', 'coverage', '.git', '.crew']);
/** `tsconfig.json` and any variant (`tsconfig.build.json`, …). */
const TSCONFIG = /^tsconfig(\..+)?\.json$/;

/** Every tsconfig in the repo, as a POSIX path relative to the root. */
function projectConfigs(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...projectConfigs(join(dir, entry.name)));
    } else if (TSCONFIG.test(entry.name)) {
      found.push(relative(ROOT, join(dir, entry.name)).split('\\').join('/'));
    }
  }
  return found;
}

const scripts = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

/** The exact project paths a script passes to `tsc` via `-p` / `--project`. */
function compiledProjects(script: string | undefined): string[] {
  const tokens = (script ?? '').split(/\s+/);
  return tokens.flatMap((token, i) =>
    (token === '-p' || token === '--project') && tokens[i + 1] !== undefined
      ? [tokens[i + 1]!]
      : [],
  );
}

describe('npm compile gates', () => {
  // Guards the walker itself: a discovery bug that returned nothing would make
  // every assertion below vacuously true.
  it('discovers the known tsconfig projects', () => {
    const configs = projectConfigs(ROOT);
    expect(configs).toContain('tsconfig.json');
    expect(configs).toContain('tsconfig.build.json');
    expect(configs.length).toBeGreaterThanOrEqual(5);
  });

  it('compiles every TypeScript project in the repo', () => {
    // `typecheck` holds the noEmit projects; `build` holds the emitting one
    // (`tsconfig.build.json`, which produces the published `dist/`). A project
    // in neither is compiled by nothing.
    const compiled = new Set([
      ...compiledProjects(scripts['typecheck']),
      ...compiledProjects(scripts['build']),
    ]);
    const missing = projectConfigs(ROOT).filter((config) => !compiled.has(config));
    expect(missing, `tsconfigs outside every compile gate: ${missing.join(', ')}`).toEqual([]);
  });
});
