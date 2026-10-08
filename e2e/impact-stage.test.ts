import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createDependencyCruiserGraph,
  createExecaExec,
  createImpactStage,
  createStubStages,
  createWorkspaceStage,
  ImpactPlanSchema,
  nodeFileSystem,
  routeKey,
  runPipeline,
  systemClock,
} from '@bdiff/core';
import type { Stage } from '@bdiff/core';
import {
  createMemoryMetricsStore,
  createTestCostCalculator,
  createTestLogger,
  createTestStageContext,
} from '@bdiff/core/testing';
import { buildFixtureRepo, loadExpected, PR_BRANCHES } from '@bdiff/fixtures';
import type { Expected, FixtureRepo } from '@bdiff/fixtures';
import { createReportStage } from '@bdiff/report';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = createExecaExec();
const signal = new AbortController().signal;
const impact = createImpactStage({ fs: nodeFileSystem, graph: createDependencyCruiserGraph() });

describe('impact stage on the fixture repository', () => {
  let root: string;
  let fixture: FixtureRepo;
  let expected: Expected;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-e2e-impact-'));
    fixture = await buildFixtureRepo({
      targetDir: path.join(root, 'fixture'),
      exec,
      fs: nodeFileSystem,
      signal,
    });
    expected = await loadExpected(nodeFileSystem);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(PR_BRANCHES)('plans exactly the expected routes and endpoints for %s', async (branch) => {
    const slug = branch.replaceAll('/', '-');
    const test = createTestStageContext({ outDir: path.join(root, 'out', slug) });
    try {
      const workspace = await createWorkspaceStage({
        exec,
        fs: nodeFileSystem,
        cacheDir: path.join(root, 'cache', slug),
        cwd: root,
      }).run({ repoUrl: fixture.path, baseRef: 'main', headRef: branch }, test.ctx);
      const plan = ImpactPlanSchema.parse(await impact.run({ workspace }, test.ctx));
      const want = expected.branches[branch].impact;

      expect({
        ...(plan.skip === undefined ? {} : { skip: plan.skip }),
        routes: plan.pages.map((route) => route.path),
        endpoints: plan.endpoints.map(routeKey),
      }).toEqual(want);
      expect(plan).toMatchObject({ notProbed: [], unmappedFiles: [], confidence: 'high' });
    } finally {
      await test.runCleanups();
    }
  });

  it('skips a docs-only run before the recipe or environment stage runs', async () => {
    const ran: string[] = [];
    const tracked = <I, O>(stage: Stage<I, O>): Stage<I, O> => ({
      name: stage.name,
      run: (input, ctx) => {
        ran.push(stage.name);
        return stage.run(input, ctx);
      },
    });
    const stubs = createStubStages();
    const store = createMemoryMetricsStore();

    const { result } = await runPipeline(
      { repoUrl: fixture.path, baseRef: 'main', headRef: 'pr/docs-only' },
      {
        ...stubs,
        workspace: createWorkspaceStage({
          exec,
          fs: nodeFileSystem,
          cacheDir: path.join(root, 'cache', 'pipeline'),
          cwd: root,
        }),
        impact,
        recipe: tracked(stubs.recipe),
        environment: tracked(stubs.environment),
        report: createReportStage({ fs: nodeFileSystem }),
      },
      {
        clock: systemClock,
        fs: nodeFileSystem,
        logger: createTestLogger(),
        costs: createTestCostCalculator(),
        outDir: path.join(root, 'out-pipeline'),
        toolVersion: 'test',
        timeoutMs: 5 * 60_000,
        budgetUsd: 1,
        signal,
        store,
      },
    );

    expect(result.record).toMatchObject({ status: 'skipped', skip: { reason: 'docs-only' } });
    expect(ran).toEqual([]);
    const report = await nodeFileSystem.readFile(
      path.join(root, 'out-pipeline', 'runs', result.record.runId, 'report', 'index.html'),
    );
    expect(report).toContain('<h2>Skipped: docs-only</h2>');
  });
});
