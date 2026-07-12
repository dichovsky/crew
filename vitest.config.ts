import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Build dist/ once, sequentially, before any project starts. The spawn suite
    // imports the compiled output and pack-smoke packs it; building here (instead of
    // in a test's beforeAll that races the parallel projects) removes that collision.
    globalSetup: ['./tests/global-build.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**', 'bin/**'],
      exclude: ['src/io.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
    // Most suites run with the default cross-file parallelism. The forced-contention
    // spawn suite is isolated into its own project and run without file parallelism so
    // its many cold-start child processes do not compete for a constrained CI runner's
    // process/CPU slots (which overran the child-readiness barrier on macOS).
    projects: [
      {
        extends: true,
        test: {
          name: 'main',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/spawn/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'spawn',
          include: ['tests/spawn/**/*.test.ts'],
          fileParallelism: false,
        },
      },
      // Browser dashboard component tests: they run in jsdom and stay
      // OUTSIDE the coverage gate above (its include list is src/** and bin/** only).
      {
        extends: true,
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['web/**/*.test.ts', 'web/**/*.test.tsx'],
        },
      },
    ],
  },
});
