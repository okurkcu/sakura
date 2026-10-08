import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  API_REQUESTS_PURPOSE,
  ApiProbeSchema,
  createApiProbeStage,
  createEnvironmentStage,
  createExecaExec,
  createFetchHttpClient,
  createRecipeStage,
  createWorkspaceStage,
  nodeFileSystem,
  systemClock,
} from '@bdiff/core';
import type { ApiCapture, ApiProbe, ImpactPlan, ProbeRun } from '@bdiff/core';
import { createTestStageContext, FakeLlmClient } from '@bdiff/core/testing';
import { buildFixtureRepo, loadExpected } from '@bdiff/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { composeLeftovers } from './compose-leftovers.js';

const exec = createExecaExec();
const signal = new AbortController().signal;

describe('API probe stage on the fixture (@docker)', () => {
  let root: string;
  let probe: ApiProbe;
  let llm: FakeLlmClient;
  let project: string;
  let runCleanups: () => Promise<void>;

  const captured = (probeRun: ProbeRun, key: string): ApiCapture => {
    const found = probe.captures.find(
      (capture) => capture.probeRun === probeRun && capture.requestKey === key,
    );
    if (found === undefined) {
      throw new Error(`no ${probeRun} capture of ${key}`);
    }
    return found;
  };

  const json = (capture: ApiCapture): unknown =>
    capture.response?.body.kind === 'json' ? capture.response.body.json : undefined;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-e2e-api-'));
    const expected = await loadExpected(nodeFileSystem);
    const fixture = await buildFixtureRepo({
      targetDir: path.join(root, 'fixture'),
      exec,
      fs: nodeFileSystem,
      signal,
    });
    const cacheDir = path.join(root, 'cache');
    const test = createTestStageContext({ outDir: path.join(root, 'out'), clock: systemClock });
    runCleanups = () => test.runCleanups();
    project = `bdiff-${test.ctx.runId}`;
    const workspace = await createWorkspaceStage({
      exec,
      fs: nodeFileSystem,
      cacheDir,
      cwd: root,
    }).run({ repoUrl: fixture.path, baseRef: 'main', headRef: 'pr/api-breaking' }, test.ctx);
    const recipe = await createRecipeStage({ fs: nodeFileSystem, cacheDir, cwd: root }).run(
      { workspace },
      test.ctx,
    );
    const environment = await createEnvironmentStage({
      exec,
      fs: nodeFileSystem,
      http: createFetchHttpClient(),
    }).run({ workspace, recipe }, test.ctx);
    // Every endpoint of the fixture, not only the one this PR changes.
    const impact: ImpactPlan = {
      pages: [],
      endpoints: expected.endpoints.map((endpoint) => {
        const [method, route] = endpoint.split(' ') as ['GET' | 'POST', string];
        return { path: route, kind: 'api', method, file: `app${route}/route.ts`, dynamic: false };
      }),
      notProbed: [],
      confidence: 'high',
      unmappedFiles: [],
      notes: [],
    };
    llm = new FakeLlmClient().on(API_REQUESTS_PURPOSE, {
      requests: [
        {
          description: 'Five-star feedback with a message',
          query: [],
          body: { contentType: 'application/json', text: '{"message":"Great mugs","rating":5}' },
        },
      ],
    });
    probe = await createApiProbeStage({
      http: createFetchHttpClient(),
      fs: nodeFileSystem,
      llm,
    }).run({ workspace, recipe, environment, impact }, test.ctx);
  });

  afterAll(async () => {
    try {
      await runCleanups();
      expect(await composeLeftovers(exec, project, signal)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('builds the request set from the routes and one generated, labeled request', () => {
    expect(ApiProbeSchema.parse(probe).notProbed).toEqual([]);
    expect(probe.requests.map((request) => [request.key, request.source])).toEqual([
      ['GET /api/health', 'route'],
      ['GET /api/orders/latest', 'route'],
      ['POST /api/feedback', 'generated'],
    ]);
    expect(probe.requests[2]).toMatchObject({
      description: 'Five-star feedback with a message',
      endpoint: 'POST /api/feedback',
    });
    expect(llm.calls[0]?.request.messages[0]?.content).toContain('export async function POST');
    expect(probe.captures).toHaveLength(9);
  });

  it('sees total turn from a number into a string, with a new currency, on head only', () => {
    for (const probeRun of ['baseA', 'baseB'] as const) {
      const base = json(captured(probeRun, 'GET /api/orders/latest'));
      expect(base).toMatchObject({ total: expect.any(Number) as unknown });
      expect(base).not.toHaveProperty('currency');
    }
    const head = json(captured('head', 'GET /api/orders/latest'));
    expect(head).toMatchObject({
      total: expect.any(String) as unknown,
      currency: expect.any(String) as unknown,
    });
    expect(captured('baseB', 'GET /api/orders/latest').response?.body).toEqual(
      captured('baseA', 'GET /api/orders/latest').response?.body,
    );
  });

  it('gets the same answer to the generated request on every probe run', () => {
    for (const probeRun of ['baseA', 'baseB', 'head'] as const) {
      const capture = captured(probeRun, 'POST /api/feedback');
      expect(capture.response).toMatchObject({ status: 201, authRequired: false });
      expect(json(capture)).toEqual({ id: 'feedback-1', message: 'Great mugs', rating: 5 });
    }
  });

  it('writes one artifact per capture', async () => {
    for (const capture of probe.captures) {
      expect(await nodeFileSystem.exists(capture.artifact)).toBe(true);
    }
  });
});
