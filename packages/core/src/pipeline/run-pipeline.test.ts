import { describe, expect, it, vi } from 'vitest';

import type { PipelineStages } from './pipeline-stages.js';
import { runPipeline } from './run-pipeline.js';
import type { PipelineDeps } from './run-pipeline.js';
import type { RunResult } from './run-result.js';
import type { StageContext } from './stage.js';
import type { Finding } from '../domain/finding.js';
import type { StageName } from '../domain/stage.js';
import { abortError } from '../errors/abort.js';
import { BdiffError } from '../errors/bdiff-error.js';
import { parseRunEvents, withoutTime } from '../events/run-event.js';
import type { RunEventInput } from '../events/run-event.js';
import { createInterpretStage } from '../interpret/interpret-stage.js';
import { createArtifactPaths } from '../metrics/artifact-paths.js';
import type { RunRecord } from '../metrics/run-record.js';
import { FakeClock } from '../testing/fake-clock.js';
import { FakeExec } from '../testing/fake-exec.js';
import { FakeLlmClient } from '../testing/fake-llm-client.js';
import { createMemoryFileSystem } from '../testing/memory-file-system.js';
import type { MemoryFileSystem } from '../testing/memory-file-system.js';
import { createMemoryMetricsStore } from '../testing/memory-metrics-store.js';
import { createTestCostCalculator, TEST_RUN_ID, TEST_TARGET } from '../testing/run-records.js';
import { createStubStages, STUB_RECIPE } from '../testing/stub-stages.js';
import { createTestLogger } from '../testing/test-logger.js';

type Override = (input: unknown, ctx: StageContext) => Promise<unknown>;

/**
 * Stub stages that log every call and advance the clock by 10 ms each; `overrides` replace the
 * behavior of individual stages.
 */
/** The stages that are a single `Stage` (every one but `repair`). */
type SingleStageKey = Exclude<keyof PipelineStages, 'repair'>;

function recordingStages(
  clock: FakeClock,
  overrides: Partial<Record<SingleStageKey, Override>> = {},
) {
  const calls: StageName[] = [];
  const reports: RunResult[] = [];
  const stubs = createStubStages();
  const wrap = <K extends SingleStageKey>(key: K): PipelineStages[K] => {
    const stub = stubs[key];
    const override = overrides[key];
    return {
      name: stub.name,
      run: async (input: never, ctx: StageContext) => {
        calls.push(stub.name);
        if (key === 'report') {
          reports.push(input);
        }
        clock.advance(10);
        return override === undefined ? stub.run(input, ctx) : override(input, ctx);
      },
    } as PipelineStages[K];
  };
  const stages: PipelineStages = {
    workspace: wrap('workspace'),
    impact: wrap('impact'),
    recipe: wrap('recipe'),
    environment: wrap('environment'),
    repair: stubs.repair,
    probeUi: wrap('probeUi'),
    probeApi: wrap('probeApi'),
    diff: wrap('diff'),
    interpret: wrap('interpret'),
    report: wrap('report'),
  };
  return { stages, calls, reports };
}

function deps(clock: FakeClock, overrides: Partial<PipelineDeps> = {}) {
  const store = createMemoryMetricsStore();
  const logger = createTestLogger();
  const value: PipelineDeps = {
    clock,
    fs: createMemoryFileSystem(),
    logger,
    costs: createTestCostCalculator(),
    outDir: '/out/.bdiff',
    toolVersion: 'abc123',
    timeoutMs: 60_000,
    budgetUsd: 1,
    signal: new AbortController().signal,
    runId: TEST_RUN_ID,
    store,
    cleanupHookTimeoutMs: 5_000,
    reportTimeoutMs: 5_000,
    ...overrides,
  };
  return { deps: value, store, logger };
}

/** A stage body that waits until the run aborts, then rejects like a well-behaved stage. */
function waitForAbort(started: { value: boolean }): Override {
  return (_input, ctx) =>
    new Promise((_resolve, reject) => {
      started.value = true;
      ctx.signal.addEventListener('abort', () => {
        reject(abortError(ctx.signal));
      });
    });
}

const ALL_STAGES: StageName[] = [
  'workspace',
  'impact',
  'recipe',
  'environment',
  'probe-ui',
  'probe-api',
  'diff',
  'interpret',
  'report',
];

function failure(record: RunRecord) {
  return record.status === 'failed' ? record.failure : undefined;
}

const PATHS = createArtifactPaths('/out/.bdiff', TEST_RUN_ID);

/** The events a run wrote, without their timestamps. */
function eventsOf(fs: MemoryFileSystem): RunEventInput[] {
  const text = fs.files.get(PATHS.eventsJsonl);
  const { events, invalid } = parseRunEvents(typeof text === 'string' ? text : '');
  expect(invalid).toBe(0);
  return events.map(withoutTime);
}

/** `[type, stage, status or code]` of each stage event, in order. */
function stageEvents(fs: MemoryFileSystem): [string, string, string?][] {
  return eventsOf(fs).flatMap((event): [string, string, string?][] => {
    switch (event.type) {
      case 'stage-started':
        return [[event.type, event.stage]];
      case 'stage-finished':
        return [[event.type, event.stage, event.status]];
      case 'stage-failed':
        return [[event.type, event.stage, event.code]];
      default:
        return [];
    }
  });
}

describe('runPipeline events, result.json and LLM modes', () => {
  const memoryDeps = (clock: FakeClock, overrides: Partial<PipelineDeps> = {}) => {
    const fs = createMemoryFileSystem();
    return { fs, ...deps(clock, { fs, pid: 4242, ...overrides }) };
  };

  it('appends run, stage and log events as the run progresses, and writes result.json', async () => {
    const clock = new FakeClock();
    const { stages } = recordingStages(clock);
    const { deps: d, fs } = memoryDeps(clock);

    const { result } = await runPipeline(TEST_TARGET, stages, d);

    const events = eventsOf(fs);
    expect(events[0]).toEqual({
      type: 'run-started',
      runId: TEST_RUN_ID,
      target: TEST_TARGET,
      toolVersion: 'abc123',
      llmMode: 'on',
      pid: 4242,
    });
    expect(events.at(-1)).toEqual({
      type: 'run-finished',
      status: 'success',
      durationMs: result.record.durationMs,
    });
    expect(stageEvents(fs)).toEqual(
      ALL_STAGES.flatMap((stage) => [
        ['stage-started', stage],
        ['stage-finished', stage, 'success'],
      ]),
    );
    expect(events).toContainEqual({ type: 'log', level: 'info', message: 'run started' });
    expect(events).toContainEqual({
      type: 'log',
      level: 'info',
      message: 'stage finished',
      stage: 'diff',
    });
    expect(JSON.parse(String(fs.files.get(PATHS.resultJson)))).toEqual(
      JSON.parse(JSON.stringify(result)),
    );
    expect(fs.files.has(`${PATHS.resultJson}.tmp`)).toBe(false);
  });

  it('reports a failing stage with its code, and the failure in run-finished', async () => {
    const clock = new FakeClock();
    const { stages } = recordingStages(clock, {
      probeUi: () => Promise.reject(new BdiffError('DOCKER_UNAVAILABLE', 'no docker')),
    });
    const { deps: d, fs } = memoryDeps(clock);

    await runPipeline(TEST_TARGET, stages, d);

    expect(stageEvents(fs)).toContainEqual(['stage-failed', 'probe-ui', 'DOCKER_UNAVAILABLE']);
    expect(eventsOf(fs).at(-1)).toMatchObject({
      type: 'run-finished',
      status: 'failed',
      failure: { stage: 'probe-ui', code: 'DOCKER_UNAVAILABLE' },
    });
  });

  it('passes stage progress (captures, environment sides) through to the events', async () => {
    const clock = new FakeClock();
    const { stages } = recordingStages(clock, {
      probeUi: (input, ctx) => {
        ctx.progress({
          type: 'capture',
          probeRun: 'baseA',
          route: '/login',
          status: 'ok',
          ms: 120,
          total: 1,
        });
        return createStubStages().probeUi.run(input as never, ctx);
      },
    });
    const { deps: d, fs } = memoryDeps(clock);

    await runPipeline(TEST_TARGET, stages, d);

    expect(eventsOf(fs)).toContainEqual({
      type: 'capture',
      probeRun: 'baseA',
      route: '/login',
      status: 'ok',
      ms: 120,
      total: 1,
    });
  });

  it('never fails a run because its events or result.json cannot be written', async () => {
    const clock = new FakeClock();
    const { stages } = recordingStages(clock);
    const { deps: d, fs, store, logger } = memoryDeps(clock);
    fs.failOn('appendFile', 'writeFile');

    const { result } = await runPipeline(TEST_TARGET, stages, d);

    expect(result.record.status).toBe('success');
    expect(store.written).toEqual([result.record]);
    expect(logger.entries.map((entry) => [entry.level, entry.message])).toEqual(
      expect.arrayContaining([
        ['warn', 'run events could not be written; live progress stops'],
        ['error', 'result.json could not be written'],
      ]),
    );
  });

  it('with the LLM off, skips the interpretation of findings and records the mode', async () => {
    const clock = new FakeClock();
    const finding: Finding = {
      id: 'f1',
      kind: 'visual',
      severity: 'info',
      location: { route: '/' },
      evidence: [],
    };
    const { stages, calls } = recordingStages(clock, { diff: () => Promise.resolve([finding]) });
    const { deps: d, fs } = memoryDeps(clock, { llmMode: 'off' });

    const { result } = await runPipeline(TEST_TARGET, stages, d);

    expect(calls).not.toContain('interpret');
    expect(result.record).toMatchObject({ status: 'success', llmMode: 'off', riskLevel: null });
    expect(result.interpretation).toBeUndefined();
    expect(result.record.stageTimings).toContainEqual({
      stage: 'interpret',
      durationMs: 0,
      outcome: 'skipped',
    });
    expect(stageEvents(fs)).toContainEqual(['stage-finished', 'interpret', 'skipped']);
    expect(eventsOf(fs)[0]).toMatchObject({ type: 'run-started', llmMode: 'off' });
  });

  it('with the LLM off, still interprets a run without findings (no LLM call needed)', async () => {
    const clock = new FakeClock();
    const { stages, calls } = recordingStages(clock);
    const { deps: d } = memoryDeps(clock, { llmMode: 'off' });

    const { result } = await runPipeline(TEST_TARGET, stages, d);

    expect(calls).toContain('interpret');
    expect(result.record.stageTimings.some((timing) => timing.outcome === 'skipped')).toBe(false);
  });

  it.each(['off', 'fake'] as const)(
    'with the LLM %s, skips the setup repair and fails with the setup error',
    async (llmMode) => {
      const clock = new FakeClock();
      const { stages } = recordingStages(clock, {
        environment: () => Promise.reject(new BdiffError('SETUP_BUILD_FAILED', 'build failed')),
      });
      let proposed = false;
      const repair: PipelineStages['repair'] = {
        ...stages.repair,
        propose: {
          name: 'repair',
          run: () => {
            proposed = true;
            return Promise.reject(new Error('must not be called'));
          },
        },
      };
      const { deps: d, fs } = memoryDeps(clock, { llmMode });

      const { result } = await runPipeline(TEST_TARGET, { ...stages, repair }, d);

      expect(proposed).toBe(false);
      expect(failure(result.record)).toMatchObject({
        stage: 'environment',
        code: 'SETUP_BUILD_FAILED',
      });
      expect(result.record.setupAttempts).toEqual([]);
      expect(result.record.stageTimings).toContainEqual({
        stage: 'repair',
        durationMs: 0,
        outcome: 'skipped',
      });
      expect(stageEvents(fs)).toContainEqual(['stage-finished', 'repair', 'skipped']);
    },
  );

  it('with the LLM fake, still runs the interpretation and records the mode', async () => {
    const clock = new FakeClock();
    const { stages, calls } = recordingStages(clock);
    const { deps: d } = memoryDeps(clock, { llmMode: 'fake' });

    const { result } = await runPipeline(TEST_TARGET, stages, d);

    expect(calls).toContain('interpret');
    expect(result.record.llmMode).toBe('fake');
  });
});

describe('runPipeline', () => {
  it('runs every stage in order, times them and records a success', async () => {
    const clock = new FakeClock();
    const { stages, calls } = recordingStages(clock);
    const { deps: d, store } = deps(clock);

    const { result, runJsonPath } = await runPipeline(TEST_TARGET, stages, d);

    expect(calls).toEqual(ALL_STAGES);
    expect(result.record.status).toBe('success');
    expect(result.record.stageTimings.map((timing) => [timing.stage, timing.durationMs])).toEqual(
      ALL_STAGES.map((stage) => [stage, 10]),
    );
    expect(result.workspace?.headSha).toBe('1'.repeat(40));
    expect(result.findings).toEqual([]);
    expect(store.written).toEqual([result.record]);
    expect(store.appended).toEqual([result.record]);
    expect(runJsonPath).toBe(`memory://runs/${TEST_RUN_ID}/run.json`);
  });

  it('skips the heavy stages when impact says so, but still reports and records', async () => {
    const clock = new FakeClock();
    const { stages, calls, reports } = recordingStages(clock, {
      impact: () => Promise.resolve({ skip: { reason: 'docs-only' } }),
    });
    const { deps: d, store } = deps(clock);

    const { result } = await runPipeline(TEST_TARGET, stages, d);

    expect(calls).toEqual(['workspace', 'impact', 'report']);
    expect(result.record).toMatchObject({ status: 'skipped', skip: { reason: 'docs-only' } });
    expect(reports[0]?.record.status).toBe('skipped');
    expect(store.written).toHaveLength(1);
  });

  it('gives the API probe the workspace and recipe, and records its request set in the run record', async () => {
    const clock = new FakeClock();
    const inputs: unknown[] = [];
    const request = {
      key: 'POST /api/feedback',
      source: 'generated',
      method: 'POST',
      path: '/api/feedback',
      headers: {},
      body: { contentType: 'application/json', text: '{"rating":5}' },
      description: 'Five-star feedback',
      endpoint: 'POST /api/feedback',
    } as const;
    const { stages } = recordingStages(clock, {
      probeApi: (input) => {
        inputs.push(input);
        return Promise.resolve({ requests: [request], captures: [], notProbed: [] });
      },
    });
    const { deps: d, store } = deps(clock);

    const { result } = await runPipeline(TEST_TARGET, stages, d);

    expect(inputs[0]).toMatchObject({
      workspace: expect.anything() as unknown,
      recipe: expect.anything() as unknown,
      environment: expect.anything() as unknown,
      impact: expect.anything() as unknown,
    });
    expect(result.record.apiRequests).toEqual([request]);
    expect(store.written[0]?.apiRequests).toEqual([request]);
  });

  it('makes no LLM call for a run without findings: its record shows no LLM usage', async () => {
    const clock = new FakeClock();
    const llm = new FakeLlmClient();
    const interpret = createInterpretStage({
      llm,
      exec: new FakeExec(),
      github: { getPullRequest: () => Promise.reject(new Error('not used')) },
    });
    const { stages } = recordingStages(clock, { diff: () => Promise.resolve([]) });
    const { deps: d } = deps(clock);

    const { result } = await runPipeline(TEST_TARGET, { ...stages, interpret }, d);

    expect(result.record.status).toBe('success');
    expect(result.record.llmUsage).toEqual([]);
    expect(result.record.totals).toMatchObject({ llmCalls: 0, llmCostUsd: 0 });
    expect(result.interpretation).toMatchObject({ source: 'no-findings' });
    expect(result.record.riskLevel).toBe('low');
    expect(llm.calls).toEqual([]);
  });

  it('stops at the first failing stage, runs cleanup, reports and records the failure', async () => {
    const clock = new FakeClock();
    const cleaned: string[] = [];
    const { stages, calls, reports } = recordingStages(clock, {
      recipe: (_input, ctx) => {
        ctx.onCleanup('recipe cache lock', () => {
          cleaned.push('recipe');
          return Promise.resolve();
        });
        return Promise.reject(new BdiffError('SETUP_UNSUPPORTED', 'no Next.js app found'));
      },
      workspace: (_input, ctx) => {
        ctx.onCleanup('worktrees', () => {
          cleaned.push('workspace');
          return Promise.resolve();
        });
        return createStubStages().workspace.run(TEST_TARGET, ctx);
      },
    });
    const { deps: d, store } = deps(clock);

    const { result } = await runPipeline(TEST_TARGET, stages, d);

    expect(calls).toEqual(['workspace', 'impact', 'recipe', 'report']);
    expect(cleaned).toEqual(['recipe', 'workspace']);
    expect(failure(result.record)).toMatchObject({ code: 'SETUP_UNSUPPORTED', stage: 'recipe' });
    expect(result.record.stageTimings.map((timing) => [timing.stage, timing.outcome])).toEqual([
      ['workspace', 'success'],
      ['impact', 'success'],
      ['recipe', 'failed'],
      // SETUP_UNSUPPORTED goes to the repair loop; the stub repair has no LLM, so it gives up.
      ['repair', 'failed'],
      ['report', 'success'],
    ]);
    expect(result.record.setupAttempts).toMatchObject([
      { attempt: 1, outcome: 'no-patch', errorCode: 'LLM_UNAVAILABLE' },
    ]);
    expect(reports[0]?.record.status).toBe('failed');
    expect(reports[0]?.workspace).toBeDefined();
    expect(reports[0]?.recipe).toBeUndefined();
    expect(store.written[0]?.status).toBe('failed');
  });

  describe('setup repair', () => {
    const buildFailed = () =>
      new BdiffError('SETUP_BUILD_FAILED', 'head: build failed', { details: { side: 'head' } });
    const repaired = { ...STUB_RECIPE, startCmd: ['pnpm', 'run', 'start'] };
    const repair = (kept: unknown[]): PipelineStages['repair'] => ({
      propose: {
        name: 'repair',
        run: () =>
          Promise.resolve({
            kind: 'patched',
            recipe: repaired,
            patch: {
              reason: 'test',
              env: [],
              nodeVersion: null,
              packageManager: null,
              installCmd: null,
              buildCmd: null,
              startCmd: ['pnpm', 'run', 'start'],
              dbSetupCmds: null,
              appRoot: null,
              port: null,
              healthPath: null,
            },
            tier: 'fast',
          }),
      },
      keep: {
        name: 'repair',
        run: ({ recipe }) => {
          kept.push(recipe);
          return Promise.resolve();
        },
      },
    });

    it('repairs a failed setup and carries on with the repaired recipe', async () => {
      const clock = new FakeClock();
      let environmentRuns = 0;
      const { stages } = recordingStages(clock, {
        environment: (input, ctx) =>
          ++environmentRuns === 1
            ? Promise.reject(buildFailed())
            : createStubStages().environment.run(input as never, ctx),
      });
      const kept: unknown[] = [];

      const { result } = await runPipeline(
        TEST_TARGET,
        { ...stages, repair: repair(kept) },
        deps(clock).deps,
      );

      expect(result.record.status).toBe('success');
      expect(result.recipe).toEqual(repaired);
      expect(kept).toEqual([repaired]);
      expect(result.record.setupAttempts).toMatchObject([
        { attempt: 1, trigger: { code: 'SETUP_BUILD_FAILED', side: 'head' }, outcome: 'repaired' },
      ]);
      expect(
        result.record.stageTimings
          .map((timing) => [timing.stage, timing.outcome])
          .filter(([stage]) => stage === 'environment' || stage === 'repair'),
      ).toEqual([
        ['environment', 'failed'],
        ['repair', 'success'],
        ['environment', 'success'],
        ['repair', 'success'],
      ]);
    });

    it('records an unrepaired setup failure against the stage that failed', async () => {
      const clock = new FakeClock();
      const { stages } = recordingStages(clock, {
        environment: () => Promise.reject(buildFailed()),
      });

      const { result } = await runPipeline(
        TEST_TARGET,
        { ...stages, repair: repair([]) },
        deps(clock).deps,
      );

      expect(failure(result.record)).toMatchObject({
        code: 'SETUP_BUILD_FAILED',
        stage: 'environment',
      });
      expect(result.record.setupAttempts.map((attempt) => attempt.outcome)).toEqual([
        'setup-failed',
        'setup-failed',
        'setup-failed',
      ]);
      expect(result.recipe).toEqual(repaired);
    });
  });

  it('runs cleanup hooks in reverse order even when one fails, and fails an otherwise good run', async () => {
    const clock = new FakeClock();
    const order: string[] = [];
    const { stages } = recordingStages(clock, {
      workspace: (_input, ctx) => {
        ctx.onCleanup('first', () => {
          order.push('first');
          return Promise.resolve();
        });
        ctx.onCleanup('second', () => {
          order.push('second');
          return Promise.reject(new Error('docker compose down failed'));
        });
        ctx.onCleanup('third', () => {
          order.push('third');
          return Promise.resolve();
        });
        return createStubStages().workspace.run(TEST_TARGET, ctx);
      },
    });
    const { deps: d } = deps(clock);

    const { result } = await runPipeline(TEST_TARGET, stages, d);

    expect(order).toEqual(['third', 'second', 'first']);
    expect(failure(result.record)).toMatchObject({
      code: 'CLEANUP_FAILED',
      details: { hooks: ['second'] },
    });
  });

  it('abandons a hanging cleanup hook after its timeout and runs the rest', async () => {
    const clock = new FakeClock();
    const order: string[] = [];
    const hookStarted = { value: false };
    const { stages } = recordingStages(clock, {
      workspace: (_input, ctx) => {
        ctx.onCleanup('quick', () => {
          order.push('quick');
          return Promise.resolve();
        });
        ctx.onCleanup('hangs', () => {
          hookStarted.value = true;
          return new Promise(() => undefined);
        });
        return createStubStages().workspace.run(TEST_TARGET, ctx);
      },
    });
    const { deps: d } = deps(clock);

    const running = runPipeline(TEST_TARGET, stages, d);
    await vi.waitFor(() => {
      expect(hookStarted.value).toBe(true);
    });
    clock.advance(5_000);
    const { result } = await running;

    expect(order).toEqual(['quick']);
    expect(failure(result.record)).toMatchObject({
      code: 'CLEANUP_FAILED',
      details: { hooks: ['hangs'] },
    });
  });

  it('aborts the stage in progress on an external abort and records why', async () => {
    const clock = new FakeClock();
    const started = { value: false };
    const cleaned: string[] = [];
    const { stages, calls } = recordingStages(clock, {
      workspace: (_input, ctx) => {
        ctx.onCleanup('worktrees', () => {
          cleaned.push('worktrees');
          return Promise.resolve();
        });
        return createStubStages().workspace.run(TEST_TARGET, ctx);
      },
      environment: waitForAbort(started),
    });
    const controller = new AbortController();
    const { deps: d } = deps(clock, { signal: controller.signal });

    const running = runPipeline(TEST_TARGET, stages, d);
    await vi.waitFor(() => {
      expect(started.value).toBe(true);
    });
    controller.abort(new BdiffError('ABORTED', 'Interrupted by SIGINT'));
    const { result } = await running;

    expect(failure(result.record)).toMatchObject({
      code: 'ABORTED',
      stage: 'environment',
      message: 'Interrupted by SIGINT',
    });
    expect(cleaned).toEqual(['worktrees']);
    expect(calls).toEqual(['workspace', 'impact', 'recipe', 'environment', 'report']);
  });

  it('does not hang on a stage that ignores the abort signal', async () => {
    const clock = new FakeClock();
    const started = { value: false };
    const { stages } = recordingStages(clock, {
      probeUi: () => {
        started.value = true;
        return new Promise(() => undefined);
      },
    });
    const controller = new AbortController();
    const { deps: d } = deps(clock, { signal: controller.signal });

    const running = runPipeline(TEST_TARGET, stages, d);
    await vi.waitFor(() => {
      expect(started.value).toBe(true);
    });
    controller.abort();
    const { result } = await running;

    expect(failure(result.record)).toMatchObject({ code: 'ABORTED', stage: 'probe-ui' });
  });

  it('fails the run with RUN_TIMEOUT when the run timeout elapses', async () => {
    const clock = new FakeClock();
    const started = { value: false };
    const { stages } = recordingStages(clock, { environment: waitForAbort(started) });
    const { deps: d } = deps(clock, { timeoutMs: 60_000 });

    const running = runPipeline(TEST_TARGET, stages, d);
    await vi.waitFor(() => {
      expect(started.value).toBe(true);
    });
    clock.advance(60_000);
    const { result } = await running;

    expect(failure(result.record)).toMatchObject({ code: 'RUN_TIMEOUT', stage: 'environment' });
  });

  it('runs no stage when the signal is already aborted, but still records the run', async () => {
    const clock = new FakeClock();
    const { stages, calls } = recordingStages(clock);
    const controller = new AbortController();
    controller.abort();
    const { deps: d, store } = deps(clock, { signal: controller.signal });

    const { result } = await runPipeline(TEST_TARGET, stages, d);

    expect(calls).toEqual(['report']);
    expect(failure(result.record)).toMatchObject({ code: 'ABORTED' });
    expect(store.written).toHaveLength(1);
  });

  it('enforces the LLM budget through the stage context', async () => {
    const clock = new FakeClock();
    const { stages } = recordingStages(clock, {
      interpret: (_input, ctx) => {
        ctx.budget.assertAvailable();
        ctx.recordLlmUsage('interpret', {
          model: 'test-model',
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
        });
        ctx.budget.assertAvailable();
        return Promise.resolve({});
      },
    });
    const { deps: d } = deps(clock, { budgetUsd: 1 });

    const { result } = await runPipeline(TEST_TARGET, stages, d);

    expect(failure(result.record)).toMatchObject({ code: 'BUDGET_EXCEEDED', stage: 'interpret' });
    expect(result.record.totals.llmCostUsd).toBe(1);
  });

  it('fails a successful run whose report fails', async () => {
    const clock = new FakeClock();
    const { stages } = recordingStages(clock, {
      report: () => Promise.reject(new BdiffError('INTERNAL', 'template error')),
    });
    const { deps: d } = deps(clock);

    const { result } = await runPipeline(TEST_TARGET, stages, d);

    expect(failure(result.record)).toMatchObject({ code: 'INTERNAL', stage: 'report' });
  });

  it('keeps the original failure when the report of a failed run also fails', async () => {
    const clock = new FakeClock();
    const { stages } = recordingStages(clock, {
      diff: () => Promise.reject(new BdiffError('INTERNAL', 'diff crashed')),
      report: () => Promise.reject(new Error('report crashed')),
    });
    const { deps: d } = deps(clock);

    const { result } = await runPipeline(TEST_TARGET, stages, d);

    expect(failure(result.record)).toMatchObject({ stage: 'diff', message: 'diff crashed' });
  });

  it('gives stages a context bound to the run and stage', async () => {
    const clock = new FakeClock();
    let seen: StageContext | undefined;
    const { stages } = recordingStages(clock, {
      recipe: (_input, ctx) => {
        seen = ctx;
        ctx.logger.info('detecting');
        ctx.addCounts({ routesProbed: 3 });
        ctx.setComputeSeconds('head', 7);
        return Promise.resolve({});
      },
    });
    const { deps: d, logger } = deps(clock);

    const { result } = await runPipeline(TEST_TARGET, stages, d);

    expect(seen).toMatchObject({ runId: TEST_RUN_ID, target: TEST_TARGET, clock });
    expect(seen?.paths.runDir).toBe(`/out/.bdiff/runs/${TEST_RUN_ID}`);
    expect(logger.entries).toContainEqual({
      level: 'info',
      message: 'detecting',
      fields: { runId: TEST_RUN_ID, stage: 'recipe' },
    });
    expect(result.record.counts.routesProbed).toBe(3);
    expect(result.record.computeSeconds.head).toBe(7);
  });

  it('refuses cleanup hooks registered after cleanup ran', async () => {
    const clock = new FakeClock();
    const { stages } = recordingStages(clock, {
      report: (_input, ctx) => {
        ctx.onCleanup('too late', () => Promise.resolve());
        return Promise.resolve();
      },
    });
    const { deps: d } = deps(clock);

    const { result } = await runPipeline(TEST_TARGET, stages, d);

    expect(failure(result.record)).toMatchObject({ code: 'INTERNAL', stage: 'report' });
  });
});
