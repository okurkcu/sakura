import { FakeClock } from './fake-clock.js';
import { createTestRunRecorder, TEST_RUN_ID, TEST_TARGET } from './run-records.js';
import { createTestLogger } from './test-logger.js';
import type { TestLogger } from './test-logger.js';
import type { Clock } from '../adapters/clock.js';
import { BdiffError } from '../errors/bdiff-error.js';
import type { StageProgressEvent } from '../events/run-event.js';
import { createArtifactPaths } from '../metrics/artifact-paths.js';
import type { RunId } from '../metrics/run-id.js';
import type { Budget, CleanupHook, StageContext } from '../pipeline/stage.js';

/** Options for {@link createTestStageContext}. */
export interface TestStageContextOptions {
  /** Output root; artifact paths are built under it. Default `/test/.bdiff`. */
  readonly outDir?: string;
  readonly runId?: RunId;
  readonly clock?: Clock;
  readonly signal?: AbortSignal;
  readonly budgetUsd?: number;
}

/** A stage context for running one stage outside the pipeline, plus handles to inspect it. */
export interface TestStageContext {
  readonly ctx: StageContext;
  readonly logger: TestLogger;
  /** Progress events the stage reported, in order. */
  readonly progress: readonly StageProgressEvent[];
  /** Registered cleanup hooks, in registration order. */
  readonly cleanups: readonly { readonly name: string; readonly hook: CleanupHook }[];
  /** Runs the registered hooks in reverse order, like the pipeline; throws `CLEANUP_FAILED` if any failed. */
  runCleanups(): Promise<void>;
}

/** Creates a {@link TestStageContext} with test pricing, a test logger and a fake clock by default. */
export function createTestStageContext(options: TestStageContextOptions = {}): TestStageContext {
  const runId = options.runId ?? TEST_RUN_ID;
  const clock = options.clock ?? new FakeClock();
  const { recorder } = createTestRunRecorder();
  const logger = createTestLogger();
  const cleanups: { name: string; hook: CleanupHook }[] = [];
  const progress: StageProgressEvent[] = [];
  const limitUsd = options.budgetUsd ?? 1;
  const budget: Budget = {
    limitUsd,
    spentUsd: () => recorder.spentUsd(),
    assertAvailable: () => undefined,
  };
  const ctx: StageContext = {
    runId,
    target: TEST_TARGET,
    logger,
    clock,
    paths: createArtifactPaths(options.outDir ?? '/test/.bdiff', runId),
    signal: options.signal ?? new AbortController().signal,
    budget,
    onCleanup: (name, hook) => {
      cleanups.push({ name, hook });
    },
    recordLlmUsage: (purpose, usage) => recorder.recordLlmUsage(purpose, usage),
    addCounts: (counts) => {
      recorder.addCounts(counts);
    },
    setComputeSeconds: (side, seconds) => {
      recorder.setComputeSeconds(side, seconds);
    },
    progress: (event) => {
      progress.push(event);
    },
  };
  return {
    ctx,
    logger,
    progress,
    cleanups,
    runCleanups: async () => {
      const signal = new AbortController().signal;
      const failures: unknown[] = [];
      for (const { hook } of [...cleanups].reverse()) {
        try {
          await hook(signal);
        } catch (error) {
          failures.push(error);
        }
      }
      cleanups.length = 0;
      if (failures.length > 0) {
        throw new BdiffError('CLEANUP_FAILED', 'Cleanup hooks failed', { cause: failures[0] });
      }
    },
  };
}
