import { networkInterfaces } from 'node:os';

import { BdiffError, systemClock } from '@bdiff/core';
import type { RunEvent } from '@bdiff/core';
import { createMemoryFileSystem, createTestLogger, TEST_TARGET } from '@bdiff/core/testing';
import type { MemoryFileSystem } from '@bdiff/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import type { FixtureResponse, RunDetailResponse, RunsResponse, StatusResponse } from '../api.js';
import { createWorkspaceRunSource } from './run-source.js';
import type { ExperimentNumbers } from './runs.js';
import { matchRoute, PANEL_HOST, startPanelServer, withoutRunning } from './server.js';
import type { PanelDeps, PanelServer, SuiteRunner } from './server.js';
import { eventLines, rawGet, testRecord, testResult } from '../testing/helpers.js';

const OLD = '01k6t3y8k0g3m5x9a2b7c4d6ef';
const NEW = '01k6t3y9aaaaaaaaaaaaaaaaaa';
const LIVE = '01k6t3yaaaaaaaaaaaaaaaaaaa';
const XSS = '<img src=x onerror=alert(1)><script>alert(1)</script>';

const numbers: ExperimentNumbers = {
  setup: { attempted: 2, succeeded: 2, rate: 1 },
  durationMs: { count: 2, median: 60_000 },
  llmCostUsd: { count: 2, median: 0 },
  targets: { setupRate: 0.5, medianDurationMs: 600_000 },
};

const started = (pid: number): RunEvent => ({
  type: 'run-started',
  at: new Date().toISOString(),
  runId: LIVE,
  target: TEST_TARGET,
  toolVersion: 'test',
  llmMode: 'off',
  pid,
});

/** A workspace with two finished runs, one in progress and one broken. */
function workspace(): MemoryFileSystem {
  const older = testRecord(OLD, { startedAt: '2026-01-01T00:00:00.000Z', headRef: 'pr/ui-change' });
  const newer = testRecord(NEW, { startedAt: '2026-01-02T00:00:00.000Z', prTitle: XSS });
  return createMemoryFileSystem({
    [`/ws/runs/${OLD}/run.json`]: JSON.stringify(older),
    [`/ws/runs/${OLD}/result.json`]: JSON.stringify(testResult(older, { findings: [] })),
    [`/ws/runs/${OLD}/events.jsonl`]: eventLines([
      { type: 'stage-started', at: '2026-01-01T00:00:00.000Z', stage: 'workspace' },
    ]),
    [`/ws/runs/${OLD}/logs/base.log`]: 'base log',
    [`/ws/runs/${OLD}/ui/head/login-12345678.png`]: new Uint8Array([137, 80, 78, 71]),
    [`/ws/runs/${OLD}/worktrees/head/secret.json`]: '{}',
    [`/ws/runs/${OLD}/notes.exe`]: 'MZ',
    [`/ws/runs/${NEW}/run.json`]: JSON.stringify(newer),
    [`/ws/runs/${LIVE}/events.jsonl`]: eventLines([started(4242)]),
    '/ws/runs/01k6t3ybbbbbbbbbbbbbbbbbbb/run.json': '{ broken',
    '/ws/secret.json': '{"secret":true}',
    '/web/index.html': '<!doctype html><title>panel</title>',
    '/web/assets/app.js': 'console.log(1)',
  });
}

let server: PanelServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(
  fs: MemoryFileSystem,
  overrides: Partial<PanelDeps> = {},
): Promise<PanelServer> {
  server = await startPanelServer(
    {
      source: createWorkspaceRunSource({ fs, root: '/ws', isAlive: (pid) => pid === 4242 }),
      fs,
      clock: systemClock,
      logger: createTestLogger(),
      demo: false,
      toolVersion: 'test-version',
      llmMode: 'off',
      webRoot: '/web',
      docker: {
        status: () => Promise.resolve('connected'),
        leftovers: () => Promise.resolve({ status: 'clean' }),
      },
      experiment: () => numbers,
      pollMs: 20,
      ...overrides,
    },
    0,
  );
  return server;
}

async function json<T>(running: PanelServer, path: string): Promise<T> {
  const response = await fetch(`${running.url}${path}`);
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

describe('startPanelServer', () => {
  it('listens on 127.0.0.1 only', async () => {
    const running = await start(workspace());

    expect(running.url).toBe(`http://${PANEL_HOST}:${String(running.port)}`);
    const external = Object.values(networkInterfaces())
      .flat()
      .find((address) => address?.family === 'IPv4' && !address.internal);
    if (external !== undefined) {
      await expect(
        fetch(`http://${external.address}:${String(running.port)}/api/status`),
      ).rejects.toThrow();
    }
  });

  it('lists runs newest first, a run in progress included, and counts unreadable ones', async () => {
    const running = await start(workspace());

    const body = await json<RunsResponse>(running, '/api/runs');

    expect(body.runs.map((run) => [run.runId, run.state])).toEqual([
      [LIVE, 'running'],
      [NEW, 'success'],
      [OLD, 'success'],
    ]);
    expect(body.unreadable).toBe(1);
    expect(body.metrics.map((metric) => metric.id)).toEqual([
      'setup-success',
      'median-duration',
      'noise-filtered',
      'cost-per-pr',
    ]);
  });

  it('shows a run whose process is gone as interrupted', async () => {
    const fs = workspace();
    fs.files.set(`/ws/runs/${LIVE}/events.jsonl`, eventLines([started(999_999)]));
    const running = await start(fs);

    const body = await json<RunsResponse>(running, '/api/runs');

    expect(body.runs.find((run) => run.runId === LIVE)?.state).toBe('interrupted');
  });

  it('returns one run: record, result, events and the files it can serve', async () => {
    const running = await start(workspace());

    const body = await json<RunDetailResponse>(running, `/api/runs/${OLD}`);

    expect(body.summary.runId).toBe(OLD);
    expect(body.record?.runId).toBe(OLD);
    expect(body.result?.findings).toEqual([]);
    expect(body.events).toHaveLength(1);
    expect(body.files).toEqual([
      'events.jsonl',
      'logs/base.log',
      'result.json',
      'run.json',
      'ui/head/login-12345678.png',
    ]);
  });

  it('returns untrusted text as JSON data, never as markup', async () => {
    const running = await start(workspace());

    const response = await fetch(`${running.url}/api/runs/${NEW}`);

    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(((await response.json()) as RunDetailResponse).summary.target.prTitle).toBe(XSS);
  });

  it('serves run files read-only with their media type', async () => {
    const running = await start(workspace());

    const log = await fetch(`${running.url}/api/runs/${OLD}/files/logs/base.log`);
    const png = await fetch(`${running.url}/api/runs/${OLD}/files/ui/head/login-12345678.png`);

    expect(log.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await log.text()).toBe('base log');
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it.each([
    `/api/runs/${OLD}/files/../../secret.json`,
    `/api/runs/${OLD}/files/%2e%2e/%2e%2e/secret.json`,
    `/api/runs/${OLD}/files/..%2F..%2Fsecret.json`,
    `/api/runs/${OLD}/files/%2Fws%2Fsecret.json`,
    `/api/runs/${OLD}/files/logs%5C..%5C..%5Csecret.json`,
    `/api/runs/${OLD}/files/notes.exe`,
    '/api/runs/not-a-run/files/run.json',
    '/api/runs/..%2F..%2Fws/files/secret.json',
    '/../ws/secret.json',
    '/%2e%2e/%2e%2e/ws/secret.json',
  ])('refuses %s', async (path) => {
    const running = await start(workspace());

    const response = await rawGet(running.port, path);

    expect(response.status).toBe(404);
    expect(response.body).not.toContain('"secret":true');
  });

  it('refuses requests for another host name (DNS rebinding) and cross-origin POSTs', async () => {
    const suite: SuiteRunner = { run: () => Promise.resolve() };
    const running = await start(workspace(), { suite, expectedFile: '/expected.json' });

    expect((await rawGet(running.port, '/api/status', { Host: 'evil.example:80' })).status).toBe(
      403,
    );
    expect(
      (await rawGet(running.port, '/api/suite/run', { Origin: 'https://evil.example' }, 'POST'))
        .status,
    ).toBe(403);
    expect((await rawGet(running.port, '/api/suite/run', {}, 'POST')).status).toBe(403);
  });

  it('serves the web UI with its CSP, and index.html for app routes', async () => {
    const running = await start(workspace());

    const index = await fetch(`${running.url}/`);
    const route = await fetch(`${running.url}/runs/anything`);
    const asset = await fetch(`${running.url}/assets/app.js`);
    const missing = await fetch(`${running.url}/assets/missing.js`);

    expect(await index.text()).toContain('<title>panel</title>');
    expect(index.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(index.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(route.status).toBe(200);
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(missing.status).toBe(404);
  });

  it('reports its status: workspace, LLM mode, Docker and whether the suite can run', async () => {
    const running = await start(workspace());

    expect(await json<StatusResponse>(running, '/api/status')).toEqual({
      demo: false,
      workspace: '/ws',
      toolVersion: 'test-version',
      llmMode: 'off',
      docker: 'connected',
      canRunSuite: false,
      suite: null,
    });
  });

  it('runs the fixture suite once at a time, and cancels it', async () => {
    let signal: AbortSignal | undefined;
    const suite: SuiteRunner = {
      run: (received) => {
        signal = received;
        return new Promise((_resolve, reject) => {
          received.addEventListener('abort', () => {
            reject(new BdiffError('ABORTED', 'cancelled'));
          });
        });
      },
    };
    const fs = workspace();
    fs.files.set('/expected.json', '{}');
    const running = await start(fs, { suite, expectedFile: '/expected.json' });
    const post = (path: string) => rawGet(running.port, path, { Origin: running.url }, 'POST');

    expect((await post('/api/suite/run')).status).toBe(202);
    expect((await post('/api/suite/run')).status).toBe(409);
    expect((await json<StatusResponse>(running, '/api/status')).suite?.state).toBe('running');
    expect((await post('/api/suite/cancel')).status).toBe(202);
    expect(signal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await json<StatusResponse>(running, '/api/status')).suite?.state).toBe('cancelled');
  });

  it('compares the fixture runs with expected.json', async () => {
    const fs = workspace();
    fs.files.set(
      '/expected.json',
      JSON.stringify({
        baseBranch: 'main',
        noisyRoutes: ['/dashboard'],
        branches: {
          'pr/ui-change': { description: 'x', impact: { routes: [] }, findings: [] },
        },
      }),
    );
    const running = await start(fs, { expectedFile: '/expected.json' });

    const body = await json<FixtureResponse>(running, '/api/fixture');

    expect(body.available).toBe(true);
    expect(body.checks.map((check) => [check.id, check.status])).toEqual([
      ['branch:pr/ui-change', 'pass'],
      ['noise', 'missing'],
      ['cleanup', 'pass'],
    ]);
  });

  it('says when there is no expected.json to compare with', async () => {
    const running = await start(workspace());

    expect(await json<FixtureResponse>(running, '/api/fixture')).toEqual({
      available: false,
      checks: [],
      lastRunAt: null,
    });
  });
});

describe('live events (SSE)', () => {
  /** Reads an event stream until `until` matches what was received, or 5 s pass. */
  async function readStream(
    url: string,
    until: (text: string) => boolean,
    headers: Record<string, string> = {},
    onOpen: () => void = () => undefined,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 5_000);
    const response = await fetch(url, { signal: controller.signal, headers });
    expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    onOpen();
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      while (reader !== undefined && !until(text)) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        text += decoder.decode(value);
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    return text;
  }

  it('sends the events so far, then new ones as the file grows, within a second', async () => {
    const fs = workspace();
    const running = await start(fs);
    const file = `/ws/runs/${LIVE}/events.jsonl`;
    let appendedAt = 0;

    const text = await readStream(
      `${running.url}/api/runs/${LIVE}/events`,
      (received) => received.includes('"stage":"workspace"'),
      {},
      () => {
        setTimeout(() => {
          appendedAt = Date.now();
          fs.files.set(
            file,
            `${String(fs.files.get(file))}${eventLines([
              { type: 'stage-started', at: new Date().toISOString(), stage: 'workspace' },
            ])}`,
          );
        }, 100);
      },
    );

    expect(Date.now() - appendedAt).toBeLessThan(1_000);
    expect(text).toContain('id: 0\nevent: run-event\ndata: {"type":"run-started"');
    expect(text).toContain('id: 1\nevent: run-event\ndata: {"type":"stage-started"');
  });

  it('resumes after the last event the browser saw (Last-Event-ID)', async () => {
    const fs = workspace();
    const file = `/ws/runs/${LIVE}/events.jsonl`;
    fs.files.set(
      file,
      `${String(fs.files.get(file))}${eventLines([
        { type: 'stage-started', at: new Date().toISOString(), stage: 'workspace' },
      ])}`,
    );
    const running = await start(fs);

    const text = await readStream(
      `${running.url}/api/runs/${LIVE}/events`,
      (received) => received.includes('id: 1'),
      { 'Last-Event-ID': '0' },
    );

    expect(text).not.toContain('id: 0');
    expect(text).toContain('id: 1\n');
  });

  it('ends the stream once the run finished and its run.json exists', async () => {
    const fs = workspace();
    const file = `/ws/runs/${OLD}/events.jsonl`;
    fs.files.set(
      file,
      `${String(fs.files.get(file))}${eventLines([
        { type: 'run-finished', at: new Date().toISOString(), status: 'success', durationMs: 1 },
      ])}`,
    );
    const running = await start(fs);

    const text = await readStream(`${running.url}/api/runs/${OLD}/events`, (received) =>
      received.includes('event: end'),
    );

    expect(text).toContain('id: 1\nevent: run-event\ndata: {"type":"run-finished"');
    expect(text).toContain('event: end');
  });

  it('answers 404 for a run that does not exist', async () => {
    const running = await start(workspace());

    expect((await fetch(`${running.url}/api/runs/01k6t3yccccccccccccccccccc/events`)).status).toBe(
      404,
    );
  });
});

describe('matchRoute', () => {
  it.each([
    ['GET', '/api/status', 'GET status'],
    ['GET', '/api/runs', 'GET runs'],
    ['GET', `/api/runs/${OLD}`, 'GET run'],
    ['GET', `/api/runs/${OLD}/events`, 'GET run-events'],
    ['GET', `/api/runs/${OLD}/files/ui/a.png`, 'GET run-file'],
    ['GET', '/api/fixture', 'GET fixture'],
    ['POST', '/api/suite/run', 'POST suite-run'],
    ['POST', '/api/suite/cancel', 'POST suite-cancel'],
    ['GET', '/api/%E0%A4%A', 'invalid'],
  ])('%s %s → %s', (method, path, name) => {
    expect(matchRoute(method, path)?.name).toBe(name);
  });

  it.each([
    ['POST', '/api/runs'],
    ['GET', '/api/suite/run'],
    ['GET', '/'],
  ])('%s %s is no API route', (method, path) => {
    expect(matchRoute(method, path)).toBeUndefined();
  });
});

describe('withoutRunning', () => {
  it('leaves out the resources of runs in progress', () => {
    expect(
      withoutRunning(
        {
          status: 'leftovers',
          items: [`container bdiff-${LIVE}-app-base-1`, `network bdiff-${OLD}_default`],
        },
        [LIVE],
      ),
    ).toEqual({ status: 'leftovers', items: [`network bdiff-${OLD}_default`] });
    expect(
      withoutRunning({ status: 'leftovers', items: [`volume bdiff-${LIVE}_db`] }, [LIVE]),
    ).toEqual({
      status: 'clean',
    });
  });
});
