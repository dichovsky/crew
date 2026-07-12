/**
 * Proves the `build:web` step emits the offline Console
 * assets: `dist/ui-assets/index.html` plus the bundled JS with preact inlined
 * (FR-U08 — no network, no package imports at runtime).
 */
import { execa } from 'execa';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('build:web', () => {
  it('emits dist/ui-assets/index.html and a self-contained JS bundle', async () => {
    const assetsDir = join(projectRoot, 'dist', 'ui-assets');
    rmSync(assetsDir, { recursive: true, force: true });

    await execa('npm', ['run', 'build:web'], { cwd: projectRoot });

    const html = readFileSync(join(assetsDir, 'index.html'), 'utf8');
    expect(html).toContain('<div id="app">');
    // The bundle loader must propagate the page query so the request carries
    // the per-run token (FR-U04 covers assets; a static src cannot).
    expect(html).toContain('./main.js${location.search}');
    expect(html).not.toContain('src="./main.js"');

    const bundle = readFileSync(join(assetsDir, 'main.js'), 'utf8');
    expect(bundle.length).toBeGreaterThan(0);
    // Offline bundle: preact is inlined, never imported from a package path.
    expect(bundle).not.toMatch(/from\s*["']preact["']/);

    // CSS is embedded as trusted build-time text in the authenticated JS
    // bundle. There must not be an un-tokenized second asset request.
    expect(bundle).toContain('crewStyles');
    expect(bundle).toContain('--accent');
    expect(existsSync(join(assetsDir, 'main.css'))).toBe(false);
    expect(html).not.toContain('.css');
  }, 60_000);
});
