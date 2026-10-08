import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  BdiffError,
  createExecaExec,
  createStubStages,
  createWorkspaceStage,
  nodeFileSystem,
  runPipeline,
  systemClock,
} from '@bdiff/core';
import type { ChangedFile, Exec, Target } from '@bdiff/core';
import {
  createMemoryMetricsStore,
  createTestCostCalculator,
  createTestLogger,
  createTestStageContext,
} from '@bdiff/core/testing';
import { buildFixtureRepo, loadExpected, PR_BRANCHES } from '@bdiff/fixtures';
import type { Expected, FixtureRepo } from '@bdiff/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = createExecaExec();
const signal = new AbortController().signal;

const byPath = (files: readonly ChangedFile[]) =>
  [...files].sort((a, b) => a.path.localeCompare(b.path));

function recordingExec(): Exec & { readonly calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: (cmd, args, options) => {
      calls.push([cmd, ...args]);
      return exec.run(cmd, args, options);
    },
  };
}

async function worktreeCount(cacheDir: string): Promise<number> {
  const [repo] = await nodeFileSystem.readdir(path.join(cacheDir, 'repos'));
  const result = await exec.run('git', ['worktree', 'list', '--porcelain'], {
    cwd: path.join(cacheDir, 'repos', repo ?? ''),
    timeoutMs: 30_000,
    signal,
  });
  return result.stdout.split('\n').filter((line) => line.startsWith('worktree ')).length;
}

describe('workspace stage on the fixture repository', () => {
  let root: string;
  let cacheDir: string;
  let fixture: FixtureRepo;
  let expected: Expected;

  const targetFor = (headRef: string): Target => ({
    repoUrl: fixture.path,
    baseRef: 'main',
    headRef,
  });

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-e2e-ws-'));
    cacheDir = path.join(root, 'cache');
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

  it.each(PR_BRANCHES)('matches the ground truth for %s', async (branch) => {
    const test = createTestStageContext({
      outDir: path.join(root, 'out', branch.replaceAll('/', '-')),
    });
    const stage = createWorkspaceStage({ exec, fs: nodeFileSystem, cacheDir, cwd: root });

    const workspace = await stage.run(targetFor(branch), test.ctx);
    try {
      expect(workspace.baseSha).toBe(fixture.commits.main);
      expect(workspace.headSha).toBe(fixture.commits[branch]);
      expect(byPath(workspace.changedFiles)).toEqual(
        byPath(expected.branches[branch].changedFiles),
      );
      expect(await nodeFileSystem.exists(path.join(workspace.basePath, 'package.json'))).toBe(true);
      expect(await nodeFileSystem.exists(path.join(workspace.headPath, 'package.json'))).toBe(true);
    } finally {
      await test.runCleanups();
    }
  });

  it('detects the refactor as a rename, not a delete plus an add', async () => {
    const test = createTestStageContext({ outDir: path.join(root, 'out', 'rename') });
    const stage = createWorkspaceStage({ exec, fs: nodeFileSystem, cacheDir, cwd: root });

    const workspace = await stage.run(targetFor('pr/refactor-no-change'), test.ctx);
    await test.runCleanups();

    expect(workspace.changedFiles).toContainEqual({
      status: 'renamed',
      path: 'lib/order-repository.ts',
      oldPath: 'lib/orders.ts',
    });
    expect(
      workspace.changedFiles.some((file) => file.status === 'deleted' || file.status === 'added'),
    ).toBe(false);
  });

  it('reuses the cache on a re-run: no clone, only a fetch', async () => {
    const recorded = recordingExec();
    const test = createTestStageContext({ outDir: path.join(root, 'out', 'rerun') });
    const stage = createWorkspaceStage({ exec: recorded, fs: nodeFileSystem, cacheDir, cwd: root });

    await stage.run(targetFor('pr/ui-change'), test.ctx);
    await test.runCleanups();

    const gitSubcommands = recorded.calls.flatMap((call) =>
      call.filter((arg) => arg === 'clone' || arg === 'fetch'),
    );
    expect(gitSubcommands).toEqual(['fetch']);
    expect(test.logger.entries.map((entry) => entry.message)).toContain('repo cache hit');
  });

  it('removes the worktrees after a run that fails in a later stage', async () => {
    const outDir = path.join(root, 'out', 'failing-run');
    const stubs = createStubStages();
    const store = createMemoryMetricsStore();

    const { result } = await runPipeline(
      targetFor('pr/api-breaking'),
      {
        ...stubs,
        workspace: createWorkspaceStage({ exec, fs: nodeFileSystem, cacheDir, cwd: root }),
        environment: {
          name: 'environment',
          run: () => Promise.reject(new BdiffError('SETUP_BUILD_FAILED', 'next build failed')),
        },
      },
      {
        clock: systemClock,
        fs: nodeFileSystem,
        logger: createTestLogger(),
        costs: createTestCostCalculator(),
        outDir,
        toolVersion: 'test',
        timeoutMs: 60_000,
        budgetUsd: 1,
        signal,
        store,
      },
    );

    expect(result.record).toMatchObject({
      status: 'failed',
      failure: { code: 'SETUP_BUILD_FAILED' },
    });
    expect(result.workspace?.changedFiles).toEqual(
      expected.branches['pr/api-breaking'].changedFiles,
    );
    expect(
      await nodeFileSystem.exists(
        path.join(outDir, 'runs', result.record.runId, 'worktrees', 'base'),
      ),
    ).toBe(false);
    expect(
      await nodeFileSystem.exists(
        path.join(outDir, 'runs', result.record.runId, 'worktrees', 'head'),
      ),
    ).toBe(false);
    expect(
      await nodeFileSystem.exists(path.join(outDir, 'runs', result.record.runId, 'worktrees')),
    ).toBe(false);
    expect(await worktreeCount(cacheDir)).toBe(1);
  });
});
