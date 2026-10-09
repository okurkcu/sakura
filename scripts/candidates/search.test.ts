import type { ChangedFile } from '@bdiff/core';
import { createTestLogger } from '@bdiff/core/testing';
import { describe, expect, it } from 'vitest';

import type { GitHubApi, GitHubPull, GitHubRepo } from './github.js';
import { candidateId, findCandidates, searchQueries } from './search.js';

const since = new Date('2026-04-01T00:00:00Z');

const repo = (name: string, overrides: Partial<GitHubRepo> = {}): GitHubRepo => ({
  fullName: `acme/${name}`,
  owner: 'acme',
  name,
  cloneUrl: `https://github.com/acme/${name}.git`,
  stars: 500,
  pushedAt: '2026-09-01T00:00:00Z',
  archived: false,
  hasLicense: true,
  defaultBranch: 'main',
  ...overrides,
});
const pull = (number: number, overrides: Partial<GitHubPull> = {}): GitHubPull => ({
  number,
  title: `PR ${String(number)}`,
  url: `https://github.com/acme/shop/pull/${String(number)}`,
  author: 'octocat',
  mergedAt: '2026-08-01T00:00:00Z',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  ...overrides,
});
const files = (...paths: string[]): ChangedFile[] =>
  paths.map((path) => ({ status: 'modified', path }));

/** A scripted GitHub: repositories by name, each with paths, package.jsons, pulls and files. */
function fakeGitHub(
  repos: readonly GitHubRepo[],
  content: Record<
    string,
    {
      paths?: string[];
      packages?: Record<string, string>;
      pulls?: GitHubPull[];
      files?: Record<number, ChangedFile[] | undefined>;
      fail?: Error;
    }
  >,
): GitHubApi & { queries: string[] } {
  const queries: string[] = [];
  const of = (r: GitHubRepo) => content[r.name] ?? {};
  return {
    queries,
    searchRepositories: (query, page) => {
      queries.push(query);
      return Promise.resolve(page === 1 && query.startsWith('topic:nextjs ') ? [...repos] : []);
    },
    repoPaths: (r) => {
      const { fail, paths = [] } = of(r);
      return fail === undefined
        ? Promise.resolve({ paths, truncated: false })
        : Promise.reject(fail);
    },
    fileText: (r, file) => Promise.resolve(of(r).packages?.[file]),
    closedPulls: (r, page) => Promise.resolve(page === 1 ? (of(r).pulls ?? []) : []),
    pullFiles: (r, number) => Promise.resolve(of(r).files?.[number]),
  };
}

const nextApp = JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } });
const options = {
  since,
  minStars: 200,
  maxRepos: 10,
  prsPerRepo: 25,
  candidatesPerRepo: 8,
  agentAccounts: ['Copilot'],
  logger: createTestLogger(),
};

describe('searchQueries', () => {
  it('asks for active, popular TypeScript Next.js repositories', () => {
    expect(searchQueries(since, 200)).toEqual([
      'topic:nextjs language:TypeScript stars:>=200 pushed:>=2026-04-01 archived:false',
      'topic:next language:TypeScript stars:>=200 pushed:>=2026-04-01 archived:false',
      'topic:next-js language:TypeScript stars:>=200 pushed:>=2026-04-01 archived:false',
    ]);
  });
});

describe('findCandidates', () => {
  it('classifies, scores and ranks the merged PRs of Next.js repositories', async () => {
    const api = fakeGitHub([repo('shop'), repo('monorepo')], {
      shop: {
        paths: ['package.json', 'app/page.tsx', '.env.example'],
        packages: { 'package.json': nextApp },
        pulls: [
          pull(1),
          pull(2, { author: 'Copilot' }),
          pull(3, { mergedAt: null }),
          pull(4, { mergedAt: '2026-01-01T00:00:00Z' }),
          pull(5),
          pull(6),
          pull(7),
        ],
        files: {
          1: files('app/login/page.tsx'),
          2: files('app/api/orders/route.ts', 'lib/orders.ts'),
          5: files('README.md'),
          6: undefined,
          7: files('package.json', 'pnpm-lock.yaml'),
        },
      },
      monorepo: {
        paths: [
          'package.json',
          'turbo.json',
          'apps/web/package.json',
          'apps/web/app/page.tsx',
          'apps/docs/package.json',
          'packages/db/prisma/schema.prisma',
        ],
        packages: {
          'package.json': JSON.stringify({ workspaces: ['apps/*'] }),
          'apps/docs/package.json': '{}',
          'apps/web/package.json': nextApp,
        },
        pulls: [pull(10)],
        files: { 10: files('apps/web/lib/a.ts') },
      },
    });

    const result = await findCandidates(api, options);

    expect(result.repos).toBe(2);
    expect(
      result.candidates.map((c) => [
        c.id,
        c.tags.prType,
        c.tags.author,
        c.tags.difficulty,
        c.score,
      ]),
    ).toEqual([
      ['acme-shop-1', 'ui', 'human', 'easy', 0.983],
      ['acme-shop-2', 'api', 'agent', 'easy', 0.967],
      ['acme-monorepo-10', 'refactor', 'human', 'realistic', 0.413],
    ]);
    expect(result.candidates[0]).toMatchObject({
      repoUrl: 'https://github.com/acme/shop.git',
      prNumber: 1,
      baseRef: 'a'.repeat(40),
      headRef: 'b'.repeat(40),
      changedFiles: ['app/login/page.tsx'],
      repo: { fullName: 'acme/shop', signals: { appRoot: '.', router: 'app', envExample: true } },
    });
    expect(result.candidates[2]?.repo.signals).toMatchObject({
      appRoot: 'apps/web',
      database: 'prisma',
      monorepo: true,
    });
  });

  it('leaves out archived, unlicensed, stale, non-Next.js and failing repositories', async () => {
    const logger = createTestLogger();
    const api = fakeGitHub(
      [
        repo('archived', { archived: true }),
        repo('unlicensed', { hasLicense: false }),
        repo('stale', { pushedAt: '2025-12-01T00:00:00Z' }),
        repo('vite', {}),
        repo('broken', {}),
        repo('shop', {}),
      ],
      {
        vite: {
          paths: ['package.json'],
          packages: { 'package.json': '{"dependencies":{"vite":"6"}}' },
        },
        broken: { fail: new Error('tree too large') },
        shop: {
          paths: ['package.json', 'pages/index.tsx'],
          packages: { 'package.json': nextApp },
          pulls: [pull(1)],
          files: { 1: files('pages/index.tsx') },
        },
      },
    );

    const result = await findCandidates(api, { ...options, logger });

    expect(result.candidates.map((c) => c.id)).toEqual(['acme-shop-1']);
    expect(logger.entries.map((entry) => entry.message)).toContain('repository skipped');
  });

  it('stops on a bad token', async () => {
    const api = fakeGitHub([repo('shop')], {
      shop: { fail: Object.assign(new Error('Bad credentials'), { status: 401 }) },
    });

    await expect(findCandidates(api, options)).rejects.toThrow('Bad credentials');
  });

  it('keeps at most candidatesPerRepo per repository', async () => {
    const api = fakeGitHub([repo('shop')], {
      shop: {
        paths: ['package.json', 'app/page.tsx'],
        packages: { 'package.json': nextApp },
        pulls: [pull(1), pull(2), pull(3)],
        files: { 1: files('app/page.tsx'), 2: files('app/page.tsx'), 3: files('app/page.tsx') },
      },
    });

    const result = await findCandidates(api, { ...options, candidatesPerRepo: 2 });

    expect(result.candidates.map((c) => c.id)).toEqual(['acme-shop-1', 'acme-shop-2']);
  });
});

describe('candidateId', () => {
  it.each([
    [{ owner: 'acme', name: 'shop' }, 3, 'acme-shop-3'],
    [{ owner: 'some.org', name: 'my_app' }, 12, 'some.org-my_app-12'],
    [{ owner: '-weird', name: 'a b/c' }, 1, 'weird-a-b-c-1'],
  ])('%j #%i → %s', (repoName, number, id) => {
    expect(candidateId(repoName, number)).toBe(id);
  });
});
