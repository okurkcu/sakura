import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CaptureOptions, PageObservation, UiBrowser, UiBrowserLauncher } from './browser.js';
import { createUiProbeStage, toUiCapture } from './ui-probe-stage.js';
import { nodeFileSystem } from '../../adapters/file-system.js';
import type { RunningEnvironment } from '../../domain/environment.js';
import type { ImpactPlan, Route } from '../../domain/impact.js';
import { BdiffError } from '../../errors/bdiff-error.js';
import type { RunCounts } from '../../metrics/run-record.js';
import { createTestStageContext } from '../../testing/stage-context.js';

const BASE = 'http://127.0.0.1:41001';
const HEAD = 'http://127.0.0.1:41002';
const environment: RunningEnvironment = {
  project: 'bdiff-test',
  sides: { base: { url: BASE, service: 'app-base' }, head: { url: HEAD, service: 'app-head' } },
};

const page = (routePath: string): Route => ({
  path: routePath,
  kind: 'page',
  file: `app${routePath}/page.tsx`,
  dynamic: false,
});

const plan = (...paths: string[]): ImpactPlan => ({
  pages: paths.map(page),
  endpoints: [],
  notProbed: [],
  confidence: 'high',
  unmappedFiles: [],
  notes: [],
});

const observation = (overrides: Partial<PageObservation> = {}): PageObservation => ({
  status: 200,
  title: 'Shop',
  text: 'Hello',
  screenshotSaved: true,
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  blockedRequests: [],
  settled: true,
  ...overrides,
});

/** A launcher whose browser answers each URL with a scripted observation (or throw). */
function fakeLauncher(answer: (url: string) => PageObservation | Error = () => observation()) {
  const calls: { url: string; options: CaptureOptions }[] = [];
  const state = { launches: 0, closes: 0 };
  const launcher: UiBrowserLauncher = {
    launch: () => {
      state.launches += 1;
      const browser: UiBrowser = {
        capture: (url, options) => {
          calls.push({ url, options });
          const result = answer(url);
          return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
        },
        close: () => {
          state.closes += 1;
          return Promise.resolve();
        },
      };
      return Promise.resolve(browser);
    },
  };
  return { launcher, calls, state };
}

describe('createUiProbeStage', () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'bdiff-ui-'));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  it('captures every page on baseA, then baseB (both base), then head, into the artifact paths', async () => {
    const fake = fakeLauncher();
    const test = createTestStageContext({ outDir });
    const counts: Partial<RunCounts>[] = [];
    const ctx = { ...test.ctx, addCounts: (added: Partial<RunCounts>) => counts.push(added) };

    const captures = await createUiProbeStage({
      browser: fake.launcher,
      fs: nodeFileSystem,
      routeTimeoutMs: 1_234,
    }).run({ environment, impact: plan('/', '/login') }, ctx);

    expect(fake.calls.map((call) => call.url)).toEqual([
      `${BASE}/`,
      `${BASE}/login`,
      `${BASE}/`,
      `${BASE}/login`,
      `${HEAD}/`,
      `${HEAD}/login`,
    ]);
    expect(captures.map((capture) => [capture.probeRun, capture.route])).toEqual([
      ['baseA', '/'],
      ['baseA', '/login'],
      ['baseB', '/'],
      ['baseB', '/login'],
      ['head', '/'],
      ['head', '/login'],
    ]);
    expect(fake.calls[3]?.options).toEqual({
      screenshotPath: test.ctx.paths.uiScreenshot('baseB', '/login'),
      timeoutMs: 1_234,
    });
    expect(captures[3]?.screenshot).toBe(test.ctx.paths.uiScreenshot('baseB', '/login'));
    for (const probeRun of ['baseA', 'baseB', 'head'] as const) {
      const dir = path.dirname(test.ctx.paths.uiScreenshot(probeRun, '/'));
      expect((await stat(dir)).isDirectory()).toBe(true);
    }
    expect(counts).toEqual([{ routesProbed: 2 }]);
    expect(fake.state).toEqual({ launches: 1, closes: 1 });
    expect(test.cleanups.map((cleanup) => cleanup.name)).toEqual(['browser']);
  });

  it('records a failing page with its error and goes on with the next ones', async () => {
    const fake = fakeLauncher((url) =>
      url.endsWith('/slow')
        ? observation({
            status: null,
            title: '',
            text: '',
            screenshotSaved: false,
            settled: false,
            error: {
              code: 'PROBE_TIMEOUT',
              message: `page.goto: Timeout 1000ms exceeded.\nCall log:\n  - navigating to "${url}"`,
            },
          })
        : observation(),
    );

    const captures = await createUiProbeStage({ browser: fake.launcher, fs: nodeFileSystem }).run(
      { environment, impact: plan('/slow', '/ok') },
      createTestStageContext({ outDir }).ctx,
    );

    expect(captures).toHaveLength(6);
    expect(captures[0]).toMatchObject({
      route: '/slow',
      status: null,
      error: { code: 'PROBE_TIMEOUT', message: 'page.goto: Timeout 1000ms exceeded.' },
    });
    expect(captures[0]).not.toHaveProperty('screenshot');
    expect(captures[1]).toMatchObject({ route: '/ok', status: 200 });
    expect(captures[1]).not.toHaveProperty('error');
  });

  it('does not start a browser when there are no pages to capture', async () => {
    const fake = fakeLauncher();

    const captures = await createUiProbeStage({ browser: fake.launcher, fs: nodeFileSystem }).run(
      { environment, impact: plan() },
      createTestStageContext({ outDir }).ctx,
    );

    expect(captures).toEqual([]);
    expect(fake.state.launches).toBe(0);
  });

  it('stops on a browser failure and closes the browser', async () => {
    const fake = fakeLauncher(() => new BdiffError('PROBE_FAILED', 'The browser failed'));
    const stage = createUiProbeStage({ browser: fake.launcher, fs: nodeFileSystem });

    await expect(
      stage.run({ environment, impact: plan('/') }, createTestStageContext({ outDir }).ctx),
    ).rejects.toMatchObject({ code: 'PROBE_FAILED' });
    expect(fake.state.closes).toBe(1);
  });

  it('stops with ABORTED when the run is aborted between pages, and closes the browser', async () => {
    const controller = new AbortController();
    const fake = fakeLauncher(() => {
      controller.abort();
      return observation();
    });
    const test = createTestStageContext({ outDir, signal: controller.signal });

    await expect(
      createUiProbeStage({ browser: fake.launcher, fs: nodeFileSystem }).run(
        { environment, impact: plan('/', '/login') },
        test.ctx,
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(fake.calls).toHaveLength(1);
    expect(fake.state.closes).toBe(1);
  });

  it('reports a capture interrupted by an abort as ABORTED', async () => {
    const controller = new AbortController();
    const fake = fakeLauncher(() => {
      controller.abort();
      return new Error('Target page, context or browser has been closed');
    });

    await expect(
      createUiProbeStage({ browser: fake.launcher, fs: nodeFileSystem }).run(
        { environment, impact: plan('/') },
        createTestStageContext({ outDir, signal: controller.signal }).ctx,
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('closes the browser from its cleanup hook', async () => {
    const fake = fakeLauncher();
    const test = createTestStageContext({ outDir });
    await createUiProbeStage({ browser: fake.launcher, fs: nodeFileSystem }).run(
      { environment, impact: plan('/') },
      test.ctx,
    );

    await test.runCleanups();

    expect(fake.state.closes).toBe(2);
  });
});

describe('toUiCapture', () => {
  it('normalizes text and removes the app origin from URLs and messages', () => {
    const capture = toUiCapture({
      probeRun: 'head',
      route: '/status',
      origin: HEAD,
      screenshotPath: '/out/status.png',
      durationMs: 1_500,
      observation: observation({
        title: `Status of ${HEAD}`,
        text: `  Status \n\n\n Served by ${HEAD}/status  `,
        consoleErrors: [`Failed to load resource at ${HEAD}/api/status`],
        pageErrors: [`TypeError: cannot read ${HEAD}/x`],
        failedRequests: [
          { url: `${HEAD}/api/status?x=1`, method: 'GET', status: 404 },
          {
            url: 'https://cdn.example.com/a.js',
            method: 'GET',
            status: null,
            failure: `net::ERR_FAILED from ${HEAD}`,
          },
        ],
        blockedRequests: [
          'https://b.example.com/',
          'https://a.example.com/',
          'https://b.example.com/',
        ],
      }),
    });

    expect(capture).toEqual({
      probeRun: 'head',
      route: '/status',
      status: 200,
      title: 'Status of ',
      text: 'Status\n\nServed by /status',
      screenshot: '/out/status.png',
      consoleErrors: ['Failed to load resource at /api/status'],
      pageErrors: ['TypeError: cannot read /x'],
      failedRequests: [
        { url: '/api/status?x=1', method: 'GET', status: 404 },
        {
          url: 'https://cdn.example.com/a.js',
          method: 'GET',
          status: null,
          failure: 'net::ERR_FAILED from ',
        },
      ],
      blockedRequests: ['https://a.example.com/', 'https://b.example.com/'],
      settled: true,
      durationMs: 1_500,
    });
  });
});
