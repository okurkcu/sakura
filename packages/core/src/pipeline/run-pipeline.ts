import { createCleanupRegistry } from './cleanup-registry.js';
import type { PipelineStages } from './pipeline-stages.js';
import type { RunResult, StageOutputs } from './run-result.js';
import type { Budget, Stage, StageContext } from './stage.js';
import { raceAbort, withTimeout } from './with-timeout.js';
import type { Clock } from '../adapters/clock.js';
import type { FileSystem } from '../adapters/file-system.js';
import type { Logger } from '../adapters/logger.js';
import type { StageName } from '../domain/stage.js';
import type { Target } from '../domain/target.js';
import { abortError, throwIfAborted } from '../errors/abort.js';
import { BdiffError } from '../errors/bdiff-error.js';
import { createArtifactPaths } from '../metrics/artifact-paths.js';
import { createMetricsStore } from '../metrics/metrics-store.js';
import type { MetricsStore } from '../metrics/metrics-store.js';
import type { CostCalculator } from '../metrics/pricing.js';
import { createRunId } from '../metrics/run-id.js';
import type { RunId } from '../metrics/run-id.js';
import { createRunRecorder } from '../metrics/run-recorder.js';
import type { RunOutcome } from '../metrics/run-recorder.js';

/** Default limit for the whole run, including setup. */
export const DEFAULT_RUN_TIMEOUT_MS = 20 * 60_000;
/** Default LLM spend cap per run, in USD. */
export const DEFAULT_BUDGET_USD = 1;
/** Time each cleanup hook gets before it is abandoned and reported. */
export const DEFAULT_CLEANUP_HOOK_TIMEOUT_MS = 2 * 60_000;
/** Time the report gets to render. */
export const DEFAULT_REPORT_TIMEOUT_MS = 2 * 60_000;

/** Everything {@link runPipeline} needs besides the target and the stages. */
export interface PipelineDeps {
  readonly clock: Clock;
  readonly fs: FileSystem;
  readonly logger: Logger;
  readonly costs: CostCalculator;
  /** Output root (`.bdiff`). */
  readonly outDir: string;
  /** Git SHA of the bdiff checkout. */
  readonly toolVersion: string;
  readonly timeoutMs: number;
  readonly budgetUsd: number;
  /** External abort, e.g. Ctrl+C. Its reason becomes the run's failure. */
  readonly signal: AbortSignal;
  /** Defaults to a new id from `clock`. */
  readonly runId?: RunId;
  /** Defaults to a store writing under `outDir`. Share one across concurrent runs. */
  readonly store?: MetricsStore;
  readonly cleanupHookTimeoutMs?: number;
  readonly reportTimeoutMs?: number;
}

/** A finished run. */
export interface PipelineRun {
  readonly result: RunResult;
  readonly runJsonPath: string;
}

/**
 * Runs one target through the pipeline:
 *
 * `workspace → impact → (skipped? stop) → recipe → environment → probe-ui → probe-api → diff → interpret`
 *
 * then, whatever happened: cleanup hooks (LIFO), report, final record, `run.json` + CSV row.
 * Stages are timed, the first error stops the chain, and a run timeout or external abort aborts
 * the stage in progress.
 *
 * @throws BdiffError only when the run could not be recorded (invalid input, unwritable output).
 *   Every other failure is recorded in the returned result.
 */
export async function runPipeline(
  target: Target,
  stages: PipelineStages,
  deps: PipelineDeps,
): Promise<PipelineRun> {
  const { clock } = deps;
  const runId = deps.runId ?? createRunId(clock);
  const recorder = createRunRecorder({
    runId,
    target,
    toolVersion: deps.toolVersion,
    clock,
    costs: deps.costs,
  });
  const paths = createArtifactPaths(deps.outDir, runId);
  const store = deps.store ?? createMetricsStore({ fs: deps.fs, rootDir: deps.outDir });
  const logger = deps.logger.child({ runId });
  const cleanup = createCleanupRegistry(
    clock,
    logger,
    deps.cleanupHookTimeoutMs ?? DEFAULT_CLEANUP_HOOK_TIMEOUT_MS,
  );

  const run = new AbortController();
  const forwardAbort = () => {
    run.abort(deps.signal.reason);
  };
  deps.signal.addEventListener('abort', forwardAbort, { once: true });
  if (deps.signal.aborted) {
    forwardAbort();
  }
  const stopTimeout = new AbortController();
  clock.sleep(deps.timeoutMs, stopTimeout.signal).then(
    () => {
      run.abort(
        new BdiffError('RUN_TIMEOUT', `Run exceeded ${String(deps.timeoutMs)} ms`, {
          details: { timeoutMs: deps.timeoutMs },
        }),
      );
    },
    // Rejected only when the run ends first and cancels the timer below.
    () => undefined,
  );

  const budget: Budget = {
    limitUsd: deps.budgetUsd,
    spentUsd: () => recorder.spentUsd(),
    assertAvailable: () => {
      const spent = recorder.spentUsd();
      if (spent >= deps.budgetUsd) {
        throw new BdiffError('BUDGET_EXCEEDED', `LLM budget of $${String(deps.budgetUsd)} spent`, {
          details: { limitUsd: deps.budgetUsd, spentUsd: spent },
        });
      }
    },
  };

  const contextFor = (stage: StageName, signal: AbortSignal): StageContext => ({
    runId,
    target,
    logger: logger.child({ stage }),
    clock,
    paths,
    signal,
    budget,
    onCleanup: (name, hook) => {
      cleanup.register(name, hook);
    },
    recordLlmUsage: (purpose, usage) => recorder.recordLlmUsage(purpose, usage),
    addCounts: (counts) => {
      recorder.addCounts(counts);
    },
    setComputeSeconds: (side, seconds) => {
      recorder.setComputeSeconds(side, seconds);
    },
  });

  let currentStage: StageName | undefined;
  const runStage = async <I, O>(stage: Stage<I, O>, input: I): Promise<O> => {
    throwIfAborted(run.signal);
    currentStage = stage.name;
    logger.info('stage started', { stage: stage.name });
    const output = await recorder.timer.measure(stage.name, () =>
      raceAbort(stage.run(input, contextFor(stage.name, run.signal)), run.signal, () =>
        abortError(run.signal),
      ),
    );
    logger.info('stage finished', { stage: stage.name });
    return output;
  };

  logger.info('run started', { target });
  const outputs: StageOutputs = {};
  let outcome: RunOutcome;
  try {
    const workspace = (outputs.workspace = await runStage(stages.workspace, target));
    const impact = (outputs.impact = await runStage(stages.impact, { workspace }));
    if (impact.skip !== undefined) {
      outcome = { status: 'skipped', reason: impact.skip.reason };
    } else {
      const recipe = (outputs.recipe = await runStage(stages.recipe, { workspace }));
      const environment = (outputs.environment = await runStage(stages.environment, {
        workspace,
        recipe,
      }));
      const ui = (outputs.ui = await runStage(stages.probeUi, { environment, impact }));
      const api = (outputs.api = await runStage(stages.probeApi, {
        workspace,
        recipe,
        environment,
        impact,
      }));
      recorder.setApiRequests(api.requests);
      const findings = (outputs.findings = await runStage(stages.diff, { impact, ui, api }));
      outputs.interpretation = await runStage(stages.interpret, {
        target,
        workspace,
        impact,
        findings,
      });
      outcome = { status: 'success' };
    }
  } catch (error) {
    logger.error('run failed', { stage: currentStage, err: error });
    outcome =
      currentStage === undefined
        ? { status: 'failed', error }
        : { status: 'failed', error, stage: currentStage };
  } finally {
    stopTimeout.abort();
    deps.signal.removeEventListener('abort', forwardAbort);
  }

  const cleanupFailures = await cleanup.runAll();
  if (cleanupFailures.length > 0 && outcome.status !== 'failed') {
    outcome = {
      status: 'failed',
      error: new BdiffError('CLEANUP_FAILED', 'Resources may have been left behind', {
        cause: cleanupFailures[0]?.error,
        details: { hooks: cleanupFailures.map((failure) => failure.name) },
      }),
    };
  }

  try {
    await recorder.timer.measure('report', () =>
      withTimeout(
        clock,
        deps.reportTimeoutMs ?? DEFAULT_REPORT_TIMEOUT_MS,
        'INTERNAL',
        'Report',
        (signal) =>
          stages.report.run(
            { record: recorder.preview(outcome), ...outputs },
            contextFor('report', signal),
          ),
      ),
    );
  } catch (error) {
    logger.error('report failed', { err: error });
    if (outcome.status !== 'failed') {
      outcome = { status: 'failed', error, stage: 'report' };
    }
  }

  const record = recorder.finish(outcome);
  const runJsonPath = await store.writeRunRecord(record);
  await store.appendResult(record);
  logger.info('run finished', { status: record.status, durationMs: record.durationMs });
  return { result: { record, ...outputs }, runJsonPath };
}
