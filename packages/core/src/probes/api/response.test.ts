import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { toApiResponse } from './response.js';

const ORIGIN = 'http://127.0.0.1:41002';
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const raw = (
  body: string | Uint8Array,
  headers: Record<string, string> = {},
  overrides: { status?: number; truncated?: boolean } = {},
) => ({
  status: overrides.status ?? 200,
  headers,
  body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
  truncated: overrides.truncated ?? false,
});

describe('toApiResponse', () => {
  it('parses a JSON body and keeps only whitelisted headers, without the app origin', () => {
    const response = toApiResponse(
      raw(`{"total":"€42.00","next":"${ORIGIN}/api/orders?page=2"}`, {
        'content-type': 'application/json; charset=utf-8',
        location: `${ORIGIN}/login?next=%2F`,
        'set-cookie': 'session=secret',
        date: 'Thu, 08 Oct 2026 18:00:00 GMT',
        etag: '"abc"',
        'cache-control': 'no-store',
      }),
      ORIGIN,
    );

    expect(response).toEqual({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        location: '/login?next=%2F',
      },
      authRequired: false,
      body: {
        kind: 'json',
        json: { total: '€42.00', next: '/api/orders?page=2' },
        sha256: sha256('{"total":"€42.00","next":"/api/orders?page=2"}'),
      },
    });
  });

  it.each([
    [raw(''), { kind: 'empty' }],
    [raw('[1,2]'), { kind: 'json', json: [1, 2] }],
    [
      raw('<h1>Not found</h1>', { 'content-type': 'text/html' }),
      { kind: 'text', text: '<h1>Not found</h1>', truncated: false },
    ],
    [
      raw('{"cut', { 'content-type': 'application/json' }, { truncated: true }),
      { kind: 'text', text: '{"cut', truncated: true },
    ],
    [raw('{not json', { 'content-type': 'application/json' }), { kind: 'text', text: '{not json' }],
    [raw('42', { 'content-type': 'text/plain' }), { kind: 'text', text: '42' }],
    [
      raw(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { 'content-type': 'image/png' }),
      { kind: 'binary', bytes: 4, truncated: false },
    ],
    [raw(new Uint8Array([0xff, 0xfe, 0xfd])), { kind: 'binary', bytes: 3 }],
  ])('decodes %# as %j', (input, body) => {
    expect(toApiResponse(input, ORIGIN).body).toMatchObject(body);
  });

  it.each([
    [401, true],
    [403, true],
    [404, false],
    [500, false],
  ])('marks %i as authRequired: %s', (status, authRequired) => {
    expect(toApiResponse(raw('', {}, { status }), ORIGIN).authRequired).toBe(authRequired);
  });
});
