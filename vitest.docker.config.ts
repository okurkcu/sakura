import { defineConfig } from 'vitest/config';

/**
 * Integration tests that need a running Docker daemon (`*.docker.test.ts`) or a real browser
 * (`*.browser.test.ts`, Chromium installed with `pnpm browser:install`). Slow, so they are not
 * part of `pnpm test` / `pnpm check`; run them with `pnpm test:docker`.
 */
export default defineConfig({
  ssr: { resolve: { conditions: ['bdiff-source', 'node', 'import', 'default'] } },
  test: {
    name: 'docker',
    include: ['**/*.docker.test.ts', '**/*.browser.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 15 * 60_000,
    hookTimeout: 5 * 60_000,
    fileParallelism: false,
  },
});
