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
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** `tsconfig.json` and any variant (`tsconfig.build.json`, …). */
const TSCONFIG = /^tsconfig(\..+)?\.json$/;

/**
 * Every tsconfig that is part of the repository, as a POSIX path relative to
 * the root.
 *
 * Candidates come from git rather than a filesystem walk. The property wanted
 * here is "a TypeScript project this repository ships", and git already answers
 * exactly that — whereas a hand-maintained skip list is only an approximation of
 * it, and drifted once already: `.claude/` was missing from it, so every agent
 * worktree under `.claude/worktrees/` contributed five foreign tsconfigs and the
 * suite failed locally while a fresh CI clone passed (#148).
 *
 * `--cached --others --exclude-standard` is tracked files PLUS untracked ones
 * that are not ignored, so a brand-new project directory is caught before it is
 * ever staged, while everything `.gitignore` excludes (`node_modules/`, `dist/`,
 * `dist-docs/`, `coverage/`, `.crew/`, `.claude/`) stays out by construction.
 * This binds the test to a git checkout; the repo is only ever built from one.
 */
function projectConfigs(): string[] {
  const listed = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  );
  return listed.split('\0').filter((path) => path !== '' && TSCONFIG.test(basename(path)));
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
  // Guards the enumeration itself: a discovery bug that returned nothing would
  // make every assertion below vacuously true.
  it('discovers the known tsconfig projects', () => {
    const configs = projectConfigs();
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
    const missing = projectConfigs().filter((config) => !compiled.has(config));
    expect(missing, `tsconfigs outside every compile gate: ${missing.join(', ')}`).toEqual([]);
  });
});
