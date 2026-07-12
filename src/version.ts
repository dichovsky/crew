/**
 * Resolve the crew package version at runtime.
 *
 * The manifest sits at different depths in source (`src/`) versus the published
 * build (`dist/src/`), so we walk up from this module until we find the crew
 * package.json rather than hard-coding a relative depth.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = '@dichovsky/crew';
const MAX_DEPTH = 6;

export function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < MAX_DEPTH; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === 'string') {
        return pkg.version;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}
