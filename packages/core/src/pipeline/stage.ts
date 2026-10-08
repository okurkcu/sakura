import type { Clock } from '../adapters/clock.js';
import type { Logger } from '../adapters/logger.js';
import type { Side, StageName } from '../domain/stage.js';
import type { Target } from '../domain/target.js';
import type { ArtifactPaths } from '../metrics/artifact-paths.js';
import type { RunId } from '../metrics/run-id.js';
import type { LlmUsage, RunCounts, TokenUsage } from '../metrics/run-record.js';

/**
 * One step of the pipeline: typed input in, typed output out. Stages never call each other; only
 * the orchestrator sequences them. Side effects go through adapters the stage was constructed with.
 */
export interface Stage<I, O> {
  readonly name: StageName;
  run(input: I, ctx: StageContext): Promise<O>;
}

/** A function that releases a resource. Gets its own signal: it runs even after the run aborted. */
export type CleanupHook = (signal: AbortSignal) => Promise<void>;

/** The run's LLM spend cap. */
export interface Budget {
  readonly limitUsd: number;
  spentUsd(): number;
  /**
   * Call before every LLM call.
   *
   * @throws BdiffError `BUDGET_EXCEEDED` when the run has already spent its budget.
   */
  assertAvailable(): void;
}

/** Run-scoped services handed to every stage. */
export interface StageContext {
  readonly runId: RunId;
  readonly target: Target;
  /** Logger bound to this run and stage. */
  readonly logger: Logger;
  readonly clock: Clock;
  readonly paths: ArtifactPaths;
  /** Aborts on Ctrl+C, run timeout or budget stop. Pass it to every subprocess, request and wait. */
  readonly signal: AbortSignal;
  readonly budget: Budget;
  /**
   * Registers a hook that releases a resource (container, worktree, browser). Hooks run once, in
   * reverse registration order, after the run ends: on success, failure, abort or timeout.
   */
  onCleanup(name: string, hook: CleanupHook): void;
  /** Prices and records one LLM call in the run record. */
  recordLlmUsage(purpose: string, usage: TokenUsage): LlmUsage;
  /** Adds to the run's probe and diff counts. */
  addCounts(counts: Partial<RunCounts>): void;
  /** Records the container CPU time of one side. */
  setComputeSeconds(side: Side, seconds: number): void;
}
