import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGitHubClient, parseGitHubRepo } from './github.js';

describe('createGitHubClient', () => {
  let server: Server;
  let baseUrl: string;
  const seen: { url: string | undefined; authorization: string | undefined }[] = [];
  const signal = new AbortController().signal;

  beforeAll(async () => {
    server = createServer((request, response) => {
      seen.push({ url: request.url, authorization: request.headers.authorization });
      if (request.url === '/repos/acme/shop/pulls/7') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ title: 'Format totals', body: null, number: 7 }));
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

  it.each([
    [9, { code: 'HTTP_FAILED', details: { status: 404 } }],
    [8, { code: 'HTTP_FAILED', details: { timedOut: true } }],
  ])(
    'fails pull request #%i with %j, never with the token in the message',
    async (number, failure) => {
      const error: unknown = await createGitHubClient({ token: 'test-token', baseUrl })
        .getPullRequest({ owner: 'acme', name: 'shop' }, number, { timeoutMs: 300, signal })
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject(failure);
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
