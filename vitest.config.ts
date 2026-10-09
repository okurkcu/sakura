import { defineConfig } from 'vitest/config';

/** Resolve workspace packages to their TypeScript sources so tests never depend on a prior build. */
const sourceConditions = ['bdiff-source', 'node', 'import', 'default'];

/** Tests that need Docker or a real browser; they run with `pnpm test:docker` instead. */
const integrationTests = ['**/*.docker.test.ts', '**/*.browser.test.ts'];

const packageProject = (name: string) => ({
  extends: true,
  test: {
    name,
    include: [`packages/${name}/src/**/*.test.ts`],
    exclude: integrationTests,
  },
});

export default defineConfig({
  ssr: { resolve: { conditions: sourceConditions } },
  test: {
    projects: [
      packageProject('core'),
      packageProject('report'),
      packageProject('cli'),
      {
        extends: true,
        // The web UI's JSX is Preact's.
        oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
        test: {
          name: 'panel',
          include: [
            'packages/panel/src/**/*.test.ts',
            'packages/panel/web/**/*.test.{ts,tsx}',
            'packages/panel/tools/*.test.ts',
          ],
          exclude: integrationTests,
        },
      },
      {
        extends: true,
        test: {
          name: 'fixtures',
          include: ['fixtures/*.test.ts'],
          exclude: integrationTests,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['e2e/*.test.ts'],
          exclude: integrationTests,
          testTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'scripts',
          include: ['scripts/*.test.ts', 'scripts/candidates/**/*.test.ts'],
          exclude: integrationTests,
        },
      },
      {
        extends: true,
        test: {
          name: 'tooling',
          include: ['tests/**/*.test.ts'],
          exclude: integrationTests,
          testTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'packages/panel/web/**/*.{ts,tsx}'],
      exclude: ['**/*.test.ts'],
    },
  },
});
