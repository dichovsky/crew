import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function typescriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...typescriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

describe('SQLite source ownership (FR-I01)', () => {
  it('allows node:sqlite imports only below src/store', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const matches = typescriptFiles(join(root, 'src'))
      .filter((path) =>
        /from ['"]node:sqlite['"]|require\(['"]node:sqlite/.test(readFileSync(path, 'utf8')),
      )
      .map((path) => relative(root, path).split(sep).join('/'));
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((path) => path.startsWith('src/store/'))).toBe(true);
    for (const path of matches)
      expect(readFileSync(`${root}/${path}`, 'utf8')).toContain('node:sqlite');
  });
});
