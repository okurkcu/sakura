import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { nodeFileSystem } from '@bdiff/core';
import { createTestLogger, FakeClock } from '@bdiff/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGitHubApi, GITHUB_CACHE_TTL_MS } from './github.js';
import type { GitHubRepo } from './github.js';

const repo: GitHubRepo = {
  fullName: 'acme/shop',
  owner: 'acme',
  name: 'shop',
  cloneUrl: 'https://github.com/acme/shop.git',
  stars: 500,
  pushedAt: '2026-09-01T00:00:00Z',
  archived: false,
  hasLicense: true,
  defaultBranch: 'main',
};
const searchItem = {
  full_name: 'acme/shop',
  name: 'shop',
  owner: { login: 'acme' },
  clone_url: 'https://github.com/acme/shop.git',
  stargazers_count: 500,
  pushed_at: '2026-09-01T00:00:00Z',
  archived: false,
  license: { key: 'mit' },
  default_branch: 'main',
};

/** A transport answering by URL substring; records every request. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const requests: string[] = [];
  const fetchFn = (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    requests.push(url);
    const match = Object.entries(routes).find(([part]) => url.includes(part));
    const { status = 200, body } = match?.[1] ?? { status: 404, body: { message: 'Not Found' } };
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' },
      }),
    );
  };
  return { fetch: fetchFn, requests };
}

describe('createGitHubApi', () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(tmpdir(), 'bdiff-github-'));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  const api = (
    routes: Record<string, { status?: number; body: unknown }>,
    clock = new FakeClock(),
  ) => {
    const transport = fakeFetch(routes);
    return {
      requests: transport.requests,
      clock,
      github: createGitHubApi({
        token: 'test-token',
        cacheDir,
        fs: nodeFileSystem,
        clock,
        logger: createTestLogger(),
        fetch: transport.fetch,
      }),
    };
  };

  it('searches repositories and serves a repeated request from the disk cache', async () => {
    const { github, requests, clock } = api({
      '/search/repositories': { body: { items: [searchItem] } },
    });

    const first = await github.searchRepositories('topic:nextjs', 1);
    const second = await github.searchRepositories('topic:nextjs', 1);

    expect(first).toEqual([repo]);
    expect(second).toEqual(first);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('q=topic%3Anextjs');

    clock.advance(GITHUB_CACHE_TTL_MS + 1);
    await github.searchRepositories('topic:nextjs', 1);
    expect(requests).toHaveLength(2);
  });

  it('rejects a response that does not have the expected shape', async () => {
    const { github } = api({ '/search/repositories': { body: { items: [{ name: 'shop' }] } } });

    await expect(github.searchRepositories('x', 1)).rejects.toMatchObject({
      code: 'HTTP_FAILED',
      message: 'Unexpected GitHub response for search x',
    });
  });

  it('lists file paths, reads files and treats a missing file as undefined', async () => {
    const { github } = api({
      '/git/trees/main': {
        body: {
          truncated: false,
          tree: [
            { path: 'app', type: 'tree' },
            { path: 'app/page.tsx', type: 'blob' },
            { path: 'package.json', type: 'blob' },
          ],
        },
      },
      '/contents/package.json': { body: '{"dependencies":{"next":"15"}}' },
    });

    expect(await github.repoPaths(repo, 'main')).toEqual({
      paths: ['app/page.tsx', 'package.json'],
      truncated: false,
    });
    expect(await github.fileText(repo, 'package.json', 'main')).toBe(
      '{"dependencies":{"next":"15"}}',
    );
    expect(await github.fileText(repo, 'missing.json', 'main')).toBeUndefined();
  });

  it('maps pulls and their files, and gives up on PRs with too many files', async () => {
    const { github } = api({
      '/pulls/7/files': {
        body: [
          { filename: 'app/page.tsx', status: 'modified' },
          { filename: 'lib/new.ts', status: 'added' },
          { filename: 'lib/gone.ts', status: 'removed' },
          { filename: 'lib/b.ts', status: 'renamed', previous_filename: 'lib/a.ts' },
        ],
      },
      '/pulls/8/files': {
        body: Array.from({ length: 4 }, (_, i) => ({
          filename: `f${String(i)}`,
          status: 'modified',
        })),
      },
      '/pulls?': {
        body: [
          {
            number: 7,
            title: 'Add login',
            html_url: 'https://github.com/acme/shop/pull/7',
            user: null,
            merged_at: '2026-08-01T00:00:00Z',
            base: { sha: 'a'.repeat(40) },
            head: { sha: 'b'.repeat(40) },
          },
        ],
      },
    });

    expect(await github.closedPulls(repo, 1)).toEqual([
      {
        number: 7,
        title: 'Add login',
        url: 'https://github.com/acme/shop/pull/7',
        author: 'ghost',
        mergedAt: '2026-08-01T00:00:00Z',
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
      },
    ]);
    expect(await github.pullFiles(repo, 7, 30)).toEqual([
      { status: 'modified', path: 'app/page.tsx' },
      { status: 'added', path: 'lib/new.ts' },
      { status: 'deleted', path: 'lib/gone.ts' },
      { status: 'renamed', path: 'lib/b.ts', oldPath: 'lib/a.ts' },
    ]);
    expect(await github.pullFiles(repo, 8, 3)).toBeUndefined();
  });
});
