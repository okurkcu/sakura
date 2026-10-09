import type { RunEvent } from '@bdiff/core';
import { describe, expect, it } from 'vitest';

import { parseRoute, routeHref } from './data.js';
import { ago, clock, refs, repoName, shortDuration, usd } from './format.js';
import { lineDiff, prettyJson } from './json-diff.js';
import { captureProgress, logTail, pipelineStrip } from './pipeline.js';
import { buildTimeline, ticksFor } from './timeline.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

describe('format', () => {
  it.each([
    [0, '0:00'],
    [61_000, '1:01'],
    [3_725_000, '1:02:05'],
  ])('clock(%d) = %s', (ms, text) => {
    expect(clock(ms)).toBe(text);
  });

  it.each([
    [850, '850 ms'],
    [4_200, '4.2 s'],
    [125_000, '2:05'],
  ])('shortDuration(%d) = %s', (ms, text) => {
    expect(shortDuration(ms)).toBe(text);
  });

  it('formats money, ages, refs and repository names', () => {
    expect([usd(0), usd(0.01234)]).toEqual(['$0', '$0.0123']);
    expect([
      ago(at(0), T0 + 10_000),
      ago(at(0), T0 + 12 * 60_000),
      ago(at(0), T0 + 3 * 3_600_000),
    ]).toEqual(['just now', '12 min ago', '3 h ago']);
    expect(refs({ baseRef: 'a'.repeat(40), headRef: 'pr/x' })).toBe('aaaaaaa → pr/x');
    expect([
      repoName('https://github.com/vercel/commerce.git'),
      repoName('/tmp/bdiff-fixture-repo-x/'),
    ]).toEqual(['commerce', 'bdiff-fixture-repo-x']);
  });
});

describe('pipelineStrip', () => {
  const events: RunEvent[] = [
    { type: 'stage-started', at: at(0), stage: 'workspace' },
    {
      type: 'stage-finished',
      at: at(1_000),
      stage: 'workspace',
      durationMs: 1_000,
      status: 'success',
    },
    { type: 'stage-started', at: at(1_000), stage: 'impact' },
    { type: 'stage-finished', at: at(1_500), stage: 'impact', durationMs: 500, status: 'success' },
    { type: 'stage-started', at: at(1_500), stage: 'recipe' },
    { type: 'stage-finished', at: at(1_600), stage: 'recipe', durationMs: 100, status: 'success' },
    { type: 'stage-started', at: at(1_600), stage: 'environment' },
    {
      type: 'stage-finished',
      at: at(9_000),
      stage: 'environment',
      durationMs: 7_400,
      status: 'success',
    },
    { type: 'stage-started', at: at(9_000), stage: 'probe-ui' },
  ];

  it('marks done, current, pending and stages the run went past without needing', () => {
    const strip = pipelineStrip(events, undefined, false, T0 + 10_000);

    expect(strip.map((cell) => [cell.stage, cell.state, cell.durationMs])).toEqual([
      ['workspace', 'done', 1_000],
      ['impact', 'done', 500],
      ['recipe', 'done', 100],
      ['environment', 'done', 7_400],
      ['repair', 'unused', undefined],
      ['probe-ui', 'current', 1_000],
      ['probe-api', 'pending', undefined],
      ['diff', 'pending', undefined],
      ['interpret', 'pending', undefined],
      ['report', 'pending', undefined],
    ]);
  });

  it('shows skipped and failed stages, and nothing pending once the run ended', () => {
    const strip = pipelineStrip(
      [
        ...events,
        {
          type: 'stage-failed',
          at: at(9_500),
          stage: 'probe-ui',
          durationMs: 500,
          code: 'BROWSER_UNAVAILABLE',
        },
        {
          type: 'stage-finished',
          at: at(9_500),
          stage: 'interpret',
          durationMs: 0,
          status: 'skipped',
        },
      ],
      undefined,
      true,
      T0 + 10_000,
    );

    expect(strip.find((cell) => cell.stage === 'probe-ui')?.state).toBe('failed');
    expect(strip.find((cell) => cell.stage === 'interpret')?.state).toBe('skipped');
    expect(strip.find((cell) => cell.stage === 'report')?.state).toBe('unused');
  });

  it('falls back to the stage timings of a record without events', () => {
    const strip = pipelineStrip(
      [],
      [
        { stage: 'workspace', durationMs: 5, outcome: 'success' },
        { stage: 'environment', durationMs: 10, outcome: 'failed' },
        { stage: 'environment', durationMs: 20, outcome: 'success' },
      ],
      true,
      T0,
    );

    expect(strip.find((cell) => cell.stage === 'environment')).toEqual({
      stage: 'environment',
      state: 'done',
      durationMs: 30,
    });
  });
});

describe('captureProgress / logTail', () => {
  it('counts captures per probe run and keeps the last log lines', () => {
    const events: RunEvent[] = [
      { type: 'capture', at: at(0), probeRun: 'baseA', route: '/', status: 'ok', ms: 5, total: 2 },
      {
        type: 'capture',
        at: at(1),
        probeRun: 'baseA',
        route: '/x',
        status: 'error',
        ms: 5,
        total: 2,
      },
      { type: 'capture', at: at(2), probeRun: 'baseB', route: '/', status: 'ok', ms: 5, total: 2 },
      { type: 'log', at: at(3), level: 'info', message: 'one' },
      { type: 'log', at: at(4), level: 'warn', message: 'two' },
    ];

    expect(captureProgress(events)).toEqual([
      { probeRun: 'baseA', done: 2, total: 2, failed: 1 },
      { probeRun: 'baseB', done: 1, total: 2, failed: 0 },
      { probeRun: 'head', done: 0, total: 2, failed: 0 },
    ]);
    expect(captureProgress([])).toEqual([]);
    expect(logTail(events, 1).map((line) => line.message)).toEqual(['two']);
  });
});

describe('buildTimeline', () => {
  it('places bars by their real start and end, with the environment sides as two lanes', () => {
    const timeline = buildTimeline(
      [
        {
          type: 'run-started',
          at: at(0),
          runId: '01k6t3y8k0g3m5x9a2b7c4d6ef',
          target: { repoUrl: 'r', baseRef: 'a', headRef: 'b' },
          toolVersion: 'v',
          llmMode: 'off',
          pid: 1,
        },
        { type: 'stage-started', at: at(0), stage: 'workspace' },
        {
          type: 'stage-finished',
          at: at(1_000),
          stage: 'workspace',
          durationMs: 1_000,
          status: 'success',
        },
        { type: 'stage-started', at: at(1_000), stage: 'environment' },
        { type: 'environment-side', at: at(2_000), side: 'base', status: 'started' },
        { type: 'environment-side', at: at(2_000), side: 'head', status: 'started' },
        { type: 'environment-side', at: at(6_000), side: 'head', status: 'ready' },
        { type: 'environment-side', at: at(8_000), side: 'base', status: 'ready' },
        {
          type: 'stage-finished',
          at: at(8_000),
          stage: 'environment',
          durationMs: 7_000,
          status: 'success',
        },
        {
          type: 'stage-finished',
          at: at(8_000),
          stage: 'interpret',
          durationMs: 0,
          status: 'skipped',
        },
        { type: 'stage-started', at: at(8_000), stage: 'probe-ui' },
      ],
      T0 + 10_000,
    );

    expect(timeline.spanMs).toBe(10_000);
    expect(
      timeline.lanes.map((lane) => [
        lane.name,
        lane.bars.map((bar) => [bar.start, bar.end, bar.state]),
      ]),
    ).toEqual([
      ['workspace', [[0, 1_000, 'done']]],
      ['environment', [[1_000, 8_000, 'done']]],
      ['environment · base', [[2_000, 8_000, 'done']]],
      ['environment · head', [[2_000, 6_000, 'done']]],
      ['interpret', [[8_000, 8_000, 'skipped']]],
      ['probe-ui', [[8_000, 10_000, 'running']]],
    ]);
  });

  it('ends at the record’s finish time when the events stop before run-finished', () => {
    const timeline = buildTimeline(
      [
        { type: 'stage-started', at: at(0), stage: 'workspace' },
        {
          type: 'stage-finished',
          at: at(1_000),
          stage: 'workspace',
          durationMs: 1_000,
          status: 'success',
        },
        { type: 'stage-started', at: at(1_000), stage: 'report' },
      ],
      T0 + 600_000,
      T0 + 2_000,
    );

    expect(timeline.spanMs).toBe(2_000);
    expect(timeline.lanes.at(-1)?.bars).toEqual([{ start: 1_000, end: 2_000, state: 'failed' }]);
  });

  it('is empty without events', () => {
    expect(buildTimeline([], T0)).toEqual({ lanes: [], spanMs: 0, ticks: [] });
  });

  it.each([
    [4_000, [0, 1_000, 2_000, 3_000, 4_000]],
    [95_000, [0, 30_000, 60_000, 90_000]],
  ])('ticks for %d ms', (span, ticks) => {
    expect(ticksFor(span)).toEqual(ticks);
  });
});

describe('lineDiff', () => {
  it('shows a changed JSON field as a removed and an added line', () => {
    const rows = lineDiff(
      prettyJson({ id: 'ord_1', total: 1249, items: 3 }),
      prettyJson({ id: 'ord_1', total: '$1,249.00', currency: 'USD', items: 3 }),
    );

    expect(rows).toEqual([
      { kind: ' ', text: '{' },
      { kind: ' ', text: '  "id": "ord_1",' },
      { kind: '-', text: '  "total": 1249,' },
      { kind: '+', text: '  "total": "$1,249.00",' },
      { kind: '+', text: '  "currency": "USD",' },
      { kind: ' ', text: '  "items": 3' },
      { kind: ' ', text: '}' },
    ]);
  });

  it('folds long unchanged runs', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${String(i)}`);
    const after = [...before.slice(0, 19), 'changed'];

    const rows = lineDiff(before.join('\n'), after.join('\n'), 2);

    expect(rows[0]).toEqual({ kind: '…', text: '17 unchanged lines' });
    expect(rows.slice(1).map((row) => row.kind)).toEqual([' ', ' ', '-', '+']);
  });
});

describe('routes', () => {
  it.each([
    ['', { screen: 'runs' }],
    ['#/runs', { screen: 'runs' }],
    ['#/runs/01k6t3y8k0g3m5x9a2b7c4d6ef', { screen: 'run', runId: '01k6t3y8k0g3m5x9a2b7c4d6ef' }],
    ['#/fixture', { screen: 'fixture' }],
    ['#/nonsense', { screen: 'runs' }],
  ])('parses %j', (hash, route) => {
    expect(parseRoute(hash)).toEqual(route);
    expect(parseRoute(routeHref(parseRoute(hash)))).toEqual(route);
  });
});
