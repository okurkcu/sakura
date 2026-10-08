import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDiffStage } from './diff-stage.js';
import { nodeFileSystem } from '../adapters/file-system.js';
import { pngCodec } from '../adapters/png.js';
import type { RgbaImage } from '../adapters/png.js';
import type { ApiCapture, ApiProbe, ApiResponse } from '../domain/api-probe.js';
import type { ImpactPlan } from '../domain/impact.js';
import type { JsonObject } from '../domain/json.js';
import type { ProbeRun } from '../domain/stage.js';
import type { UiCapture } from '../domain/ui-capture.js';
import type { RunCounts } from '../metrics/run-record.js';
import { paint, solid } from '../testing/images.js';
import { createTestStageContext } from '../testing/stage-context.js';

const impact: ImpactPlan = {
  pages: [],
  endpoints: [],
  notProbed: [],
  confidence: 'high',
  unmappedFiles: [],
  notes: [],
};
const noApi: ApiProbe = { requests: [], captures: [], notProbed: [] };
const page = solid(120, 80);

describe('createDiffStage', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-diff-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function screenshot(name: string, image: RgbaImage): Promise<string> {
    const file = path.join(root, 'shots', `${name}.png`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, pngCodec.encode(image));
    return file;
  }

  async function pageCaptures(
    route: string,
    shots: Record<ProbeRun, RgbaImage>,
    overrides: Partial<Record<ProbeRun, Partial<UiCapture>>> = {},
  ): Promise<UiCapture[]> {
    const captures: UiCapture[] = [];
    for (const probeRun of ['baseA', 'baseB', 'head'] as const) {
      captures.push({
        probeRun,
        route,
        status: 200,
        title: 'Shop',
        text: 'Log in\nSign in',
        screenshot: await screenshot(`${route.replaceAll('/', '_')}-${probeRun}`, shots[probeRun]),
        consoleErrors: [],
        pageErrors: [],
        failedRequests: [],
        blockedRequests: [],
        settled: true,
        durationMs: 10,
        ...overrides[probeRun],
      });
    }
    return captures;
  }

  const run = async (ui: UiCapture[], api: ApiProbe = noApi) => {
    const counts: Partial<RunCounts>[] = [];
    const test = createTestStageContext({ outDir: path.join(root, 'out') });
    const findings = await createDiffStage({ fs: nodeFileSystem, images: pngCodec }).run(
      { impact, ui, api },
      { ...test.ctx, addCounts: (added: Partial<RunCounts>) => counts.push(added) },
    );
    return { findings, counts, paths: test.ctx.paths };
  };

  it('reports a visual and a text change on a page, with an overlay', async () => {
    const head = paint(page, { x: 10, y: 40, width: 60, height: 20 });
    const ui = await pageCaptures(
      '/login',
      { baseA: page, baseB: page, head },
      {
        head: { text: 'Log in\nSign in\nContinue with Google' },
      },
    );

    const { findings, counts, paths } = await run(ui);

    expect(findings.map((finding) => [finding.kind, finding.severity, finding.location])).toEqual([
      ['text', 'info', { route: '/login' }],
      ['visual', 'info', { route: '/login', bbox: { x: 10, y: 40, width: 60, height: 20 } }],
    ]);
    expect(findings[0]).toMatchObject({ before: [], after: ['Continue with Google'] });
    const overlay = paths.diffOverlay('/login');
    expect(findings[1]?.evidence).toEqual([ui[0]?.screenshot, ui[2]?.screenshot, overlay]);
    expect(pngCodec.decode(await nodeFileSystem.readFileBytes(overlay))).toMatchObject({
      width: 120,
      height: 80,
    });
    expect(counts).toEqual([{ rawDiffs: 2, noiseDiffs: 0, findings: 2 }]);
  });

  it('reports nothing on a page whose only changes are noise', async () => {
    const ui = await pageCaptures(
      '/dashboard',
      {
        baseA: paint(page, { x: 5, y: 5, width: 20, height: 8 }),
        baseB: paint(page, { x: 5, y: 5, width: 26, height: 8 }),
        head: paint(page, { x: 5, y: 5, width: 30, height: 8 }),
      },
      {
        baseA: { text: 'Dashboard\nServer time: 10:00' },
        baseB: { text: 'Dashboard\nServer time: 10:01' },
        head: { text: 'Dashboard\nServer time: 10:02' },
      },
    );

    const { findings, counts } = await run(ui);

    expect(findings).toEqual([]);
    expect(counts).toEqual([{ rawDiffs: 2, noiseDiffs: 2, findings: 0 }]);
  });

  it('reports only the status when a page starts failing', async () => {
    const ui = await pageCaptures(
      '/orders',
      { baseA: page, baseB: page, head: paint(page, { x: 0, y: 0, width: 50, height: 50 }) },
      {
        head: { status: 500, text: 'Internal Server Error', pageErrors: ['Error: boom'] },
      },
    );

    const { findings } = await run(ui);

    expect(
      findings.map((finding) => [finding.kind, finding.severity, finding.before, finding.after]),
    ).toEqual([['status-changed', 'breaking', 200, 500]]);
  });

  it('reports a page that no longer loads, and compares nothing when a base capture failed', async () => {
    const broken = await pageCaptures(
      '/broken',
      { baseA: page, baseB: page, head: page },
      {
        head: { error: { code: 'PROBE_TIMEOUT', message: 'page.goto: Timeout' }, status: null },
      },
    );
    const unknown = await pageCaptures(
      '/unknown',
      { baseA: page, baseB: page, head: paint(page, { x: 0, y: 0, width: 40, height: 40 }) },
      {
        baseB: { error: { code: 'PROBE_FAILED', message: 'net::ERR' } },
      },
    );

    const { findings } = await run([...broken, ...unknown]);

    expect(findings.map((finding) => [finding.kind, finding.severity, finding.location])).toEqual([
      ['failed-request', 'breaking', { route: '/broken' }],
    ]);
  });

  it('reports new runtime errors, rating page errors above console errors', async () => {
    const ui = await pageCaptures(
      '/status',
      { baseA: page, baseB: page, head: page },
      {
        head: { pageErrors: ['TypeError: x is undefined'], consoleErrors: ['Hydration failed'] },
      },
    );

    const { findings } = await run(ui);

    expect(findings.map((finding) => [finding.kind, finding.severity, finding.after])).toEqual([
      ['runtime-error', 'breaking', { source: 'page-error', message: 'TypeError: x is undefined' }],
      ['runtime-error', 'warning', { source: 'console-error', message: 'Hydration failed' }],
    ]);
  });

  it('reports API changes per endpoint and JSON path, deterministically', async () => {
    const answer = (json: JsonObject): ApiResponse => ({
      status: 200,
      contentType: 'application/json',
      headers: {},
      authRequired: false,
      body: { kind: 'json', json, sha256: 'a'.repeat(64) },
    });
    const capture = (probeRun: ProbeRun, response: ApiResponse): ApiCapture => ({
      probeRun,
      requestKey: 'GET /api/orders/latest',
      durationMs: 5,
      artifact: `/out/api/${probeRun}/latest.json`,
      response,
    });
    const api: ApiProbe = {
      requests: [
        {
          key: 'GET /api/orders/latest',
          source: 'route',
          method: 'GET',
          path: '/api/orders/latest',
          headers: {},
          endpoint: 'GET /api/orders/latest',
        },
      ],
      captures: [
        capture('baseA', answer({ total: 42 })),
        capture('baseB', answer({ total: 42 })),
        capture('head', answer({ total: '$42.00', currency: 'USD' })),
      ],
      notProbed: [],
    };

    const first = await run([], api);
    const second = await run([], api);

    expect(
      first.findings.map((finding) => [finding.kind, finding.severity, finding.location]),
    ).toEqual([
      ['type-changed', 'breaking', { endpoint: 'GET /api/orders/latest', jsonPath: '$.total' }],
      ['field-added', 'warning', { endpoint: 'GET /api/orders/latest', jsonPath: '$.currency' }],
    ]);
    expect(first.findings[0]?.evidence).toEqual([
      '/out/api/baseA/latest.json',
      '/out/api/head/latest.json',
    ]);
    expect(second.findings).toEqual(first.findings);
  });
});
