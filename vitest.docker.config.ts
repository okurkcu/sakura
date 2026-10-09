import { defineConfig } from 'vitest/config';

/** The end-to-end suite: `bdiff run` on every fixture branch. CI runs it as its own job. */
const e2eTests = ['e2e/fixture.docker.test.ts'];

/**
 * Integration tests that need a running Docker daemon (`*.docker.test.ts`) or a real browser
 * (`*.browser.test.ts`, Chromium installed with `pnpm browser:install`). Slow, so they are not
 * part of `pnpm test` / `pnpm check`; run them with `pnpm test:docker`, or one project with
 * `pnpm test:docker --project integration` / `--project e2e`.
 */
export default defineConfig({
  ssr: { resolve: { conditions: ['bdiff-source', 'node', 'import', 'default'] } },
  test: {
    testTimeout: 15 * 60_000,
    hookTimeout: 5 * 60_000,
    // One file at a time across both projects: each one builds and runs the fixture app.
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['**/*.docker.test.ts', '**/*.browser.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', ...e2eTests],
        },
      },
      {
        extends: true,
        test: { name: 'e2e', include: e2eTests },
      },
    ],
  },
});
