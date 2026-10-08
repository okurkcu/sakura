import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createExecaExec,
  createRecipeStage,
  createWorkspaceStage,
  nodeFileSystem,
  RecipeSchema,
} from '@bdiff/core';
import { createTestStageContext } from '@bdiff/core/testing';
import { buildFixtureRepo, PR_BRANCHES } from '@bdiff/fixtures';
import type { FixtureRepo } from '@bdiff/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = createExecaExec();
const signal = new AbortController().signal;

/** What bdiff must detect for the fixture app (see fixtures/sample-next-app). */
const FIXTURE_RECIPE = {
  installRoot: '.',
  appRoot: '.',
  nodeVersion: '22',
  packageManager: { name: 'pnpm', version: '12.9.1' },
  installCmd: ['pnpm', 'install', '--frozen-lockfile'],
  buildCmd: ['pnpm', 'run', 'build'],
  startCmd: ['pnpm', 'exec', 'next', 'start', '-p', '3000', '-H', '0.0.0.0'],
  port: 3000,
  healthPath: '/api/health',
  env: {},
  missingEnv: [],
  services: [],
  dbSetupCmds: [],
  confidence: 'high',
  notes: [],
};

describe('recipe stage on the fixture repository', () => {
  let root: string;
  let fixture: FixtureRepo;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-e2e-recipe-'));
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

  it.each(PR_BRANCHES)('detects the correct recipe for %s', async (branch) => {
    const cacheDir = path.join(root, 'cache', branch.replaceAll('/', '-'));
    const test = createTestStageContext({
      outDir: path.join(root, 'out', branch.replaceAll('/', '-')),
    });
    const target = { repoUrl: fixture.path, baseRef: 'main', headRef: branch };
    try {
      const workspace = await createWorkspaceStage({
        exec,
        fs: nodeFileSystem,
        cacheDir,
        cwd: root,
      }).run(target, test.ctx);
      const recipe = await createRecipeStage({ fs: nodeFileSystem, cacheDir, cwd: root }).run(
        { workspace },
        test.ctx,
      );

      expect(RecipeSchema.parse(recipe)).toEqual(FIXTURE_RECIPE);
    } finally {
      await test.runCleanups();
    }
  });
});
