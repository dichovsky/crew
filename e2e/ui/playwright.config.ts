/**
 * Playwright config for the Console dashboard smoke. Scoped
 * to e2e/ui so the specs stay OUTSIDE vitest and the per-PR gate; run via
 * `npm run e2e:ui` locally, or the nightly/label-gated ui-e2e.yml workflow.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  // The smoke builds the real bundle and seeds a workspace in beforeAll.
  timeout: 180_000,
  // Each spec rebuilds dist/ui-assets in beforeAll; parallel workers race on
  // that shared output and fail spuriously — run the suite serially.
  workers: 1,
  fullyParallel: false,
  use: { headless: true },
});
