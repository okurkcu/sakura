import { describe, expect, it } from 'vitest';

import { diffApiCaptures } from './api-diff.js';
import type { ApiCapture, ApiResponse } from '../domain/api-probe.js';

const response = (overrides: Partial<ApiResponse> = {}): ApiResponse => ({
  status: 200,
  contentType: 'application/json; charset=utf-8',
  headers: {},
  authRequired: false,
  body: { kind: 'json', json: { total: 42 }, sha256: 'a'.repeat(64) },
  ...overrides,
});
const capture = (answer: ApiResponse | 'timeout'): ApiCapture => ({
  probeRun: 'baseA',
  requestKey: 'GET /api/x',
  durationMs: 1,
  artifact: '/out/x.json',
  ...(answer === 'timeout'
    ? { error: { code: 'PROBE_TIMEOUT', message: 'no response' } }
    : { response: answer }),
});
const text = (value: string, sha: string): ApiResponse['body'] => ({
  kind: 'text',
  text: value,
  sha256: sha.repeat(64),
  truncated: false,
});

describe('diffApiCaptures', () => {
  const ok = capture(response());

  it('finds nothing in the same answers', () => {
    expect(diffApiCaptures(ok, ok, ok)).toEqual({ changes: [], raw: 0, noise: 0 });
  });

  it.each([
    [
      'a request that stopped answering',
      capture('timeout'),
      {
        kind: 'failed-request',
        before: { status: 200 },
        after: { error: 'PROBE_TIMEOUT' },
        noLongerAnswers: true,
      },
    ],
    [
      'a new status alone',
      capture(response({ status: 500, body: text('oops', 'b') })),
      { kind: 'status-changed', before: 200, after: 500 },
    ],
    [
      'a new content type alone',
      capture(response({ contentType: 'text/html', body: text('<p>', 'c') })),
      { kind: 'content-type-changed', before: 'application/json', after: 'text/html' },
    ],
    [
      'a new redirect target',
      capture(response({ headers: { location: '/next' } })),
      { kind: 'value-changed', before: { location: null }, after: { location: '/next' } },
    ],
    [
      'a body that is no longer JSON',
      capture(response({ body: text('42', 'd') })),
      { kind: 'type-changed', jsonPath: '$', before: 'json', after: 'text' },
    ],
  ])('reports %s', (_name, head, change) => {
    expect(diffApiCaptures(ok, ok, head)).toEqual({ changes: [change], raw: 1, noise: 0 });
  });

  it('compares JSON bodies by path', () => {
    const head = capture(
      response({
        body: { kind: 'json', json: { total: '$42.00', currency: 'USD' }, sha256: 'e'.repeat(64) },
      }),
    );

    expect(diffApiCaptures(ok, ok, head).changes).toEqual([
      { kind: 'field-added', jsonPath: '$.currency', after: 'USD' },
      { kind: 'type-changed', jsonPath: '$.total', before: 42, after: '$42.00' },
    ]);
  });

  it('compares other bodies as a whole, with excerpts', () => {
    const a = capture(response({ contentType: 'text/plain', body: text('pong', '1') }));
    const head = capture(response({ contentType: 'text/plain', body: text('pang', '2') }));

    expect(diffApiCaptures(a, a, head).changes).toEqual([
      { kind: 'value-changed', jsonPath: '$', before: 'pong', after: 'pang' },
    ]);
  });

  it.each([
    ['status', response(), response({ status: 503 })],
    ['content type', response(), response({ contentType: 'text/html' })],
    [
      'text body',
      response({ contentType: 'text/plain', body: text('pong', '1') }),
      response({ contentType: 'text/plain', body: text('pang', '2') }),
    ],
  ])('sets aside a %s that already differs between baseA and baseB', (_name, base, flaky) => {
    expect(diffApiCaptures(capture(base), capture(flaky), capture(flaky))).toEqual({
      changes: [],
      raw: 1,
      noise: 1,
    });
  });

  it('compares nothing when a base got no answer', () => {
    expect(diffApiCaptures(capture('timeout'), ok, ok)).toEqual({ changes: [], raw: 0, noise: 0 });
    expect(diffApiCaptures(ok, capture('timeout'), capture('timeout'))).toEqual({
      changes: [],
      raw: 0,
      noise: 0,
    });
  });
});
