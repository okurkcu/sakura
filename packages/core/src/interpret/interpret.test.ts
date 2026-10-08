import { describe, expect, it } from 'vitest';

import { compactFindings } from './compact.js';
import { coverageOf, describeCoverage } from './coverage.js';
import { tierFor } from './routing.js';
import type { ApiProbe } from '../domain/api-probe.js';
import type { Finding } from '../domain/finding.js';
import type { ImpactPlan } from '../domain/impact.js';
import type { UiCapture } from '../domain/ui-capture.js';

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  id: 'f1',
  kind: 'text',
  severity: 'info',
  location: { route: '/login' },
  evidence: ['/out/runs/x/ui/head/login.png'],
  ...overrides,
});

describe('tierFor', () => {
  it.each([
    ['no breaking finding', [finding()], 'fast'],
    ['a breaking finding', [finding(), finding({ id: 'f2', severity: 'breaking' })], 'smart'],
    ['15 findings', Array.from({ length: 15 }, (_, i) => finding({ id: `f${String(i)}` })), 'fast'],
    [
      '16 findings',
      Array.from({ length: 16 }, (_, i) => finding({ id: `f${String(i)}` })),
      'smart',
    ],
  ] as const)('uses %s → %s', (_name, findings, tier) => {
    expect(tierFor(findings)).toBe(tier);
  });
});

describe('compactFindings', () => {
  it('drops evidence and bounding boxes, joins the place, and cuts long values', () => {
    expect(
      compactFindings([
        finding({
          kind: 'visual',
          location: { route: '/login', bbox: { x: 1, y: 2, width: 3, height: 4 } },
        }),
        finding({
          id: 'f2',
          kind: 'type-changed',
          severity: 'breaking',
          location: { endpoint: 'GET /api/orders/latest', jsonPath: '$.total' },
          before: 42,
          after: 'x'.repeat(400),
        }),
      ]),
    ).toEqual([
      { id: 'f1', kind: 'visual', severity: 'info', where: '/login' },
      {
        id: 'f2',
        kind: 'type-changed',
        severity: 'breaking',
        where: 'GET /api/orders/latest $.total',
        before: 42,
        after: `${JSON.stringify('x'.repeat(400)).slice(0, 300)}… (cut)`,
      },
    ]);
  });
});

describe('coverageOf / describeCoverage', () => {
  const impact: ImpactPlan = {
    pages: [],
    endpoints: [],
    notProbed: [
      {
        route: {
          path: '/blog/[slug]',
          kind: 'page',
          file: 'app/blog/[slug]/page.tsx',
          dynamic: true,
        },
        reason: 'dynamic-params',
      },
    ],
    confidence: 'medium',
    unmappedFiles: ['next.config.ts'],
    notes: [],
  };
  const capture = (route: string, broken = false): UiCapture => ({
    probeRun: 'head',
    route,
    status: 200,
    title: '',
    text: '',
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    blockedRequests: [],
    settled: true,
    durationMs: 1,
    ...(broken ? { error: { code: 'PROBE_TIMEOUT', message: 'slow' } } : {}),
  });
  const api: ApiProbe = {
    requests: [
      {
        key: 'GET /api/a',
        source: 'route',
        method: 'GET',
        path: '/api/a',
        headers: {},
        endpoint: 'GET /api/a',
      },
      {
        key: 'GET /api/b',
        source: 'route',
        method: 'GET',
        path: '/api/b',
        headers: {},
        endpoint: 'GET /api/b',
      },
    ],
    captures: [
      {
        probeRun: 'head',
        requestKey: 'GET /api/b',
        durationMs: 1,
        artifact: '/b.json',
        error: { code: 'PROBE_TIMEOUT', message: 'slow' },
      },
    ],
    notProbed: [
      { endpoint: 'POST /api/c', reason: 'generation-failed', detail: 'LLM_UNAVAILABLE: no key' },
    ],
  };

  it('lists what was probed and every gap with its reason', () => {
    const coverage = coverageOf(impact, [capture('/'), capture('/slow', true)], api);

    expect(coverage).toEqual({
      pages: ['/'],
      endpoints: ['GET /api/a'],
      gaps: [
        { what: '/blog/[slug]', reason: 'dynamic route, needs parameters bdiff does not have' },
        { what: '/slow', reason: 'the page could not be captured' },
        { what: 'GET /api/b', reason: 'the request got no answer' },
        { what: 'POST /api/c', reason: 'no example request could be generated' },
        { what: 'next.config.ts', reason: 'changed, but reaches no probed route' },
      ],
    });
    expect(describeCoverage(coverage)).toBe(
      'Probed 1 page (/) and 1 endpoint (GET /api/a). Not verified: /blog/[slug] (dynamic route, needs parameters bdiff does not have); /slow (the page could not be captured); GET /api/b (the request got no answer); POST /api/c (no example request could be generated); next.config.ts (changed, but reaches no probed route).',
    );
  });

  it('says when nothing was left out', () => {
    expect(describeCoverage({ pages: ['/login', '/'], endpoints: [], gaps: [] })).toBe(
      'Probed 2 pages (/login, /) and 0 endpoints; nothing the change can affect was left out.',
    );
  });
});
