import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildRequestSet } from './request-set.js';
import { REQUESTS_FILE } from './requests-file.js';
import { nodeFileSystem } from '../../adapters/file-system.js';
import type { ImpactPlan, Route } from '../../domain/impact.js';
import type { Workspace } from '../../domain/workspace.js';
import { BdiffError } from '../../errors/bdiff-error.js';
import { API_REQUESTS_PURPOSE } from '../../llm/prompts/api-requests.js';
import { FakeLlmClient } from '../../testing/fake-llm-client.js';
import { createTestStageContext } from '../../testing/stage-context.js';

const SHA = 'a'.repeat(40);

const api = (routePath: string, method: NonNullable<Route['method']>, file: string): Route => ({
  path: routePath,
  kind: 'api',
  method,
  file,
  dynamic: false,
});

const plan = (...endpoints: Route[]): ImpactPlan => ({
  pages: [],
  endpoints,
  notProbed: [],
  confidence: 'high',
  unmappedFiles: [],
  notes: [],
});

const generated = (description: string, extra: object = {}) => ({
  description,
  query: [],
  body: { contentType: 'application/json', text: '{"name":"Mug"}' },
  ...extra,
});

describe('buildRequestSet', () => {
  let root: string;
  let workspace: Workspace;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-request-set-'));
    workspace = {
      basePath: path.join(root, 'base'),
      headPath: path.join(root, 'head'),
      baseSha: SHA,
      headSha: SHA,
      changedFiles: [],
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function files(side: 'base' | 'head', tree: Record<string, string>): Promise<void> {
    for (const [file, content] of Object.entries(tree)) {
      await mkdir(path.dirname(path.join(root, side, file)), { recursive: true });
      await writeFile(path.join(root, side, file), content);
    }
  }

  it('sends explicit requests first, then safe routes, then generated ones, with unique keys', async () => {
    await files('head', {
      [REQUESTS_FILE]: JSON.stringify({
        requests: [
          { method: 'POST', path: '/api/feedback', description: 'Five stars', json: { rating: 5 } },
          {
            method: 'POST',
            path: '/api/search',
            text: 'q=mug',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Tenant': 'demo' },
          },
        ],
      }),
      'app/api/items/route.ts':
        'export async function PUT(request) { return Response.json(await request.json()); }',
    });
    const llm = new FakeLlmClient().on(API_REQUESTS_PURPOSE, {
      requests: [
        generated('Rename an item', { query: [{ name: 'id', value: '7' }] }),
        generated('Empty update', { body: null }),
      ],
    });

    const set = await buildRequestSet(
      {
        impact: plan(
          api('/api/orders', 'GET', 'app/api/orders/route.ts'),
          api('/api/feedback', 'POST', 'app/api/feedback/route.ts'),
          api('/api/items', 'PUT', 'app/api/items/route.ts'),
          api('/api/items', 'HEAD', 'app/api/items/route.ts'),
        ),
        workspace,
        appRoot: '.',
      },
      { fs: nodeFileSystem, llm },
      createTestStageContext().ctx,
    );

    expect(set.notProbed).toEqual([]);
    expect(set.requests).toEqual([
      {
        key: 'POST /api/feedback',
        source: 'explicit',
        method: 'POST',
        path: '/api/feedback',
        headers: {},
        body: { contentType: 'application/json', text: '{"rating":5}' },
        description: 'Five stars',
        endpoint: 'POST /api/feedback',
      },
      {
        key: 'POST /api/search',
        source: 'explicit',
        method: 'POST',
        path: '/api/search',
        headers: { 'x-tenant': 'demo' },
        body: { contentType: 'application/x-www-form-urlencoded', text: 'q=mug' },
        endpoint: 'POST /api/search',
      },
      {
        key: 'GET /api/orders',
        source: 'route',
        method: 'GET',
        path: '/api/orders',
        headers: {},
        endpoint: 'GET /api/orders',
      },
      {
        key: 'HEAD /api/items',
        source: 'route',
        method: 'HEAD',
        path: '/api/items',
        headers: {},
        endpoint: 'HEAD /api/items',
      },
      {
        key: 'PUT /api/items?id=7',
        source: 'generated',
        method: 'PUT',
        path: '/api/items?id=7',
        headers: {},
        body: { contentType: 'application/json', text: '{"name":"Mug"}' },
        description: 'Rename an item',
        endpoint: 'PUT /api/items',
      },
      {
        key: 'PUT /api/items',
        source: 'generated',
        method: 'PUT',
        path: '/api/items',
        headers: {},
        description: 'Empty update',
        endpoint: 'PUT /api/items',
      },
    ]);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.request.messages[0]?.content).toContain('Endpoint: PUT /api/items');
    expect(llm.calls[0]?.request.messages[0]?.content).toContain('export async function PUT');
  });

  it('numbers requests that would share a key', async () => {
    await files('head', { 'app/api/items/route.ts': 'export function POST() {}' });
    const llm = new FakeLlmClient().on(API_REQUESTS_PURPOSE, {
      requests: [generated('First'), generated('Second')],
    });

    const set = await buildRequestSet(
      {
        impact: plan(api('/api/items', 'POST', 'app/api/items/route.ts')),
        workspace,
        appRoot: '.',
      },
      { fs: nodeFileSystem, llm },
      createTestStageContext().ctx,
    );

    expect(set.requests.map((request) => request.key)).toEqual([
      'POST /api/items',
      'POST /api/items #2',
    ]);
  });

  it('adds the methods a Pages Router handler checks for, reading a handler deleted in head from base', async () => {
    await files('base', {
      'pages/api/cart.ts':
        "export default function handler(req, res) { if (req.method === 'DELETE') { res.status(204).end(); } }",
    });
    const llm = new FakeLlmClient().on(API_REQUESTS_PURPOSE, {
      requests: [generated('Empty the cart', { body: null })],
    });

    const set = await buildRequestSet(
      { impact: plan(api('/api/cart', 'GET', 'pages/api/cart.ts')), workspace, appRoot: '.' },
      { fs: nodeFileSystem, llm },
      createTestStageContext().ctx,
    );

    expect(set.requests.map((request) => [request.key, request.source])).toEqual([
      ['GET /api/cart', 'route'],
      ['DELETE /api/cart', 'generated'],
    ]);
    expect(llm.calls[0]?.request.messages[0]?.content).toContain('Pages Router API route');
  });

  it.each(['LLM_UNAVAILABLE', 'BUDGET_EXCEEDED', 'LLM_INVALID_OUTPUT', 'LLM_REFUSED'] as const)(
    'lists the endpoint as not probed when generation fails with %s, and keeps the rest',
    async (code) => {
      await files('head', { 'app/api/items/route.ts': 'export function POST() {}' });
      const llm = new FakeLlmClient().onError(
        API_REQUESTS_PURPOSE,
        new BdiffError(code, 'no luck'),
      );

      const set = await buildRequestSet(
        {
          impact: plan(
            api('/api/health', 'GET', 'app/api/health/route.ts'),
            api('/api/items', 'POST', 'app/api/items/route.ts'),
          ),
          workspace,
          appRoot: '.',
        },
        { fs: nodeFileSystem, llm },
        createTestStageContext().ctx,
      );

      expect(set.requests.map((request) => request.key)).toEqual(['GET /api/health']);
      expect(set.notProbed).toEqual([
        { endpoint: 'POST /api/items', reason: 'generation-failed', detail: `${code}: no luck` },
      ]);
    },
  );

  it('fails on other errors, such as an abort', async () => {
    await files('head', { 'app/api/items/route.ts': 'export function POST() {}' });
    const llm = new FakeLlmClient().onError(
      API_REQUESTS_PURPOSE,
      new BdiffError('ABORTED', 'stop'),
    );

    await expect(
      buildRequestSet(
        {
          impact: plan(api('/api/items', 'POST', 'app/api/items/route.ts')),
          workspace,
          appRoot: '.',
        },
        { fs: nodeFileSystem, llm },
        createTestStageContext().ctx,
      ),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
