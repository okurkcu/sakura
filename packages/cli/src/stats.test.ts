import { RunRecordSchema } from '@bdiff/core';
import type { RunRecord, StageName } from '@bdiff/core';
import { createTestRunRecorder } from '@bdiff/core/testing';
import { describe, expect, it } from 'vitest';

import { computeStats, distribution, evaluateCriteria, groupStats } from './stats.js';

const base = createTestRunRecorder().recorder.finish({ status: 'success' });
let sequence = 0;

/** A synthetic record: a success unless `status` says otherwise. */
function record(options: {
  status?: 'success' | 'failed' | 'skipped';
  failureCode?: string;
  entry?: { id: string; tags?: Record<string, string> };
  minutes?: number;
  stages?: [StageName, number, 'success' | 'failed'][];
  llmCostUsd?: number;
  computeSeconds?: number;
  rawDiffs?: number;
  noiseDiffs?: number;
  findings?: number;
  breaking?: number;
  unexpected?: number;
  repaired?: boolean;
}): RunRecord {
  sequence += 1;
  const status = options.status ?? 'success';
  const stages = options.stages ?? [
    ['workspace', 1_000, 'success'],
    ['impact', 100, 'success'],
    ...(status === 'skipped'
      ? []
      : ([
          ['recipe', 100, 'success'],
          ['environment', 60_000, status === 'success' ? 'success' : 'failed'],
        ] as [StageName, number, 'success' | 'failed'][])),
  ];
  return RunRecordSchema.parse({
    ...base,
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, sequence)).toISOString(),
    durationMs: (options.minutes ?? 5) * 60_000,
    status,
    ...(status === 'failed'
      ? {
          failure: {
            code: options.failureCode ?? 'SETUP_BUILD_FAILED',
            stage: 'environment',
            message: 'x',
            details: {},
            causes: [],
          },
        }
      : {}),
    ...(status === 'skipped' ? { skip: { reason: 'docs-only' } } : {}),
    stageTimings: stages.map(([stage, durationMs, outcome]) => ({ stage, durationMs, outcome })),
    computeSeconds: {
      base: (options.computeSeconds ?? 0) / 2,
      head: (options.computeSeconds ?? 0) / 2,
    },
    totals: {
      ...base.totals,
      llmCostUsd: options.llmCostUsd ?? 0,
      computeSeconds: options.computeSeconds ?? 0,
    },
    counts: {
      ...base.counts,
      rawDiffs: options.rawDiffs ?? 0,
      noiseDiffs: options.noiseDiffs ?? 0,
      findings: options.findings ?? 0,
    },
    findingSummary: {
      info: 0,
      warning: 0,
      breaking: options.breaking ?? 0,
      unexpected: options.unexpected ?? 0,
    },
    setupAttempts:
      options.repaired === undefined
        ? []
        : [
            {
              attempt: 1,
              trigger: { stage: 'environment', code: 'SETUP_BUILD_FAILED' },
              tier: 'fast',
              patch: null,
              outcome: options.repaired ? 'repaired' : 'no-patch',
              costUsd: 0,
            },
          ],
    dataset:
      options.entry === undefined
        ? null
        : {
            id: options.entry.id,
            tags: options.entry.tags ?? { difficulty: 'easy', prType: 'ui', author: 'human' },
          },
  });
}

describe('distribution', () => {
  it.each([
    { values: [], expected: { count: 0, median: null, p90: null } },
    { values: [7], expected: { count: 1, median: 7, p90: 7 } },
    { values: [3, 1, 2], expected: { count: 3, median: 2, p90: 3 } },
    { values: [4, 1, 3, 2], expected: { count: 4, median: 2.5, p90: 4 } },
    {
      values: [10, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      expected: { count: 10, median: 5.5, p90: 9 },
    },
  ])('$values → median $expected.median, p90 $expected.p90', ({ values, expected }) => {
    expect(distribution(values)).toEqual(expected);
  });
});

describe('groupStats', () => {
  const records = [
    record({
      minutes: 4,
      llmCostUsd: 0.02,
      computeSeconds: 300,
      rawDiffs: 4,
      noiseDiffs: 1,
      findings: 2,
      breaking: 1,
    }),
    record({
      minutes: 6,
      llmCostUsd: 0.04,
      computeSeconds: 500,
      rawDiffs: 6,
      noiseDiffs: 3,
      findings: 0,
      repaired: true,
    }),
    record({ minutes: 8, llmCostUsd: 0, computeSeconds: 100, findings: 1, unexpected: 1 }),
    record({
      status: 'failed',
      minutes: 12,
      failureCode: 'SETUP_BUILD_FAILED',
      computeSeconds: 100,
    }),
    record({ status: 'failed', minutes: 2, failureCode: 'SETUP_BUILD_FAILED', repaired: false }),
    record({
      status: 'failed',
      minutes: 3,
      failureCode: 'GIT_FAILED',
      stages: [['workspace', 1_000, 'failed']],
    }),
    record({ status: 'skipped', minutes: 0.01 }),
  ];

  it('computes the experiment numbers', () => {
    const stats = groupStats(records);

    expect(stats).toMatchObject({
      runs: 7,
      succeeded: 3,
      failed: 3,
      skipped: 1,
      skipRate: 1 / 7,
      // The GIT_FAILED run never got to setup.
      setup: { attempted: 5, succeeded: 3, rate: 3 / 5 },
      repaired: { attempted: 2, succeeded: 1 },
      llmCostUsd: { total: 0.06 },
      computeSeconds: { total: 1_000 },
      noiseRatio: 4 / 10,
      findingsPerRun: { count: 3, median: 1, mean: 1 },
      breakingOrUnexpected: { runs: 2, rate: 2 / 3 },
      failureReasons: { SETUP_BUILD_FAILED: 2, GIT_FAILED: 1 },
    });
    // Skipped runs are left out of durations.
    expect(stats.durationMs).toEqual({ count: 6, median: 5 * 60_000, p90: 12 * 60_000 });
    expect(stats.stageMs.environment).toEqual({ count: 5, median: 60_000, p90: 60_000 });
    expect(Object.keys(stats.failureReasons)).toEqual(['SETUP_BUILD_FAILED', 'GIT_FAILED']);
  });

  it('has no rates for an empty group', () => {
    expect(groupStats([])).toMatchObject({
      runs: 0,
      skipRate: null,
      setup: { rate: null },
      noiseRatio: null,
      durationMs: { median: null },
    });
  });
});

describe('computeStats', () => {
  it('counts only the latest record of a dataset entry, and every single run', () => {
    const records = [
      record({ status: 'failed', entry: { id: 'a' } }),
      record({ entry: { id: 'a' } }),
      record({ entry: { id: 'b' } }),
      record({}),
    ];

    const stats = computeStats(records);

    expect(stats.records).toBe(3);
    expect(stats.overall).toMatchObject({ runs: 3, succeeded: 3, failed: 0 });
  });

  it('groups by a dataset tag', () => {
    const tags = (difficulty: string) => ({ difficulty, prType: 'ui', author: 'human' });
    const stats = computeStats(
      [
        record({ entry: { id: 'a', tags: tags('easy') } }),
        record({ entry: { id: 'b', tags: tags('realistic') }, status: 'failed' }),
        record({ entry: { id: 'c', tags: tags('easy') } }),
        record({}),
      ],
      'difficulty',
    );

    expect(stats.groups?.by).toBe('difficulty');
    expect(Object.keys(stats.groups?.values ?? {})).toEqual(['(none)', 'easy', 'realistic']);
    expect(stats.groups?.values.easy).toMatchObject({ runs: 2, succeeded: 2 });
    expect(stats.groups?.values.realistic).toMatchObject({ runs: 1, failed: 1 });
  });
});

describe('evaluateCriteria', () => {
  const refactor = (id: string, findings: number) =>
    record({
      entry: { id, tags: { difficulty: 'easy', prType: 'refactor', author: 'human' } },
      findings,
    });

  it('passes when every criterion is met', () => {
    const verdicts = evaluateCriteria([
      record({ minutes: 4, unexpected: 1, findings: 1 }),
      record({ minutes: 6 }),
      record({ status: 'failed', minutes: 12 }),
      ...Array.from({ length: 10 }, (_, i) => refactor(`r${String(i)}`, i === 0 ? 1 : 0)),
    ]).map((criterion) => [criterion.id, criterion.verdict, criterion.measured]);

    expect(verdicts).toEqual([
      ['setup-success', 'pass', '92% (12/13)'],
      ['median-duration', 'pass', '5.0 min'],
      ['false-differences', 'pass', '10% (1/10)'],
      ['hidden-changes', 'pass', '1 run(s) with an unexpected finding'],
    ]);
  });

  it('fails each criterion that is missed', () => {
    const verdicts = evaluateCriteria([
      record({ status: 'failed', minutes: 15 }),
      record({ status: 'failed', minutes: 15 }),
      record({ minutes: 15 }),
      refactor('r1', 2),
    ]).map((criterion) => [criterion.id, criterion.verdict]);

    expect(verdicts).toEqual([
      ['setup-success', 'pass'],
      ['median-duration', 'fail'],
      ['false-differences', 'fail'],
      ['hidden-changes', 'fail'],
    ]);
    expect(
      evaluateCriteria([record({ status: 'failed' }), record({ status: 'failed' }), record({})])[0]
        ?.verdict,
    ).toBe('fail');
  });

  it('cannot judge without the runs a criterion needs', () => {
    expect(evaluateCriteria([]).map((criterion) => criterion.verdict)).toEqual([
      'n/a',
      'n/a',
      'n/a',
      'n/a',
    ]);
    expect(evaluateCriteria([record({})])[2]).toMatchObject({
      id: 'false-differences',
      verdict: 'n/a',
      measured: 'no runs',
    });
  });
});
