import path from 'node:path';

import { createCleanupRegistry } from './cleanup-registry.js';
import type { PipelineStages } from './pipeline-stages.js';
import type { RunResult, StageOutputs } from './run-result.js';
import { runSetup } from './setup-loop.js';
import type { Budget, Stage, StageContext } from './stage.js';
import { raceAbort, withTimeout } from './with-timeout.js';
import type { Clock } from '../adapters/clock.js';
import type { FileSystem } from '../adapters/file-system.js';
import type { Logger } from '../adapters/logger.js';
import type { StageName } from '../domain/stage.js';
import type { Target } from '../domain/target.js';
import { abortError, throwIfAborted } from '../errors/abort.js';
import { BdiffError, isBdiffError } from '../errors/bdiff-error.js';
import { createRunEventLog, teeLoggerToEvents } from '../events/event-log.js';
import type { LlmMode } from '../llm/llm-mode.js';
import { createArtifactPaths } from '../metrics/artifact-paths.js';
import { summarizeFindings } from '../metrics/finding-summary.js';
import { createMetricsStore } from '../metrics/metrics-store.js';
import type { MetricsStore } from '../metrics/metrics-store.js';
import type { CostCalculator } from '../metrics/pricing.js';
import { createRunId } from '../metrics/run-id.js';
import type { RunId } from '../metrics/run-id.js';
import type { RunDataset } from '../metrics/run-record.js';
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
  /** The dataset entry of a batch run, recorded in `run.json`. */
  readonly dataset?: RunDataset;
  /**
   * How the run uses the LLM, recorded in `run.json`; defaults to `on`. With `off` the
   * interpretation of findings is skipped (a run without findings still gets its deterministic
   * one), and with `off` or `fake` so is the setup repair loop.
   */
  readonly llmMode?: LlmMode;
  /** Process id recorded in the `run-started` event; defaults to this process. */
  readonly pid?: number;
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
 * (a repairable setup failure goes through the repair loop, `runSetup`), then, whatever happened: cleanup hooks (LIFO), report, final record, `result.json`, `run.json` + CSV row.
 * Stages are timed, the first error stops the chain, and a run timeout or external abort aborts
 * the stage in progress. Progress (stages, captures, log lines) is appended to `events.jsonl` as
 * it happens; losing it never fails the run.
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
  const llmMode = deps.llmMode ?? 'on';
  const runId = deps.runId ?? createRunId(clock);
  const recorder = createRunRecorder({
    llmMode,
    runId,
    target,
    toolVersion: deps.toolVersion,
    clock,
    costs: deps.costs,
    ...(deps.dataset === undefined ? {} : { dataset: deps.dataset }),
  });
  const paths = createArtifactPaths(deps.outDir, runId);
  const store = deps.store ?? createMetricsStore({ fs: deps.fs, rootDir: deps.outDir });
  const events = createRunEventLog({
    fs: deps.fs,
    clock,
    logger: deps.logger.child({ runId }),
    file: paths.eventsJsonl,
  });
  const logger = teeLoggerToEvents(deps.logger, events).child({ runId });
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
    progress: (event) => {
      events.emit(event);
    },
  });

  /** Times `fn` as `stage` and reports its start and end as events. */
  const measured = async <O>(stage: StageName, fn: () => Promise<O>): Promise<O> => {
    events.emit({ type: 'stage-started', stage });
    const started = clock.monotonicMs();
    const elapsed = () => Math.round(clock.monotonicMs() - started);
    try {
      const output = await recorder.timer.measure(stage, fn);
      events.emit({ type: 'stage-finished', stage, durationMs: elapsed(), status: 'success' });
      return output;
    } catch (error) {
      const code = isBdiffError(error) ? error.code : 'INTERNAL';
      events.emit({ type: 'stage-failed', stage, durationMs: elapsed(), code });
      throw error;
    }
  };
  /** Records a stage the LLM mode leaves out. */
  const skipStage = (stage: StageName): void => {
    recorder.timer.skip(stage);
    events.emit({ type: 'stage-finished', stage, durationMs: 0, status: 'skipped' });
    logger.child({ stage }).info('stage skipped', { llmMode });
  };

  let currentStage: StageName | undefined;
  const runStage = async <I, O>(stage: Stage<I, O>, input: I): Promise<O> => {
    throwIfAborted(run.signal);
    currentStage = stage.name;
    const stageLogger = logger.child({ stage: stage.name });
    stageLogger.info('stage started');
    const output = await measured(stage.name, () =>
      raceAbort(stage.run(input, contextFor(stage.name, run.signal)), run.signal, () =>
        abortError(run.signal),
      ),
    );
    stageLogger.info('stage finished');
    return output;
  };

  events.emit({
    type: 'run-started',
    runId,
    target: recorder.preview({ status: 'success' }).target,
    toolVersion: deps.toolVersion,
    llmMode,
    pid: deps.pid ?? process.pid,
  });
  logger.info('run started', { target });
  const outputs: StageOutputs = {};
  let outcome: RunOutcome;
  try {
    const workspace = (outputs.workspace = await runStage(stages.workspace, target));
    const impact = (outputs.impact = await runStage(stages.impact, { workspace }));
    if (impact.skip !== undefined) {
      outcome = { status: 'skipped', reason: impact.skip.reason };
    } else {
      const setup = await runSetup(workspace, {
        stages,
        runStage,
        // Only a real model can propose a repair.
        ...(llmMode === 'on' ? {} : { maxAttempts: 0 }),
        spentUsd: () => recorder.spentUsd(),
        onAttempts: (attempts) => {
          recorder.setSetupAttempts(attempts);
        },
      });
      if (setup.recipe !== null) {
        outputs.recipe = setup.recipe;
      }
      if (!setup.ok) {
        if (llmMode !== 'on') {
          skipStage('repair');
        }
        // The setup failure, not the repair attempts after it, is why the run failed.
        currentStage = setup.stage;
        throw setup.error;
      }
      const { recipe } = setup;
      const environment = (outputs.environment = setup.environment);
      const ui = (outputs.ui = await runStage(stages.probeUi, { environment, impact }));
      const api = (outputs.api = await runStage(stages.probeApi, {
        workspace,
        recipe,
        environment,
        impact,
      }));
      recorder.setApiRequests(api.requests);
      const findings = (outputs.findings = await runStage(stages.diff, { impact, ui, api }));
      recorder.setFindingSummary(summarizeFindings(findings));
      // Without findings the interpretation needs no LLM, so it runs in every mode.
      if (llmMode === 'off' && findings.length > 0) {
        skipStage('interpret');
      } else {
        const interpretation = (outputs.interpretation = await runStage(stages.interpret, {
          target,
          workspace,
          impact,
          ui,
          api,
          findings,
        }));
        recorder.setRiskLevel(interpretation.riskLevel);
        recorder.setFindingSummary(summarizeFindings(findings, interpretation));
      }
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
    await measured('report', () =>
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
  const result: RunResult = { record, ...outputs };
  await writeResult(deps.fs, paths.resultJson, result, logger);
  const runJsonPath = await store.writeRunRecord(record);
  await store.appendResult(record);
  logger.info('run finished', { status: record.status, durationMs: record.durationMs });
  events.emit({
    type: 'run-finished',
    status: record.status,
    durationMs: record.durationMs,
    ...(record.status === 'failed'
      ? {
          failure: {
            code: record.failure.code,
            ...(record.failure.stage === undefined ? {} : { stage: record.failure.stage }),
          },
        }
      : {}),
  });
  await events.flush();
  return { result, runJsonPath };
}

/**
 * Writes `result.json` (the run's full output, for the dev panel) through a temporary file, so a
 * reader never sees half of it. Best effort: `run.json` remains the run's record, so a failure is
 * logged, not thrown.
 */
async function writeResult(
  fs: FileSystem,
  file: string,
  result: RunResult,
  logger: Logger,
): Promise<void> {
  const temporary = `${file}.tmp`;
  try {
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(temporary, `${JSON.stringify(result)}\n`);
    await fs.rename(temporary, file);
  } catch (error) {
    logger.error('result.json could not be written', { file, err: error });
  }
}
