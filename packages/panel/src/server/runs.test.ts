import type { RunEvent } from '@bdiff/core';
import { TEST_TARGET } from '@bdiff/core/testing';
import { describe, expect, it } from 'vitest';

import { resolveRunFile } from './artifacts.js';
import { buildMetrics, newestFirst, stageInProgress, summarizeRun } from './runs.js';
import { testRecord } from '../testing/helpers.js';

const RUN = '01k6t3y8k0g3m5x9a2b7c4d6ef';
const START = '2026-01-01T00:00:00.000Z';
const at = (seconds: number) => new Date(Date.parse(START) + seconds * 1000).toISOString();
const startedEvent: RunEvent = {
  type: 'run-started',
  at: START,
  runId: RUN,
  target: TEST_TARGET,
  toolVersion: 'v',
  llmMode: 'fake',
  pid: 7,
};

describe('summarizeRun', () => {
  const now = new Date(Date.parse(START) + 90_000);

  it('summarizes a finished run from its record', () => {
    const record = testRecord(RUN);

    expect(summarizeRun({ runId: RUN, record, events: [] }, now, () => false)).toMatchObject({
      runId: RUN,
      state: 'success',
      llmMode: 'on',
      note: '0 findings',
    });
  });

  it('shows a run in progress from its events, with the stage running now', () => {
    const events: RunEvent[] = [
      startedEvent,
      { type: 'stage-started', at: at(1), stage: 'workspace' },
      {
        type: 'stage-finished',
        at: at(2),
        stage: 'workspace',
        durationMs: 1000,
        status: 'success',
      },
      { type: 'stage-started', at: at(3), stage: 'environment' },
    ];

    expect(summarizeRun({ runId: RUN, events }, now, () => true)).toMatchObject({
      state: 'running',
      llmMode: 'fake',
      durationMs: 90_000,
      currentStage: 'environment',
      note: 'running environment',
    });
  });

  it('shows a run whose process is gone, without run-finished, as interrupted', () => {
    const events: RunEvent[] = [
      startedEvent,
      { type: 'stage-started', at: at(5), stage: 'probe-ui' },
    ];

    expect(summarizeRun({ runId: RUN, events }, now, () => false)).toMatchObject({
      state: 'interrupted',
      durationMs: 5000,
      note: 'stopped during probe-ui: its process is gone',
    });
  });

  it('keeps a run that reported run-finished as running until its record is written', () => {
    const events: RunEvent[] = [
      startedEvent,
      { type: 'run-finished', at: at(9), status: 'success', durationMs: 9000 },
    ];

    expect(summarizeRun({ runId: RUN, events }, now, () => false)).toMatchObject({
      state: 'running',
      note: 'finishing',
    });
  });

  it('ignores a directory with neither record nor events', () => {
    expect(summarizeRun({ runId: RUN, events: [] }, now, () => true)).toBeUndefined();
  });
});

describe('stageInProgress', () => {
  it('is the stage started last and not ended', () => {
    expect(
      stageInProgress([
        { type: 'stage-started', at: at(1), stage: 'recipe' },
        {
          type: 'stage-failed',
          at: at(2),
          stage: 'recipe',
          durationMs: 1,
          code: 'SETUP_UNSUPPORTED',
        },
      ]),
    ).toBeUndefined();
    expect(stageInProgress([{ type: 'stage-started', at: at(1), stage: 'repair' }])).toBe('repair');
  });
});

describe('newestFirst', () => {
  it('sorts by start time, newest first', () => {
    const a = summarizeRun(
      { runId: RUN, record: { ...testRecord(RUN), startedAt: at(1) }, events: [] },
      new Date(),
      () => false,
    );
    const b = summarizeRun(
      { runId: RUN, record: { ...testRecord(RUN), startedAt: at(2) }, events: [] },
      new Date(),
      () => false,
    );

    expect(
      newestFirst([a, b].flatMap((run) => (run === undefined ? [] : [run]))).map(
        (run) => run.startedAt,
      ),
    ).toEqual([at(2), at(1)]);
  });
});

describe('buildMetrics', () => {
  it('rates setup and run time against the targets, and sums noise over the records', () => {
    const record = testRecord(RUN);
    const metrics = buildMetrics(
      {
        setup: { attempted: 4, succeeded: 1, rate: 0.25 },
        durationMs: { count: 3, median: 4 * 60_000 },
        llmCostUsd: { count: 3, median: 0.0123 },
        targets: { setupRate: 0.5, medianDurationMs: 10 * 60_000 },
      },
      [{ ...record, counts: { ...record.counts, rawDiffs: 10, noiseDiffs: 9 } }],
    );

    expect(metrics.map((metric) => [metric.id, metric.value, metric.verdict])).toEqual([
      ['setup-success', '25%', 'off-track'],
      ['median-duration', '4.0 min', 'on-track'],
      ['noise-filtered', '90%', 'info'],
      ['cost-per-pr', '$0.0123', 'info'],
    ]);
  });

  it('says what is not measured yet', () => {
    const metrics = buildMetrics(
      {
        setup: { attempted: 0, succeeded: 0, rate: null },
        durationMs: { count: 0, median: null },
        llmCostUsd: { count: 0, median: null },
        targets: { setupRate: 0.5, medianDurationMs: 600_000 },
      },
      [],
    );

    expect(
      metrics.every((metric) => metric.verdict === 'not-measured' && metric.value === '—'),
    ).toBe(true);
  });
});

describe('resolveRunFile', () => {
  it.each([
    ['run.json', '/ws/runs/r1/run.json'],
    ['ui/head/a.png', '/ws/runs/r1/ui/head/a.png'],
    ['.', '/ws/runs/r1'],
    ['./logs/base.log', '/ws/runs/r1/logs/base.log'],
  ])('resolves %s', (relative, resolved) => {
    expect(resolveRunFile('/ws/runs', 'r1', relative)).toBe(resolved);
  });

  it.each([
    '',
    '..',
    '../r2/run.json',
    'logs/../../r2/run.json',
    '/etc/passwd',
    'C:/x',
    'a\\b',
    'a\0b',
  ])('refuses %j', (relative) => {
    expect(resolveRunFile('/ws/runs', 'r1', relative)).toBeUndefined();
  });
});
