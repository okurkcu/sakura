import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appUrl, createApiProbeStage, FIXED_REQUEST_HEADERS } from './api-probe-stage.js';
import { REQUESTS_FILE } from './requests-file.js';
import { nodeFileSystem } from '../../adapters/file-system.js';
import type { RunningEnvironment } from '../../domain/environment.js';
import type { ImpactPlan } from '../../domain/impact.js';
import { RecipeSchema } from '../../domain/recipe.js';
import type { Workspace } from '../../domain/workspace.js';
import type { RunCounts } from '../../metrics/run-record.js';
import { FakeHttp } from '../../testing/fake-http.js';
import { FakeLlmClient } from '../../testing/fake-llm-client.js';
import { createTestStageContext } from '../../testing/stage-context.js';

const BASE = 'http://127.0.0.1:41001';
const HEAD = 'http://127.0.0.1:41002';
const SHA = 'a'.repeat(40);
const environment: RunningEnvironment = {
  project: 'bdiff-test',
  sides: { base: { url: BASE, service: 'app-base' }, head: { url: HEAD, service: 'app-head' } },
};
const recipe = RecipeSchema.parse({
  installRoot: '.',
  appRoot: '.',
  nodeVersion: '22',
  packageManager: { name: 'pnpm', version: '12.9.1' },
  installCmd: ['pnpm', 'install'],
  buildCmd: ['pnpm', 'run', 'build'],
  startCmd: ['pnpm', 'start'],
  port: 3000,
  healthPath: '/',
  env: {},
  missingEnv: [],
  services: [],
  dbSetupCmds: [],
  confidence: 'high',
  notes: [],
});
const impact: ImpactPlan = {
  pages: [],
  endpoints: [
    {
      path: '/api/orders/latest',
      kind: 'api',
      method: 'GET',
      file: 'app/api/orders/latest/route.ts',
      dynamic: false,
    },
  ],
  notProbed: [],
  confidence: 'high',
  unmappedFiles: [],
  notes: [],
};

describe('createApiProbeStage', () => {
  let root: string;
  let workspace: Workspace;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-api-'));
    workspace = {
      basePath: path.join(root, 'base'),
      headPath: path.join(root, 'head'),
      baseSha: SHA,
      headSha: SHA,
      changedFiles: [],
    };
    await mkdir(workspace.headPath, { recursive: true });
    await writeFile(
      path.join(workspace.headPath, REQUESTS_FILE),
      JSON.stringify({ requests: [{ method: 'POST', path: '/api/echo', json: { a: 1 } }] }),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const json = (body: unknown) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('sends every request to base twice, then to head, and stores captures and artifacts', async () => {
    const http = new FakeHttp()
      .onRequest(`POST ${BASE}/api/echo`, json({ ok: true }))
      .onRequest(`POST ${HEAD}/api/echo`, json({ ok: true }))
      .onRequest(`GET ${BASE}/api/orders/latest`, json({ total: 42 }))
      .onRequest(`GET ${HEAD}/api/orders/latest`, json({ total: '€42.00', currency: 'EUR' }));
    const test = createTestStageContext({ outDir: path.join(root, 'out') });
    const counts: Partial<RunCounts>[] = [];

    const probe = await createApiProbeStage({
      http,
      fs: nodeFileSystem,
      llm: new FakeLlmClient(),
      requestTimeoutMs: 1_234,
    }).run(
      { workspace, recipe, environment, impact },
      { ...test.ctx, addCounts: (added: Partial<RunCounts>) => counts.push(added) },
    );

    expect(http.exchanges.map((request) => `${request.method} ${request.url}`)).toEqual([
      `POST ${BASE}/api/echo`,
      `GET ${BASE}/api/orders/latest`,
      `POST ${BASE}/api/echo`,
      `GET ${BASE}/api/orders/latest`,
      `POST ${HEAD}/api/echo`,
      `GET ${HEAD}/api/orders/latest`,
    ]);
    expect(http.exchanges[0]).toMatchObject({
      headers: { ...FIXED_REQUEST_HEADERS, 'content-type': 'application/json' },
      body: '{"a":1}',
      timeoutMs: 1_234,
    });
    expect(http.exchanges[1]).not.toHaveProperty('body');
    expect(probe.requests.map((request) => [request.key, request.source])).toEqual([
      ['POST /api/echo', 'explicit'],
      ['GET /api/orders/latest', 'route'],
    ]);
    expect(probe.captures.map((capture) => [capture.probeRun, capture.requestKey])).toEqual([
      ['baseA', 'POST /api/echo'],
      ['baseA', 'GET /api/orders/latest'],
      ['baseB', 'POST /api/echo'],
      ['baseB', 'GET /api/orders/latest'],
      ['head', 'POST /api/echo'],
      ['head', 'GET /api/orders/latest'],
    ]);
    const head = probe.captures[5];
    expect(head?.response?.body).toMatchObject({
      kind: 'json',
      json: { total: '€42.00', currency: 'EUR' },
    });
    expect(head?.artifact).toBe(test.ctx.paths.apiResponse('head', 'GET /api/orders/latest'));
    expect(JSON.parse(await readFile(head?.artifact ?? '', 'utf8'))).toMatchObject({
      probeRun: 'head',
      request: { key: 'GET /api/orders/latest', source: 'route' },
      response: { status: 200 },
    });
    expect(counts).toEqual([{ endpointsProbed: 2 }]);
  });

  it('records timeouts and refused connections per request and goes on', async () => {
    const http = new FakeHttp()
      .onRequest(`POST ${BASE}/api/echo`, 'timeout')
      .onRequest(`GET ${BASE}/api/orders/latest`, json({ total: 42 }))
      .onRequest(`POST ${HEAD}/api/echo`, 'refused')
      .onRequest(`GET ${HEAD}/api/orders/latest`, json({ total: 42 }));

    const probe = await createApiProbeStage({
      http,
      fs: nodeFileSystem,
      llm: new FakeLlmClient(),
    }).run(
      { workspace, recipe, environment, impact },
      createTestStageContext({ outDir: path.join(root, 'out') }).ctx,
    );

    expect(probe.captures).toHaveLength(6);
    expect(probe.captures[0]).toMatchObject({
      probeRun: 'baseA',
      error: {
        code: 'PROBE_TIMEOUT',
        message: 'POST /api/echo failed: timed out: no response within 10000 ms',
      },
    });
    expect(probe.captures[0]).not.toHaveProperty('response');
    expect(probe.captures[1]).toMatchObject({ response: { status: 200 } });
    expect(probe.captures[4]).toMatchObject({ probeRun: 'head', error: { code: 'PROBE_FAILED' } });
    expect(probe.captures[4]?.error?.message).not.toContain(HEAD);
  });

  it('stops with ABORTED when the run is aborted', async () => {
    const controller = new AbortController();
    const http = new FakeHttp().onRequest(`POST ${BASE}/api/echo`, json({ ok: true }));
    const request = http.request.bind(http);
    http.request = (exchange) => {
      controller.abort();
      return request(exchange);
    };

    await expect(
      createApiProbeStage({ http, fs: nodeFileSystem, llm: new FakeLlmClient() }).run(
        { workspace, recipe, environment, impact },
        createTestStageContext({ outDir: path.join(root, 'out'), signal: controller.signal }).ctx,
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('appUrl', () => {
  it.each([
    ['/api/x?y=1', `${BASE}/api/x?y=1`],
    ['/', `${BASE}/`],
  ])('resolves %j on the app', (appPath, url) => {
    expect(appUrl(BASE, appPath)).toBe(url);
  });

  it.each(['//evil.example/x', '/\\evil.example/x', 'https://evil.example/x'])(
    'refuses %j, which leaves the app',
    (appPath) => {
      expect(() => appUrl(BASE, appPath)).toThrow(
        expect.objectContaining({ code: 'INVALID_INPUT' }) as Error,
      );
    },
  );
});
