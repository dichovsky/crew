import { describe, it, expect, vi } from 'vitest';

let mockExists = true;
let mockManifest: string | null = null;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: string) => {
      if (!mockExists && path.endsWith('package.json')) {
        return false;
      }
      return actual.existsSync(path);
    },
    readFileSync: ((path: string, ...rest: unknown[]) => {
      if (mockManifest !== null && String(path).endsWith('package.json')) {
        return mockManifest;
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFileSync,
  };
});

import { readFileSync } from 'node:fs';
import { PACKAGE_NAME, readVersion } from '../../src/version.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
};

describe('readVersion', () => {
  it('returns the version from the package manifest', () => {
    mockExists = true;
    expect(readVersion()).toBe(pkg.version);
  });

  // Guards against an incomplete rename: readVersion() matches the manifest by
  // name, so if package.json is renamed without updating PACKAGE_NAME the lookup
  // silently falls back to '0.0.0'. Fail loudly the moment the two drift.
  it('keeps PACKAGE_NAME in sync with package.json name', () => {
    expect(PACKAGE_NAME).toBe(pkg.name);
  });

  it('falls back to 0.0.0 if package.json is not found', () => {
    mockExists = false;
    expect(readVersion()).toBe('0.0.0');
    mockExists = true;
  });

  it('keeps walking past a manifest that belongs to another package', () => {
    // Every package.json on the walk reports a foreign name, so the name
    // match never fires and the depth-capped walk falls back to 0.0.0.
    mockManifest = JSON.stringify({ name: 'someone-else', version: '9.9.9' });
    expect(readVersion()).toBe('0.0.0');
    mockManifest = null;
  });

  it('ignores a crew manifest whose version field is missing', () => {
    mockManifest = JSON.stringify({ name: PACKAGE_NAME });
    expect(readVersion()).toBe('0.0.0');
    mockManifest = null;
  });
});
