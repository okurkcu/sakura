import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EXIT_CODES } from '@bdiff/cli';
import type { DatasetEntry, Stats } from '@bdiff/cli';
import { createExecaExec, nodeFileSystem, RunRecordSchema } from '@bdiff/core';
import type { LlmTier, RunRecord } from '@bdiff/core';
import { FakeLlmClient } from '@bdiff/core/testing';
import { BASE_BRANCH, buildFixtureRepo, loadExpected } from '@bdiff/fixtures';
import type { Expected, FixtureRepo, PrBranch } from '@bdiff/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { composeLeftovers } from './compose-leftovers.js';
import { configuredModels, runBdiffCli } from './run-bdiff.js';
import { withScriptedInterpretation } from './scripted-interpretation.js';
import { worktreeLeftovers } from './worktree-leftovers.js';

const exec = createExecaExec();
const signal = new AbortController().signal;

/** The dataset of the fixture: every PR branch, tagged by what it changes. */
const ENTRIES: readonly (Pick<DatasetEntry, 'id'> & {
  branch: PrBranch;
  prType: DatasetEntry['tags']['prType'];
})[] = [
  { id: 'ui-change', branch: 'pr/ui-change', prType: 'ui' },
  { id: 'api-breaking', branch: 'pr/api-breaking', prType: 'api' },
  { id: 'refactor-no-change', branch: 'pr/refactor-no-change', prType: 'refactor' },
  // No behavior change expected, like a refactor.
  { id: 'docs-only', branch: 'pr/docs-only', prType: 'refactor' },
];

describe('bdiff batch and stats over the fixture (@docker)', () => {
  let root: string;
  let fixture: FixtureRepo;
  let expected: Expected;
  let models: Record<LlmTier, string>;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-e2e-batch-'));
    expected = await loadExpected(nodeFileSystem);
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

  it('runs every branch, writes the index, and the stats add up', async () => {
    const dataset = path.join(root, 'dataset.json');
    const entries: DatasetEntry[] = ENTRIES.map(({ id, branch, prType }) => ({
      id,
      repoUrl: fixture.path,
      baseRef: BASE_BRANCH,
      headRef: branch,
      tags: { difficulty: 'easy', prType, author: 'human' },
    }));
    await writeFile(dataset, JSON.stringify({ entries }));
    const outDir = path.join(root, 'out');
    const cli = (argv: string[]) =>
      runBdiffCli(argv, {
        cacheDir: path.join(root, 'cache'),
        cwd: root,
        // A fresh fake LLM per run, scripted with that run's findings.
        stages: (real) => {
          const llm = new FakeLlmClient({ models });
          return withScriptedInterpretation(real(llm), llm);
        },
      });

    const batch = await cli(['batch', dataset, '--out', outDir]);

    expect(batch.exitCode, batch.stdout + batch.stderr).toBe(EXIT_CODES.success);
    expect(batch.stdout).toContain('bdiff batch: 4 recorded, 0 not recorded');
    const records = new Map<string, RunRecord>();
    for (const runId of await nodeFileSystem.readdir(path.join(outDir, 'runs'))) {
      const record = RunRecordSchema.parse(
        JSON.parse(await readFile(path.join(outDir, 'runs', runId, 'run.json'), 'utf8')),
      );
      records.set(record.dataset?.id ?? '', record);
    }
    expect([...records.keys()].sort()).toEqual(ENTRIES.map((e) => e.id).sort());
    for (const { id, branch } of ENTRIES) {
      const record = records.get(id);
      const want = expected.branches[branch];
      expect(record?.status, id).toBe(want.impact.skip === undefined ? 'success' : 'skipped');
      expect(record?.counts.findings, id).toBe(want.findings.length);
      expect(record?.findingSummary.breaking, id).toBe(
        want.findings.filter((finding) => finding.severity === 'breaking').length,
      );
      expect(await composeLeftovers(exec, `bdiff-${record?.runId ?? ''}`, signal)).toEqual([]);
    }
    expect(await worktreeLeftovers(exec, path.join(root, 'cache'), signal)).toEqual([]);
    const index = await readFile(path.join(outDir, 'report', 'batch-index.html'), 'utf8');
    for (const record of records.values()) {
      expect(index).toContain(`../runs/${record.runId}/report/index.html`);
    }

    const stats = await cli(['stats', '--by', 'prType', '--out', outDir]);

    expect(stats.exitCode, stats.stderr).toBe(EXIT_CODES.success);
    expect(stats.stdout).toContain('bdiff stats: 4 runs (3 success, 0 failed, 1 skipped)');
    const computed = JSON.parse(await readFile(path.join(outDir, 'stats.json'), 'utf8')) as Stats;
    expect(computed.overall).toMatchObject({
      runs: 4,
      skipped: 1,
      setup: { attempted: 3, succeeded: 3, rate: 1 },
      findingsPerRun: { count: 3, median: 2, mean: 4 / 3 },
      breakingOrUnexpected: { runs: 1 },
      failureReasons: {},
    });
    expect(Object.keys(computed.groups?.values ?? {})).toEqual(['api', 'refactor', 'ui']);
    expect(computed.criteria.map((c) => [c.id, c.verdict])).toEqual([
      ['setup-success', 'pass'],
      ['median-duration', 'pass'],
      // refactor-no-change has no finding; docs-only was skipped and does not count.
      ['false-differences', 'pass'],
      // The scripted interpretation flags api-breaking's breaking change as unexpected.
      ['hidden-changes', 'pass'],
    ]);
  });
});
