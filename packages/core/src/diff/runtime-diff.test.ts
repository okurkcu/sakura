import { describe, expect, it } from 'vitest';

import { diffRuntime } from './runtime-diff.js';
import type { UiCapture } from '../domain/ui-capture.js';

const capture = (overrides: Partial<UiCapture> = {}): UiCapture => ({
  probeRun: 'baseA',
  route: '/status',
  status: 200,
  title: 'Shop',
  text: '',
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  blockedRequests: [],
  settled: true,
  durationMs: 1,
  ...overrides,
});

describe('diffRuntime', () => {
  const known = capture({
    consoleErrors: ['Could not load the service status: status 404'],
    failedRequests: [{ url: '/api/status', method: 'GET', status: 404 }],
  });

  it('ignores signals baseA already had', () => {
    expect(diffRuntime(known, known, known)).toEqual({ signals: [], raw: 0, noise: 0 });
  });

  it('reports new page errors, console errors and failed requests, once each', () => {
    const head = capture({
      ...known,
      pageErrors: ['TypeError: x is undefined', 'TypeError: x is undefined'],
      consoleErrors: [...known.consoleErrors, 'Hydration failed'],
      failedRequests: [
        ...known.failedRequests,
        { url: '/api/cart', method: 'POST', status: null, failure: 'net::ERR_ABORTED' },
      ],
    });

    expect(diffRuntime(known, known, head)).toEqual({
      signals: [
        { source: 'page-error', message: 'TypeError: x is undefined' },
        { source: 'console-error', message: 'Hydration failed' },
        { source: 'failed-request', message: 'POST /api/cart → net::ERR_ABORTED' },
      ],
      raw: 3,
      noise: 0,
    });
  });

  it('treats a signal baseB had but baseA did not as noise', () => {
    const flaky = capture({ consoleErrors: ['Analytics timed out'] });

    expect(diffRuntime(capture(), flaky, flaky)).toEqual({ signals: [], raw: 1, noise: 1 });
  });
});
