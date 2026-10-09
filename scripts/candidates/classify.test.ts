import type { ChangedFile } from '@bdiff/core';
import { describe, expect, it } from 'vitest';

import {
  classifyAuthor,
  classifyPrType,
  excludeReason,
  guessDifficulty,
  repoSignals,
} from './classify.js';
import type { RepoSignals } from './schema.js';

describe('classifyPrType', () => {
  it.each<[string, string[], string]>([
    ['an App Router page', ['app/login/page.tsx'], 'ui'],
    ['a layout under src/app', ['src/app/layout.tsx'], 'ui'],
    ['a Pages Router page', ['pages/index.tsx'], 'ui'],
    ['a component', ['components/Button.tsx', 'lib/format.ts'], 'ui'],
    ['a nested component folder', ['src/features/cart/components/Total.tsx'], 'ui'],
    ['a stylesheet', ['styles/globals.css'], 'ui'],
    ['an MDX page', ['app/blog/hello/page.mdx'], 'ui'],
    ['an App Router route handler', ['app/api/orders/route.ts'], 'api'],
    ['a route handler outside api/', ['app/feed.xml/route.ts'], 'api'],
    ['a Pages Router API route', ['pages/api/health.ts'], 'api'],
    ['src/pages/api', ['src/pages/api/users/[id].ts'], 'api'],
    ['a page and a route handler', ['app/page.tsx', 'app/api/x/route.ts'], 'mixed'],
    ['a monorepo app', ['apps/web/app/page.tsx', 'apps/web/app/api/x/route.ts'], 'mixed'],
    ['only library code', ['lib/orders.ts', 'utils/date.ts'], 'refactor'],
    ['config and library code', ['next.config.js', 'lib/db.ts'], 'refactor'],
    ['a page plus its test', ['app/page.tsx', 'app/page.test.tsx'], 'ui'],
    // Tests and docs do not make a PR a UI change.
    [
      'tests and docs around library code',
      ['lib/a.ts', 'components/a.test.tsx', 'README.md'],
      'refactor',
    ],
  ])('%s → %s', (_name, paths, prType) => {
    expect(classifyPrType(paths)).toBe(prType);
  });
});

describe('classifyAuthor', () => {
  const agents = ['Copilot', 'openhands-agent'];

  it.each([
    ['octocat', 'human'],
    ['dependabot[bot]', 'agent'],
    ['devin-ai-integration[bot]', 'agent'],
    ['Copilot', 'agent'],
    ['copilot', 'agent'],
    ['OpenHands-Agent', 'agent'],
    ['copilot-fan', 'human'],
  ])('%s → %s', (login, author) => {
    expect(classifyAuthor(login, agents)).toBe(author);
  });
});

describe('guessDifficulty', () => {
  const signals = (overrides: Partial<RepoSignals>): RepoSignals => ({
    appRoot: '.',
    router: 'app',
    database: 'none',
    dockerCompose: false,
    envExample: false,
    envSchema: false,
    monorepo: false,
    ...overrides,
  });

  it.each<[string, Partial<RepoSignals>, string]>([
    ['no database, no env needed', {}, 'easy'],
    ['no database, documented env', { envExample: true, envSchema: true }, 'easy'],
    ['no database, undocumented env schema', { envSchema: true }, 'realistic'],
    ['prisma', { database: 'prisma', envExample: true }, 'realistic'],
    ['drizzle', { database: 'drizzle' }, 'realistic'],
  ])('%s → %s', (_name, overrides, difficulty) => {
    expect(guessDifficulty(signals(overrides))).toBe(difficulty);
  });
});

describe('excludeReason', () => {
  const files = (...paths: string[]): ChangedFile[] =>
    paths.map((path) => ({ status: 'modified', path }));

  it.each<[string, ChangedFile[], string | undefined]>([
    ['a page change', files('app/page.tsx'), undefined],
    ['docs only', files('README.md', 'docs/setup.md'), 'docs-only'],
    ['tests only', files('tests/a.spec.ts'), 'tests-only'],
    ['CI only', files('.github/workflows/ci.yml'), 'ci-only'],
    ['a dependency bump', files('package.json', 'pnpm-lock.yaml'), 'dependencies-only'],
    [
      'a workspace dependency bump',
      files('apps/web/package.json', 'pnpm-lock.yaml'),
      'dependencies-only',
    ],
    ['a dependency bump with code', files('package.json', 'lib/a.ts'), undefined],
    [
      'a rename into docs',
      [{ status: 'renamed', path: 'docs/old.md', oldPath: 'notes.md' }],
      'docs-only',
    ],
  ])('%s → %s', (_name, changed, reason) => {
    expect(excludeReason(changed)).toBe(reason);
  });
});

describe('repoSignals', () => {
  it('reads router, database, env and monorepo signals from paths', () => {
    expect(
      repoSignals(
        [
          'package.json',
          'pnpm-workspace.yaml',
          'docker-compose.yml',
          'apps/web/package.json',
          'apps/web/src/app/page.tsx',
          'apps/web/src/env.mjs',
          'apps/web/.env.example',
          'packages/db/prisma/schema.prisma',
        ],
        'apps/web',
        false,
      ),
    ).toEqual({
      appRoot: 'apps/web',
      router: 'app',
      database: 'prisma',
      dockerCompose: true,
      envExample: true,
      envSchema: true,
      monorepo: true,
    });
  });

  it('describes a plain Pages Router app without a database', () => {
    expect(repoSignals(['package.json', 'pages/index.tsx', 'drizzle.md'], '.', false)).toEqual({
      appRoot: '.',
      router: 'pages',
      database: 'none',
      dockerCompose: false,
      envExample: false,
      envSchema: false,
      monorepo: false,
    });
    expect(
      repoSignals(['app/page.tsx', 'pages/old.tsx', 'drizzle.config.ts'], '.', true),
    ).toMatchObject({
      router: 'both',
      database: 'drizzle',
      monorepo: true,
    });
  });
});
