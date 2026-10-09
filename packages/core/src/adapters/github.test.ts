import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGitHubClient, parseGitHubRepo } from './github.js';

/** A pull request as the GitHub API returns it (the fields bdiff reads, plus others). */
const pullRequest = {
  number: 7,
  title: 'Format totals',
  body: null,
  state: 'open',
  merged_at: null,
  base: { ref: 'main', sha: 'a'.repeat(40), repo: { full_name: 'acme/shop' } },
  head: { ref: 'format-totals', sha: 'b'.repeat(40), repo: { full_name: 'someone/shop' } },
};

describe('createGitHubClient', () => {
  let server: Server;
  let baseUrl: string;
  const seen: { url: string | undefined; authorization: string | undefined }[] = [];
  const signal = new AbortController().signal;

  beforeAll(async () => {
    server = createServer((request, response) => {
      seen.push({ url: request.url, authorization: request.headers.authorization });
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        response.statusCode = status;
        response.setHeader('content-type', 'application/json');
        for (const [name, value] of Object.entries(headers)) {
          response.setHeader(name, value);
        }
        response.end(JSON.stringify(body));
      };
      if (request.url === '/repos/acme/shop/pulls/7') {
        json(200, pullRequest);
      } else if (request.url === '/repos/acme/shop/pulls/10') {
        json(200, {
          ...pullRequest,
          state: 'closed',
          merged_at: null,
          head: { ref: 'main', sha: 'f'.repeat(40), repo: null },
        });
      } else if (request.url === '/repos/acme/shop/pulls/11') {
        json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' });
      } else if (request.url === '/repos/acme/shop/pulls/12') {
        json(429, { message: 'Too many requests' });
      } else if (request.url === '/repos/acme/shop/pulls/13') {
        json(200, { title: 'No refs' });
      } else if (request.url === '/repos/acme/shop/pulls/8') {
        return; // hangs
      } else {
        response.statusCode = 404;
        response.end('{"message":"Not Found"}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('reads a pull request, sending the token only as a bearer header', async () => {
    const client = createGitHubClient({ token: 'test-token', baseUrl });

    expect(
      await client.getPullRequest({ owner: 'acme', name: 'shop' }, 7, { timeoutMs: 2_000, signal }),
    ).toEqual({
      title: 'Format totals',
      body: '',
    });
    expect(seen.at(-1)).toEqual({
      url: '/repos/acme/shop/pulls/7',
      authorization: 'Bearer test-token',
    });
  });

  it('works without a token', async () => {
    await createGitHubClient({ baseUrl }).getPullRequest({ owner: 'acme', name: 'shop' }, 7, {
      timeoutMs: 2_000,
      signal,
    });

    expect(seen.at(-1)?.authorization).toBeUndefined();
  });

  it("resolves where a pull request's base and head are", async () => {
    const client = createGitHubClient({ baseUrl });
    const options = { timeoutMs: 2_000, signal };

    expect(await client.resolvePullRequest({ owner: 'acme', name: 'shop' }, 7, options)).toEqual({
      title: 'Format totals',
      body: '',
      state: 'open',
      merged: false,
      base: { ref: 'main', sha: 'a'.repeat(40), repo: 'acme/shop' },
      head: { ref: 'format-totals', sha: 'b'.repeat(40), repo: 'someone/shop' },
    });
    expect(
      await client.resolvePullRequest({ owner: 'acme', name: 'shop' }, 10, options),
    ).toMatchObject({ state: 'closed', merged: false, head: { repo: null } });
  });

  it.each([
    // GitHub answers 404 for a private repository too.
    [
      9,
      { code: 'PR_NOT_FOUND', details: { status: 404 } },
      /GitHub has no pull request acme\/shop#9, or it is private/,
    ],
    [8, { code: 'HTTP_FAILED', details: { timedOut: true } }, /failed/],
    [11, { code: 'HTTP_FAILED', details: { status: 403, rateLimited: true } }, /set GITHUB_TOKEN/],
    [12, { code: 'HTTP_FAILED', details: { status: 429, rateLimited: true } }, /set GITHUB_TOKEN/],
    [13, { code: 'HTTP_FAILED' }, /Unexpected GitHub response/],
  ])(
    'fails pull request #%i with %j, never with the token in the message',
    async (number, failure, message) => {
      const error: unknown = await createGitHubClient({ token: 'test-token', baseUrl })
        .getPullRequest({ owner: 'acme', name: 'shop' }, number, { timeoutMs: 300, signal })
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject(failure);
      expect((error as Error).message).toMatch(message);
      expect((error as Error).message).not.toContain('test-token');
    },
  );
});

describe('parseGitHubRepo', () => {
  it.each([
    ['https://github.com/vercel/commerce', { owner: 'vercel', name: 'commerce' }],
    ['https://github.com/vercel/commerce.git', { owner: 'vercel', name: 'commerce' }],
    ['https://github.com/a-b/c.d/', { owner: 'a-b', name: 'c.d' }],
    ['https://gitlab.com/vercel/commerce', undefined],
    ['/repos/shop', undefined],
    ['https://github.com/vercel', undefined],
  ])('parses %s', (url, repo) => {
    expect(parseGitHubRepo(url)).toEqual(repo);
  });
});
