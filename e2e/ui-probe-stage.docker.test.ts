import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createEnvironmentStage,
  createExecaExec,
  createFetchHttpClient,
  createPlaywrightLauncher,
  createRecipeStage,
  createUiProbeStage,
  createWorkspaceStage,
  nodeFileSystem,
  systemClock,
  UiCaptureSchema,
} from '@bdiff/core';
import type { ImpactPlan, ProbeRun, RunningEnvironment, UiCapture } from '@bdiff/core';
import { createTestStageContext } from '@bdiff/core/testing';
import { buildFixtureRepo, loadExpected } from '@bdiff/fixtures';
import type { Expected } from '@bdiff/fixtures';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { composeLeftovers } from './compose-leftovers.js';

const exec = createExecaExec();
const signal = new AbortController().signal;

interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** The smallest box around every pixel that differs between two PNGs, or `undefined` if none. */
async function differingBox(a: string, b: string): Promise<Box | undefined> {
  const [left, right] = await Promise.all(
    [a, b].map(async (file) => PNG.sync.read(await readFile(file))),
  );
  if (left === undefined || right === undefined) {
    throw new Error('missing screenshot');
  }
  if (left.width !== right.width || left.height !== right.height) {
    return {
      x0: 0,
      y0: 0,
      x1: Math.max(left.width, right.width),
      y1: Math.max(left.height, right.height),
    };
  }
  let box: Box | undefined;
  for (let y = 0; y < left.height; y += 1) {
    for (let x = 0; x < left.width; x += 1) {
      const i = (y * left.width + x) * 4;
      if (left.data.readUInt32BE(i) !== right.data.readUInt32BE(i)) {
        box = {
          x0: Math.min(box?.x0 ?? x, x),
          y0: Math.min(box?.y0 ?? y, y),
          x1: Math.max(box?.x1 ?? x, x + 1),
          y1: Math.max(box?.y1 ?? y, y + 1),
        };
      }
    }
  }
  return box;
}

/** The box around the dashboard's server time and visitor number paragraphs. */
async function dashboardNoiseBox(url: string): Promise<Box> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await page.goto(`${url}/dashboard`);
    const boxes = await Promise.all(
      ['Server time', 'Visitor #'].map(async (text) => {
        const box = await page.locator('p', { hasText: text }).boundingBox();
        if (box === null) {
          throw new Error(`no paragraph with "${text}"`);
        }
        return box;
      }),
    );
    return {
      x0: Math.min(...boxes.map((box) => box.x)),
      y0: Math.min(...boxes.map((box) => box.y)),
      x1: Math.max(...boxes.map((box) => box.x + box.width)),
      y1: Math.max(...boxes.map((box) => box.y + box.height)),
    };
  } finally {
    await browser.close();
  }
}

describe('UI probe stage on the fixture (@docker)', () => {
  let root: string;
  let expected: Expected;
  let environment: RunningEnvironment;
  let captures: UiCapture[];
  let project: string;
  let runCleanups: () => Promise<void>;

  const captured = (probeRun: ProbeRun, route: string): UiCapture => {
    const found = captures.find(
      (capture) => capture.probeRun === probeRun && capture.route === route,
    );
    if (found === undefined) {
      throw new Error(`no ${probeRun} capture of ${route}`);
    }
    return found;
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-e2e-ui-'));
    expected = await loadExpected(nodeFileSystem);
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
    }).run({ repoUrl: fixture.path, baseRef: 'main', headRef: 'pr/ui-change' }, test.ctx);
    const recipe = await createRecipeStage({ fs: nodeFileSystem, cacheDir, cwd: root }).run(
      { workspace },
      test.ctx,
    );
    environment = await createEnvironmentStage({
      exec,
      fs: nodeFileSystem,
      http: createFetchHttpClient(),
    }).run({ workspace, recipe }, test.ctx);
    // Every page of the fixture, not only the ones this PR affects.
    const impact: ImpactPlan = {
      pages: expected.pages.map((route) => ({
        path: route,
        kind: 'page',
        file: `app${route === '/' ? '' : route}/page.tsx`,
        dynamic: false,
      })),
      endpoints: [],
      notProbed: [],
      confidence: 'high',
      unmappedFiles: [],
      notes: [],
    };
    captures = await createUiProbeStage({
      browser: createPlaywrightLauncher(),
      fs: nodeFileSystem,
    }).run({ environment, impact }, test.ctx);
  });

  afterAll(async () => {
    try {
      await runCleanups();
      expect(await composeLeftovers(exec, project, signal)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('captures every page on baseA, baseB and head, each loaded, settled and saved', () => {
    expect(captures).toHaveLength(expected.pages.length * 3);
    for (const capture of captures) {
      const label = `${capture.probeRun} ${capture.route} (${String(capture.durationMs)} ms, failed: ${JSON.stringify(capture.failedRequests)})`;
      expect(UiCaptureSchema.parse(capture), label).toMatchObject({
        status: 200,
        settled: true,
        blockedRequests: [],
      });
      expect(capture.error).toBeUndefined();
      expect(capture.screenshot).toBeDefined();
    }
  });

  it('takes pixel-identical baseA and baseB screenshots of every static page', async () => {
    const staticPages = expected.pages.filter((route) => !expected.noisyRoutes.includes(route));

    for (const route of staticPages) {
      const baseA = captured('baseA', route);
      const baseB = captured('baseB', route);
      expect(
        await differingBox(baseA.screenshot ?? '', baseB.screenshot ?? ''),
        route,
      ).toBeUndefined();
      expect(baseB.text, route).toBe(baseA.text);
    }
  });

  it('sees the noisy dashboard differ only in its server time and visitor number', async () => {
    const baseA = captured('baseA', '/dashboard');
    const baseB = captured('baseB', '/dashboard');
    const noise = await dashboardNoiseBox(environment.sides.base.url);

    const diff = await differingBox(baseA.screenshot ?? '', baseB.screenshot ?? '');

    expect(diff).toBeDefined();
    expect(diff?.x0).toBeGreaterThanOrEqual(Math.floor(noise.x0));
    expect(diff?.y0).toBeGreaterThanOrEqual(Math.floor(noise.y0));
    expect(diff?.x1).toBeLessThanOrEqual(Math.ceil(noise.x1));
    expect(diff?.y1).toBeLessThanOrEqual(Math.ceil(noise.y1));
    const stable = (text: string) =>
      text.split('\n').filter((line) => !/^(Server time:|Visitor #)/.test(line));
    expect(stable(baseB.text)).toEqual(stable(baseA.text));
    expect(baseB.text).not.toBe(baseA.text);
  });

  it('captures the console error and failed request of the status page', () => {
    for (const probeRun of ['baseA', 'baseB', 'head'] as const) {
      const status = captured(probeRun, '/status');
      expect(status.consoleErrors).toContain('Could not load the service status: status 404');
      expect(status.failedRequests).toEqual([{ url: '/api/status', method: 'GET', status: 404 }]);
      expect(status.text).toContain('Status unavailable');
    }
  });

  it('sees the login change on head only', () => {
    expect(captured('baseA', '/login').text).not.toContain('Continue with Google');
    expect(captured('head', '/login').text).toContain('Continue with Google');
  });
});
