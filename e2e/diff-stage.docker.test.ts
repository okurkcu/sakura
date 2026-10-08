import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createApiProbeStage,
  createDependencyCruiserGraph,
  createDiffStage,
  createEnvironmentStage,
  createExecaExec,
  createFetchHttpClient,
  createImpactStage,
  createPlaywrightLauncher,
  createRecipeStage,
  createUiProbeStage,
  createWorkspaceStage,
  FindingSchema,
  nodeFileSystem,
  pngCodec,
  systemClock,
} from '@bdiff/core';
import { createTestStageContext, FakeLlmClient } from '@bdiff/core/testing';
import { buildFixtureRepo, loadExpected } from '@bdiff/fixtures';
import type { Expected, ExpectedFinding, FixtureRepo, PrBranch } from '@bdiff/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { composeLeftovers } from './compose-leftovers.js';

const exec = createExecaExec();
const http = createFetchHttpClient();
const signal = new AbortController().signal;

/** Kind and place of a finding, as `expected.json` describes it (no bounding box), as a key. */
function placeKey(finding: Pick<ExpectedFinding, 'kind' | 'location'>): string {
  const { route, endpoint, jsonPath } = finding.location;
  return JSON.stringify([finding.kind, route ?? null, endpoint ?? null, jsonPath ?? null]);
}

describe('diff stage on the fixture (@docker)', () => {
  let root: string;
  let fixture: FixtureRepo;
  let expected: Expected;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-e2e-diff-'));
    expected = await loadExpected(nodeFileSystem);
    fixture = await buildFixtureRepo({
      targetDir: path.join(root, 'fixture'),
      exec,
      fs: nodeFileSystem,
      signal,
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each<PrBranch>(['pr/ui-change', 'pr/api-breaking', 'pr/refactor-no-change'])(
    'finds exactly the expected findings on %s, with stable ids',
    async (branch) => {
      const slug = branch.replaceAll('/', '-');
      const cacheDir = path.join(root, 'cache');
      const test = createTestStageContext({
        outDir: path.join(root, 'out', slug),
        clock: systemClock,
      });
      const project = `bdiff-${test.ctx.runId}`;
      try {
        const workspace = await createWorkspaceStage({
          exec,
          fs: nodeFileSystem,
          cacheDir,
          cwd: root,
        }).run({ repoUrl: fixture.path, baseRef: 'main', headRef: branch }, test.ctx);
        const impact = await createImpactStage({
          fs: nodeFileSystem,
          graph: createDependencyCruiserGraph(),
        }).run({ workspace }, test.ctx);
        const recipe = await createRecipeStage({ fs: nodeFileSystem, cacheDir, cwd: root }).run(
          { workspace },
          test.ctx,
        );
        const environment = await createEnvironmentStage({ exec, fs: nodeFileSystem, http }).run(
          { workspace, recipe },
          test.ctx,
        );
        const ui = await createUiProbeStage({
          browser: createPlaywrightLauncher(),
          fs: nodeFileSystem,
        }).run({ environment, impact }, test.ctx);
        // Every endpoint these branches affect is a GET: nothing to generate.
        const api = await createApiProbeStage({
          http,
          fs: nodeFileSystem,
          llm: new FakeLlmClient(),
        }).run({ workspace, recipe, environment, impact }, test.ctx);
        const diff = createDiffStage({ fs: nodeFileSystem, images: pngCodec });

        const findings = await diff.run({ impact, ui, api }, test.ctx);
        const again = await diff.run({ impact, ui, api }, test.ctx);

        const want = expected.branches[branch].findings;
        expect(findings.map(placeKey).sort(), JSON.stringify(findings, null, 2)).toEqual(
          want.map(placeKey).sort(),
        );
        for (const wanted of want) {
          if (wanted.severity !== undefined) {
            const found = findings.find((finding) => placeKey(finding) === placeKey(wanted));
            expect(found?.severity, placeKey(wanted)).toBe(wanted.severity);
          }
        }
        for (const finding of findings) {
          expect(FindingSchema.parse(finding).evidence.length).toBeGreaterThan(0);
          expect(expected.noisyRoutes).not.toContain(finding.location.route);
        }
        expect(again).toEqual(findings);
      } finally {
        await test.runCleanups();
      }
      expect(await composeLeftovers(exec, project, signal)).toEqual([]);
    },
  );
});
