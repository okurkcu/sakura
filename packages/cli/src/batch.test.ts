import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  abortError,
  BdiffError,
  createMetricsStore,
  nodeFileSystem,
  systemClock,
} from '@bdiff/core';
import type { MetricsStore, PipelineStages, RunRecord } from '@bdiff/core';
import {
  createStubStages,
  createTestCostCalculator,
  createTestLogger,
  createTestRunRecorder,
} from '@bdiff/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeBatch, finishes, planBatch, shardEntries, writeBatchIndex } from './batch.js';
import type { BatchServices } from './batch.js';
import type { DatasetEntry } from './dataset.js';

const entry = (id: string): DatasetEntry => ({
  id,
  repoUrl: 'https://github.com/acme/shop.git',
  baseRef: 'main',
  headRef: `pr/${id}`,
  tags: { difficulty: 'easy', prType: 'ui', author: 'human' },
});
const finished = createTestRunRecorder().recorder.finish({ status: 'success' });
const recordOf = (id: string, toolVersion = 'v1', code?: string): RunRecord =>
  code === undefined
    ? { ...finished, toolVersion, dataset: { id, tags: {} } }
    : {
        ...createTestRunRecorder().recorder.finish({
          status: 'failed',
          error: new BdiffError('ABORTED', 'x'),
        }),
        toolVersion,
        dataset: { id, tags: {} },
      };

describe('finishes / planBatch', () => {
  it('counts a record of the same entry and tool version, unless the run was interrupted', () => {
    expect(finishes(recordOf('a'), 'a', 'v1')).toBe(true);
    expect(finishes(recordOf('a'), 'b', 'v1')).toBe(false);
    expect(finishes(recordOf('a', 'v0'), 'a', 'v1')).toBe(false);
    expect(finishes(recordOf('a', 'v1', 'ABORTED'), 'a', 'v1')).toBe(false);
    expect(finishes({ ...finished, dataset: null }, 'a', 'v1')).toBe(false);
  });

  it('skips done entries on resume, runs everything otherwise', () => {
    const entries = [entry('a'), entry('b'), entry('c')];
    const records = [recordOf('a'), recordOf('b', 'v1', 'ABORTED')];

    const ids = (mode: 'fresh' | 'resume' | 'force') => {
      const plan = planBatch(entries, records, 'v1', mode);
      return [plan.toRun.map((e) => e.id), plan.done.map((e) => e.id)];
    };

    expect(ids('resume')).toEqual([['b', 'c'], ['a']]);
    expect(ids('force')).toEqual([['a', 'b', 'c'], ['a']]);
    expect(ids('fresh')).toEqual([['a', 'b', 'c'], ['a']]);
  });
});

describe('shardEntries', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

  it.each([
    [{ index: 1, count: 1 }, ['a', 'b', 'c', 'd', 'e', 'f', 'g']],
    [{ index: 1, count: 3 }, ['a', 'd', 'g']],
    [{ index: 2, count: 3 }, ['b', 'e']],
    [{ index: 3, count: 3 }, ['c', 'f']],
    [{ index: 4, count: 4 }, ['d']],
    [{ index: 9, count: 9 }, []],
  ])('%j → %j', (shard, expected) => {
    expect(shardEntries(ids, shard)).toEqual(expected);
  });

  it('splits every entry into exactly one shard', () => {
    const shards = [1, 2, 3, 4].map((index) => shardEntries(ids, { index, count: 4 }));
    expect(shards.flat().sort()).toEqual(ids);
  });
});

describe('executeBatch', () => {
  let outDir: string;
  beforeEach(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'bdiff-batch-'));
  });
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  const services = (
    stages: () => PipelineStages,
    overrides: Partial<BatchServices> = {},
  ): BatchServices & { lines: string[] } => {
    const lines: string[] = [];
    return {
      clock: systemClock,
      fs: nodeFileSystem,
      logger: createTestLogger(),
      costs: createTestCostCalculator(),
      toolVersion: 'v1',
      store: createMetricsStore({ fs: nodeFileSystem, rootDir: outDir }),
      createStages: stages,
      signal: new AbortController().signal,
      print: (line) => lines.push(line),
      lines,
      ...overrides,
    };
  };
  const settings = (concurrency = 1) => ({ outDir, concurrency, timeoutMs: 60_000, budgetUsd: 1 });

  it('records every entry with its dataset id, failed runs included', async () => {
    const stubs = createStubStages();
    const s = services(() => ({
      ...stubs,
      recipe: {
        name: 'recipe',
        run: (input, ctx) =>
          ctx.target.headRef === 'pr/b'
            ? Promise.reject(new BdiffError('GIT_FAILED', 'boom'))
            : stubs.recipe.run(input, ctx),
      },
    }));

    const outcome = await executeBatch([entry('a'), entry('b'), entry('c')], settings(), s);

    expect(outcome.unrecorded).toEqual([]);
    expect(outcome.recorded.map((r) => [r.dataset?.id, r.status])).toEqual([
      ['a', 'success'],
      ['b', 'failed'],
      ['c', 'success'],
    ]);
    expect(s.lines).toEqual([
      '[1/3] a: started',
      expect.stringMatching(/^\[1\/3\] a: success, 0 findings/),
      '[2/3] b: started',
      expect.stringMatching(/^\[2\/3\] b: failed at recipe \(GIT_FAILED\)/),
      '[3/3] c: started',
      expect.stringMatching(/^\[3\/3\] c: success/),
    ]);
    const csv = (await readFile(path.join(outDir, 'results.csv'), 'utf8')).trimEnd().split('\n');
    expect(csv).toHaveLength(4);
  });

  it('goes on when an entry cannot even be recorded', async () => {
    const real = createMetricsStore({ fs: nodeFileSystem, rootDir: outDir });
    const store: MetricsStore = {
      writeRunRecord: (record) =>
        record.dataset?.id === 'b'
          ? Promise.reject(new Error('disk full'))
          : real.writeRunRecord(record),
      appendResult: (record) => real.appendResult(record),
    };
    const s = services(() => createStubStages(), { store });

    const outcome = await executeBatch([entry('a'), entry('b'), entry('c')], settings(), s);

    expect(outcome.unrecorded).toEqual(['b']);
    expect(outcome.recorded.map((r) => r.dataset?.id)).toEqual(['a', 'c']);
    expect(s.lines).toContain('[2/3] b: could not be recorded: disk full');
  });

  it('runs entries concurrently up to the limit', async () => {
    let running = 0;
    let most = 0;
    const stubs = createStubStages();
    const s = services(() => ({
      ...stubs,
      environment: {
        name: 'environment',
        run: async (input, ctx) => {
          running += 1;
          most = Math.max(most, running);
          await new Promise((resolve) => setTimeout(resolve, 30));
          running -= 1;
          return stubs.environment.run(input, ctx);
        },
      },
    }));

    await executeBatch([entry('a'), entry('b'), entry('c'), entry('d')], settings(2), s);

    expect(most).toBe(2);
  });

  it('starts no entry after an interrupt; the run in progress is recorded as ABORTED', async () => {
    const controller = new AbortController();
    const stubs = createStubStages();
    const s = services(
      () => ({
        ...stubs,
        environment: {
          name: 'environment',
          run: (input, ctx) =>
            ctx.target.headRef === 'pr/b'
              ? new Promise((_resolve, reject) => {
                  ctx.signal.addEventListener('abort', () => {
                    reject(abortError(ctx.signal));
                  });
                  controller.abort(new BdiffError('ABORTED', 'Interrupted by SIGINT'));
                })
              : stubs.environment.run(input, ctx),
        },
      }),
      { signal: controller.signal },
    );

    const outcome = await executeBatch([entry('a'), entry('b'), entry('c')], settings(), s);

    expect(
      outcome.recorded.map((r) => [r.dataset?.id, r.status === 'failed' && r.failure.code]),
    ).toEqual([
      ['a', false],
      ['b', 'ABORTED'],
    ]);
  });
});

describe('writeBatchIndex', () => {
  it('lists the latest record of each entry in dataset order, linking existing reports', async () => {
    const outDir = await mkdtemp(path.join(tmpdir(), 'bdiff-index-'));
    try {
      const older = { ...recordOf('b'), startedAt: '2026-01-01T00:00:00.000Z' };
      const newer = {
        ...recordOf('b'),
        runId: '01k6t3y8k0g3m5x9a2b7c4d6eg',
        startedAt: '2026-01-02T00:00:00.000Z',
      };
      const a = { ...recordOf('a'), runId: '01k6t3y8k0g3m5x9a2b7c4d6eh' };
      await nodeFileSystem.mkdir(path.join(outDir, 'runs', a.runId, 'report'));
      await nodeFileSystem.writeFile(
        path.join(outDir, 'runs', a.runId, 'report', 'index.html'),
        '',
      );
      const file = path.join(outDir, 'report', 'batch-index.html');

      const rows = await writeBatchIndex(
        nodeFileSystem,
        file,
        outDir,
        [entry('a'), entry('b'), entry('c')],
        [older, newer, a],
      );

      expect(rows.map((row) => [row.record.runId, row.reportHref])).toEqual([
        [a.runId, `../runs/${a.runId}/report/index.html`],
        [newer.runId, undefined],
      ]);
      expect(await readFile(file, 'utf8')).toContain(a.runId);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
