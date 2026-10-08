import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createFetchHttpClient } from './http.js';

describe('createFetchHttpClient().request', () => {
  const http = createFetchHttpClient();
  const signal = new AbortController().signal;
  let server: Server;
  let origin: string;
  const received: { method: string | undefined; headers: Record<string, unknown>; body: string }[] =
    [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        received.push({ method: request.method, headers: request.headers, body });
        switch (request.url) {
          case '/echo':
            response.setHeader('content-type', 'application/json');
            response.setHeader('x-many', ['a', 'b']);
            response.statusCode = 201;
            response.end(JSON.stringify({ body }));
            return;
          case '/redirect':
            response.writeHead(302, { location: '/elsewhere' });
            response.end();
            return;
          case '/big':
            response.end('x'.repeat(10_000));
            return;
          case '/hang':
            return;
          case '/slow-body':
            response.writeHead(200);
            response.write('first part');
            return;
          default:
            response.statusCode = 404;
            response.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const send = (path: string, overrides: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
    http.request({
      method: 'POST',
      url: `${origin}${path}`,
      headers: { 'content-type': 'application/json', 'user-agent': 'bdiff' },
      body: '{"a":1}',
      timeoutMs: overrides.timeoutMs ?? 5_000,
      signal: overrides.signal ?? signal,
      maxBodyBytes: 1_000,
    });

  it('sends method, headers and body, and returns status, headers and body', async () => {
    const response = await send('/echo');

    expect(received.at(-1)).toMatchObject({
      method: 'POST',
      body: '{"a":1}',
      headers: { 'content-type': 'application/json', 'user-agent': 'bdiff' },
    });
    expect(received.at(-1)?.headers).not.toHaveProperty('cookie');
    expect(response).toMatchObject({
      status: 201,
      headers: { 'content-type': 'application/json', 'x-many': 'a, b' },
      truncated: false,
    });
    expect(new TextDecoder().decode(response.body)).toBe('{"body":"{\\"a\\":1}"}');
  });

  it('does not follow redirects', async () => {
    const response = await send('/redirect');

    expect(response).toMatchObject({ status: 302, headers: { location: '/elsewhere' } });
  });

  it('reads at most maxBodyBytes of the body', async () => {
    const response = await send('/big');

    expect(response.body.byteLength).toBe(1_000);
    expect(response.truncated).toBe(true);
  });

  it.each(['/hang', '/slow-body'])(
    'fails with HTTP_FAILED (timedOut) when %s exceeds the timeout',
    async (path) => {
      await expect(send(path, { timeoutMs: 300 })).rejects.toMatchObject({
        code: 'HTTP_FAILED',
        details: { timedOut: true, method: 'POST' },
      });
    },
  );

  it('fails with HTTP_FAILED when nothing listens', async () => {
    await expect(
      http.request({
        method: 'GET',
        url: 'http://127.0.0.1:9/',
        headers: {},
        timeoutMs: 2_000,
        signal,
        maxBodyBytes: 100,
      }),
    ).rejects.toMatchObject({ code: 'HTTP_FAILED', details: { timedOut: false } });
  });

  it('turns an abort into the abort error', async () => {
    const controller = new AbortController();
    const pending = send('/hang', { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
