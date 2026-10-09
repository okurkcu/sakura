import { describe, expect, it } from 'vitest';

import { RunRecordSchema } from './run-record.js';
import type { TokenUsage } from './run-record.js';
import { createRunRecorder } from './run-recorder.js';
import { BdiffError } from '../errors/bdiff-error.js';
import { FakeClock } from '../testing/fake-clock.js';
import {
  createTestCostCalculator,
  createTestRunRecorder,
  TEST_RUN_ID,
  TEST_TARGET,
} from '../testing/run-records.js';

const call = (tokens: Partial<TokenUsage> = {}): TokenUsage => ({
  model: 'test-model',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  ...tokens,
});

describe('createRunRecorder', () => {
  it('produces a success record with times, timings, usage, totals and counts', async () => {
    const { recorder, clock } = createTestRunRecorder();
    await recorder.timer.measure('workspace', () => {
      clock.advance(1_000);
      return Promise.resolve();
    });
    recorder.recordLlmUsage('interpret', call({ inputTokens: 1_000_000, outputTokens: 500_000 }));
    recorder.recordLlmUsage('api-requests', call({ inputTokens: 2_000, cacheReadTokens: 10_000 }));
    recorder.setComputeSeconds('base', 12.5);
    recorder.setComputeSeconds('head', 14);
    recorder.addCounts({ routesProbed: 2, endpointsProbed: 1 });
    recorder.addCounts({ rawDiffs: 5, noiseDiffs: 3, findings: 2 });
    clock.advance(500);

    const record = recorder.finish({ status: 'success' });

    expect(record).toMatchObject({
      schemaVersion: 1,
      runId: TEST_RUN_ID,
      status: 'success',
      target: TEST_TARGET,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.500Z',
      durationMs: 1_500,
      stageTimings: [{ stage: 'workspace', durationMs: 1_000, outcome: 'success' }],
      computeSeconds: { base: 12.5, head: 14 },
      counts: { routesProbed: 2, endpointsProbed: 1, rawDiffs: 5, noiseDiffs: 3, findings: 2 },
      totals: {
        llmCalls: 2,
        inputTokens: 1_002_000,
        outputTokens: 500_000,
        cacheReadTokens: 10_000,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        computeSeconds: 26.5,
      },
    });
    // 1M×$1 + 0.5M×$2 = $2; 2000×$1 + 10000×$0.1 = 3000 µ$ → $0.003
    expect(record.llmUsage.map((entry) => [entry.purpose, entry.costUsd])).toEqual([
      ['interpret', 2],
      ['api-requests', 0.003],
    ]);
    expect(record.totals.llmCostUsd).toBe(2.003);
    expect('failure' in record).toBe(false);
  });

  it('tracks LLM spend for budget checks without float drift', () => {
    const { recorder } = createTestRunRecorder();
    for (let index = 0; index < 10; index++) {
      recorder.recordLlmUsage('probe', call({ inputTokens: 100_000 }));
    }

    expect(recorder.spentUsd()).toBe(1);
  });

  it('attributes a failure to the stage that failed', async () => {
    const { recorder, clock } = createTestRunRecorder();
    await recorder.timer.measure('workspace', () => {
      clock.advance(800);
      return Promise.resolve();
    });
    const error = await recorder.timer
      .measure('recipe', () => {
        clock.advance(200);
        return Promise.reject(new BdiffError('SETUP_UNSUPPORTED', 'no Next.js app found'));
      })
      .catch((caught: unknown) => caught);

    const record = recorder.finish({ status: 'failed', error });

    expect(record.status).toBe('failed');
    expect(record).toMatchObject({
      failure: { code: 'SETUP_UNSUPPORTED', stage: 'recipe', message: 'no Next.js app found' },
      stageTimings: [
        { stage: 'workspace', durationMs: 800, outcome: 'success' },
        { stage: 'recipe', durationMs: 200, outcome: 'failed' },
      ],
    });
  });

  it("prefers the error's own stage over the last failed timing", () => {
    const { recorder } = createTestRunRecorder();

    const record = recorder.finish({
      status: 'failed',
      error: new BdiffError('BUDGET_EXCEEDED', 'over budget', { stage: 'interpret' }),
    });

    expect(record).toMatchObject({ failure: { code: 'BUDGET_EXCEEDED', stage: 'interpret' } });
  });

  it('records a failure that happened outside any stage as INTERNAL without a stage', () => {
    const { recorder } = createTestRunRecorder();

    const record = recorder.finish({ status: 'failed', error: new TypeError('boom') });

    expect(record).toMatchObject({ failure: { code: 'INTERNAL', message: 'TypeError: boom' } });
    expect(record.status === 'failed' && 'stage' in record.failure).toBe(false);
  });

  it('records a skip with its reason', () => {
    const { recorder } = createTestRunRecorder();

    const record = recorder.finish({ status: 'skipped', reason: 'docs-only change' });

    expect(record).toMatchObject({ status: 'skipped', skip: { reason: 'docs-only change' } });
  });

  it('produces records that validate against the schema', async () => {
    const { recorder } = createTestRunRecorder();
    await recorder.timer.measure('diff', () => Promise.resolve());

    expect(RunRecordSchema.safeParse(recorder.finish({ status: 'success' })).success).toBe(true);
  });

  it('can only be finished once', () => {
    const { recorder } = createTestRunRecorder();
    recorder.finish({ status: 'success' });

    expect(() => recorder.finish({ status: 'success' })).toThrow(BdiffError);
  });

  it.each([
    { name: 'a malformed run id', runId: 'not-a-ulid', toolVersion: 'abc' },
    { name: 'an empty tool version', runId: TEST_RUN_ID, toolVersion: ' ' },
  ])('rejects $name up front', ({ runId, toolVersion }) => {
    expect(() =>
      createRunRecorder({
        runId,
        target: TEST_TARGET,
        toolVersion,
        clock: new FakeClock(),
        costs: createTestCostCalculator(),
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it('rejects an invalid target up front', () => {
    expect(() =>
      createRunRecorder({
        runId: TEST_RUN_ID,
        target: { ...TEST_TARGET, headRef: '--upload-pack=x' },
        toolVersion: 'abc',
        clock: new FakeClock(),
        costs: createTestCostCalculator(),
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});

describe('createRunRecorder: dataset and finding summary', () => {
  it('records the dataset entry of a batch run and the finding summary', () => {
    const recorder = createRunRecorder({
      runId: TEST_RUN_ID,
      target: TEST_TARGET,
      toolVersion: 'v1',
      clock: new FakeClock(),
      costs: createTestCostCalculator(),
      dataset: { id: 'shop-42', tags: { difficulty: 'easy' } },
    });
    recorder.setFindingSummary({ info: 1, warning: 0, breaking: 2, unexpected: 1 });

    const record = recorder.finish({ status: 'success' });

    expect(record).toMatchObject({
      dataset: { id: 'shop-42', tags: { difficulty: 'easy' } },
      findingSummary: { info: 1, warning: 0, breaking: 2, unexpected: 1 },
    });
  });

  it('defaults to no dataset and zero findings, also for old records', () => {
    const record = createTestRunRecorder().recorder.finish({ status: 'success' });
    expect(record).toMatchObject({
      dataset: null,
      findingSummary: { info: 0, warning: 0, breaking: 0, unexpected: 0 },
    });

    const old: Record<string, unknown> = { ...record };
    delete old.dataset;
    delete old.findingSummary;
    expect(RunRecordSchema.parse(old)).toEqual(record);
  });

  it('rejects an invalid dataset entry up front', () => {
    expect(() =>
      createRunRecorder({
        runId: TEST_RUN_ID,
        target: TEST_TARGET,
        toolVersion: 'v1',
        clock: new FakeClock(),
        costs: createTestCostCalculator(),
        dataset: { id: '', tags: {} },
      }),
    ).toThrow(BdiffError);
  });
});

describe('createRunRecorder: outcome stage and preview', () => {
  it("uses the outcome's stage over the last failed timing", async () => {
    const { recorder } = createTestRunRecorder();
    await recorder.timer
      .measure('report', () => Promise.reject(new Error('report crashed')))
      .catch(() => undefined);

    const record = recorder.finish({
      status: 'failed',
      error: new Error('diff crashed'),
      stage: 'diff',
    });

    expect(record).toMatchObject({ failure: { stage: 'diff', message: 'Error: diff crashed' } });
  });

  it('previews the record without finishing the run', () => {
    const { recorder, clock } = createTestRunRecorder();
    clock.advance(100);

    const preview = recorder.preview({ status: 'success' });
    clock.advance(50);
    const final = recorder.finish({ status: 'success' });

    expect(preview.durationMs).toBe(100);
    expect(final.durationMs).toBe(150);
  });
});
