/**
 * Drift guard for the typecheck gate: every TypeScript project in the repo must
 * be one the `typecheck` script actually compiles. A `tsconfig.json` that no
 * script references gives a false impression of coverage — its sources escape
 * the repo's otherwise-universal gate and only fail at runtime.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-docs', 'coverage', '.git', '.crew']);

/** Every `tsconfig.json` in the repo, as a POSIX path relative to the root. */
function projectConfigs(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...projectConfigs(join(dir, entry.name)));
    } else if (entry.name === 'tsconfig.json') {
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

describe('npm run typecheck', () => {
  it('compiles every TypeScript project in the repo', () => {
    const missing = projectConfigs(ROOT).filter(
      (config) => !scripts['typecheck']?.includes(config),
    );
    expect(missing, `tsconfigs outside the typecheck gate: ${missing.join(', ')}`).toEqual([]);
  });
});
