import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EXIT_CODES } from '@bdiff/cli';
import {
  BdiffError,
  createArtifactPaths,
  createExecaExec,
  nodeFileSystem,
  RECIPE_REPAIR_PURPOSE,
  RecipeCacheEntrySchema,
  RunRecordSchema,
} from '@bdiff/core';
import type { LlmTier, RecipePatch, RunRecord } from '@bdiff/core';
import { FakeLlmClient } from '@bdiff/core/testing';
import { buildFixtureRepo } from '@bdiff/fixtures';
import type { FixtureRepo } from '@bdiff/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { composeLeftovers } from './compose-leftovers.js';
import { configuredModels, runBdiff } from './run-bdiff.js';
import { worktreeLeftovers } from './worktree-leftovers.js';

const exec = createExecaExec();
const signal = new AbortController().signal;

/** What the README of `variant/needs-repair` asks for: a session secret and its own server. */
const FIX: RecipePatch = {
  reason: 'The build needs SESSION_SECRET (README "Setup"); the shop runs on its own server.',
  env: [{ name: 'SESSION_SECRET', value: 'bdiff-placeholder-session-secret' }],
  nodeVersion: null,
  packageManager: null,
  installCmd: null,
  buildCmd: null,
  startCmd: ['pnpm', 'run', 'start'],
  dbSetupCmds: null,
  appRoot: null,
  port: null,
  healthPath: null,
};

describe('setup repair on the fixture (@docker)', () => {
  let root: string;
  let fixture: FixtureRepo;
  let models: Record<LlmTier, string>;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-e2e-repair-'));
    models = await configuredModels();
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

  const bdiff = (name: string, cacheDir: string, llm: FakeLlmClient) =>
    runBdiff({
      repo: fixture.path,
      base: 'variant/needs-repair',
      head: 'variant/needs-repair-change',
      outDir: path.join(root, 'out', name),
      cacheDir,
      cwd: root,
      llm,
    });
  const readRecord = async (name: string): Promise<RunRecord> => {
    const outDir = path.join(root, 'out', name);
    const [runId = ''] = await nodeFileSystem.readdir(path.join(outDir, 'runs'));
    return RunRecordSchema.parse(
      JSON.parse(await readFile(createArtifactPaths(outDir, runId).runJson, 'utf8')),
    );
  };
  const expectNothingLeft = async (record: RunRecord, cacheDir: string) => {
    expect(await composeLeftovers(exec, `bdiff-${record.runId}`, signal)).toEqual([]);
    expect(await worktreeLeftovers(exec, cacheDir, signal)).toEqual([]);
  };

  it('repairs the setup after a rejected patch, then reuses the repaired recipe', async () => {
    const cacheDir = path.join(root, 'cache-repaired');
    const llm = new FakeLlmClient({ models }).on(
      RECIPE_REPAIR_PURPOSE,
      { ...FIX, startCmd: ['sh', '-c', 'node server.mjs'] },
      FIX,
    );

    const run = await bdiff('repaired', cacheDir, llm);

    expect(run.exitCode, run.stdout + run.stderr).toBe(EXIT_CODES.success);
    expect(run.stdout).toContain('bdiff: success, 0 findings\n');
    const record = await readRecord('repaired');
    expect(record.setupAttempts).toMatchObject([
      {
        attempt: 1,
        trigger: { stage: 'environment', code: 'SETUP_BUILD_FAILED' },
        tier: 'fast',
        outcome: 'rejected',
      },
      { attempt: 2, tier: 'fast', patch: FIX, outcome: 'repaired' },
    ]);
    expect(record.setupAttempts[0]?.problem).toMatch(/"sh -c node server\.mjs": only pnpm/);
    expect(record.setupAttempts.every((attempt) => attempt.costUsd > 0)).toBe(true);
    expect(llm.calls.map((call) => call.purpose)).toEqual([
      RECIPE_REPAIR_PURPOSE,
      RECIPE_REPAIR_PURPOSE,
    ]);
    expect(record.stageTimings.map((timing) => [timing.stage, timing.outcome])).toEqual(
      expect.arrayContaining([
        ['environment', 'failed'],
        ['environment', 'success'],
      ]),
    );
    expect(record.computeSeconds.head).toBeGreaterThan(0);
    const paths = createArtifactPaths(path.join(root, 'out', 'repaired'), record.runId);
    // The first attempt's logs are kept; the side that failed first says why.
    const firstLogs = await Promise.all(
      (['base', 'head'] as const).map((side) => readFile(paths.log(`${side}-attempt-1`), 'utf8')),
    );
    expect(firstLogs.join('\n')).toContain('SESSION_SECRET is not set');
    const [cacheFile = ''] = await nodeFileSystem.readdir(path.join(cacheDir, 'recipes'));
    const cached = RecipeCacheEntrySchema.parse(
      JSON.parse(await readFile(path.join(cacheDir, 'recipes', cacheFile), 'utf8')),
    );
    expect(cached).toMatchObject({
      source: 'llm',
      recipe: {
        startCmd: ['pnpm', 'run', 'start'],
        env: { SESSION_SECRET: { source: 'llm' } },
      },
    });
    await expectNothingLeft(record, cacheDir);

    // A later run of the same repository starts from the cached recipe: no repair, no LLM call.
    const again = new FakeLlmClient({ models });
    const second = await bdiff('cached', cacheDir, again);

    expect(second.exitCode, second.stdout + second.stderr).toBe(EXIT_CODES.success);
    expect(again.calls).toEqual([]);
    const secondRecord = await readRecord('cached');
    expect(secondRecord.setupAttempts).toEqual([]);
    await expectNothingLeft(secondRecord, cacheDir);
  });

  it('fails with the setup failure itself when no LLM is available', async () => {
    const cacheDir = path.join(root, 'cache-no-llm');
    const llm = new FakeLlmClient({ models }).onError(
      RECIPE_REPAIR_PURPOSE,
      new BdiffError('LLM_UNAVAILABLE', 'No Claude API credentials'),
    );

    const run = await bdiff('no-llm', cacheDir, llm);

    expect(run.exitCode, run.stdout + run.stderr).toBe(EXIT_CODES.failed);
    expect(run.stdout).toMatch(/^bdiff: failed at environment \(SETUP_BUILD_FAILED\)/);
    const record = await readRecord('no-llm');
    expect(record).toMatchObject({
      status: 'failed',
      failure: { code: 'SETUP_BUILD_FAILED', stage: 'environment' },
      setupAttempts: [{ attempt: 1, outcome: 'no-patch', errorCode: 'LLM_UNAVAILABLE' }],
    });
    expect(await nodeFileSystem.exists(path.join(cacheDir, 'recipes'))).toBe(true);
    const [cacheFile = ''] = await nodeFileSystem.readdir(path.join(cacheDir, 'recipes'));
    expect(
      RecipeCacheEntrySchema.parse(
        JSON.parse(await readFile(path.join(cacheDir, 'recipes', cacheFile), 'utf8')),
      ).source,
    ).toBe('detected');
    await expectNothingLeft(record, cacheDir);
  });
});
