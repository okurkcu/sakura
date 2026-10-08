import type { CostCalculator } from './pricing.js';
import { RunIdSchema } from './run-id.js';
import type { RunId } from './run-id.js';
import { RUN_RECORD_SCHEMA_VERSION, RunCountsSchema, RunRecordSchema } from './run-record.js';
import type { LlmUsage, RunCounts, RunRecord, RunTotals, TokenUsage } from './run-record.js';
import { createStageTimer } from './stage-timer.js';
import type { StageTimer } from './stage-timer.js';
import type { Clock } from '../adapters/clock.js';
import type { Side, StageName } from '../domain/stage.js';
import type { Target } from '../domain/target.js';
import { TargetSchema } from '../domain/target.js';
import { BdiffError } from '../errors/bdiff-error.js';
import { toFailureRecord } from '../errors/failure-record.js';

/** How a run ended. */
export type RunOutcome =
  | { readonly status: 'success' }
  | {
      readonly status: 'failed';
      readonly error: unknown;
      /** Stage that was running; defaults to the last stage that failed. */
      readonly stage?: StageName;
    }
  | { readonly status: 'skipped'; readonly reason: string };

/** Inputs for {@link createRunRecorder}. */
export interface RunRecorderOptions {
  readonly runId: RunId;
  readonly target: Target;
  /** Git SHA of the bdiff checkout. */
  readonly toolVersion: string;
  readonly clock: Clock;
  readonly costs: CostCalculator;
}

/**
 * Accumulates everything the run record needs while a run is in progress, then produces the
 * validated {@link RunRecord}. One recorder per run.
 */
export interface RunRecorder {
  readonly runId: RunId;
  /** Times stages; its timings end up in the record, including those of a failed stage. */
  readonly timer: StageTimer;
  /** Prices and records one LLM call. Returns the recorded entry. */
  recordLlmUsage(purpose: string, usage: TokenUsage): LlmUsage;
  /** Total LLM spend so far, for budget checks. */
  spentUsd(): number;
  /** Sets the container CPU time of one side. */
  setComputeSeconds(side: Side, seconds: number): void;
  /** Adds to the probe and diff counts. */
  addCounts(counts: Partial<RunCounts>): void;
  /**
   * The record as it would be if the run ended now with `outcome`, without ending it. Used to
   * render the report before the final record exists.
   */
  preview(outcome: RunOutcome): RunRecord;
  /**
   * Produces the final record. For a failed run, the failure's stage is the error's own stage,
   * else the outcome's `stage`, else the last stage that failed. Can be called once.
   */
  finish(outcome: RunOutcome): RunRecord;
}

/**
 * Starts recording a run. Validates its identity up front so that `finish` can always produce a
 * record, even for a run that fails immediately.
 *
 * @throws BdiffError `INVALID_INPUT` for a malformed run id, target or tool version.
 */
export function createRunRecorder(options: RunRecorderOptions): RunRecorder {
  const runId = parseOrThrow('runId', () => RunIdSchema.parse(options.runId));
  const target = parseOrThrow('target', () => TargetSchema.parse(options.target));
  if (options.toolVersion.trim() === '') {
    throw new BdiffError('INVALID_INPUT', 'toolVersion must not be empty');
  }

  const { clock, costs } = options;
  const startedAt = clock.now();
  const startedMs = clock.monotonicMs();
  const timer = createStageTimer(clock);
  const llmUsage: LlmUsage[] = [];
  const computeSeconds = { base: 0, head: 0 };
  const counts: RunCounts = {
    routesProbed: 0,
    endpointsProbed: 0,
    rawDiffs: 0,
    noiseDiffs: 0,
    findings: 0,
  };
  let finished = false;

  const build = (outcome: RunOutcome): RunRecord => {
    const stageTimings = timer.timings();
    const base = {
      schemaVersion: RUN_RECORD_SCHEMA_VERSION,
      runId,
      toolVersion: options.toolVersion,
      target,
      startedAt: startedAt.toISOString(),
      finishedAt: clock.now().toISOString(),
      durationMs: Math.round(clock.monotonicMs() - startedMs),
      stageTimings: [...stageTimings],
      computeSeconds: { ...computeSeconds },
      llmUsage: [...llmUsage],
      totals: computeTotals(llmUsage, computeSeconds),
      counts: { ...counts },
    };
    switch (outcome.status) {
      case 'success':
        return RunRecordSchema.parse({ ...base, status: 'success' });
      case 'skipped':
        return RunRecordSchema.parse({
          ...base,
          status: 'skipped',
          skip: { reason: outcome.reason },
        });
      case 'failed': {
        const failedStage: StageName | undefined =
          outcome.stage ?? stageTimings.findLast((timing) => timing.outcome === 'failed')?.stage;
        return RunRecordSchema.parse({
          ...base,
          status: 'failed',
          failure: toFailureRecord(outcome.error, failedStage),
        });
      }
    }
  };

  return {
    runId,
    timer,
    recordLlmUsage: (purpose, usage) => {
      const entry: LlmUsage = { ...usage, purpose, costUsd: costs.costUsd(usage) };
      llmUsage.push(entry);
      return entry;
    },
    spentUsd: () => sumUsd(llmUsage.map((entry) => entry.costUsd)),
    setComputeSeconds: (side, seconds) => {
      computeSeconds[side] = seconds;
    },
    addCounts: (partial) => {
      for (const key of RunCountsSchema.keyof().options) {
        counts[key] += partial[key] ?? 0;
      }
    },
    preview: (outcome) => build(outcome),
    finish: (outcome) => {
      if (finished) {
        throw new BdiffError('INTERNAL', `Run ${runId} was already finished`);
      }
      finished = true;
      return build(outcome);
    },
  };
}

/** Sums LLM usage and compute time into the record's totals. Pure. */
export function computeTotals(
  llmUsage: readonly LlmUsage[],
  computeSeconds: Readonly<Record<Side, number>>,
): RunTotals {
  const sum = (pick: (entry: LlmUsage) => number) =>
    llmUsage.reduce((total, entry) => total + pick(entry), 0);
  return {
    llmCalls: llmUsage.length,
    inputTokens: sum((entry) => entry.inputTokens),
    outputTokens: sum((entry) => entry.outputTokens),
    cacheReadTokens: sum((entry) => entry.cacheReadTokens),
    cacheWrite5mTokens: sum((entry) => entry.cacheWrite5mTokens),
    cacheWrite1hTokens: sum((entry) => entry.cacheWrite1hTokens),
    llmCostUsd: sumUsd(llmUsage.map((entry) => entry.costUsd)),
    computeSeconds: computeSeconds.base + computeSeconds.head,
  };
}

/** Sums dollar amounts without accumulating binary floating-point noise (exact to 1e-12 USD). */
function sumUsd(amounts: readonly number[]): number {
  return amounts.reduce((total, amount) => total + Math.round(amount * 1e12), 0) / 1e12;
}

function parseOrThrow<T>(field: string, parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new BdiffError('INVALID_INPUT', `Invalid ${field} for run record`, { cause: error });
  }
}
