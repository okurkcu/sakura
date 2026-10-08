import { z } from 'zod';

import { RunIdSchema } from './run-id.js';
import { ApiRequestSchema } from '../domain/api-probe.js';
import { StageNameSchema } from '../domain/stage.js';
import { TargetSchema } from '../domain/target.js';
import { FailureRecordSchema } from '../errors/failure-record.js';

const count = z.number().int().nonnegative();
const nonNegative = z.number().nonnegative();

/** Version of the `run.json` format. Bump it when a change would break readers of old records. */
export const RUN_RECORD_SCHEMA_VERSION = 1;

/** Tokens one LLM call consumed, as reported by the API. */
export const TokenUsageSchema = z.strictObject({
  /** Model id exactly as configured and sent in the request; the key into the pricing table. */
  model: z.string().min(1),
  /** Uncached input tokens. */
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWrite5mTokens: count,
  cacheWrite1hTokens: count,
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/** One LLM call as recorded in the run: tokens, what it was for, and what it cost. */
export const LlmUsageSchema = TokenUsageSchema.extend({
  purpose: z.string().min(1),
  costUsd: nonNegative,
});
export type LlmUsage = z.infer<typeof LlmUsageSchema>;

/** How long one execution of a stage took. A stage can run more than once (repair loop). */
export const StageTimingSchema = z.strictObject({
  stage: StageNameSchema,
  durationMs: nonNegative,
  outcome: z.enum(['success', 'failed']),
});
export type StageTiming = z.infer<typeof StageTimingSchema>;

/** Sizes of what the run probed and found. */
export const RunCountsSchema = z.strictObject({
  routesProbed: count,
  endpointsProbed: count,
  rawDiffs: count,
  noiseDiffs: count,
  findings: count,
});
export type RunCounts = z.infer<typeof RunCountsSchema>;

/** Sums over the whole run, derived from `llmUsage` and `computeSeconds`. */
export const RunTotalsSchema = z.strictObject({
  llmCalls: count,
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWrite5mTokens: count,
  cacheWrite1hTokens: count,
  llmCostUsd: nonNegative,
  computeSeconds: nonNegative,
});
export type RunTotals = z.infer<typeof RunTotalsSchema>;

/** Why a run was skipped (e.g. a docs-only PR). */
export const RunSkipSchema = z.strictObject({ reason: z.string().min(1) });
export type RunSkip = z.infer<typeof RunSkipSchema>;

const runRecordBase = z.strictObject({
  schemaVersion: z.literal(RUN_RECORD_SCHEMA_VERSION),
  runId: RunIdSchema,
  /** Git SHA of the bdiff checkout that produced the record. */
  toolVersion: z.string().min(1),
  target: TargetSchema,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  durationMs: nonNegative,
  stageTimings: z.array(StageTimingSchema),
  /** Wall-clock seconds the containers of each side (app and services) ran. */
  computeSeconds: z.strictObject({ base: nonNegative, head: nonNegative }),
  llmUsage: z.array(LlmUsageSchema),
  totals: RunTotalsSchema,
  counts: RunCountsSchema,
  /**
   * The API probe's request set, generated requests included (`source: 'generated'`). Defaults to
   * empty so records written before it existed still read.
   */
  apiRequests: z.array(ApiRequestSchema).default([]),
});

/**
 * The complete, machine-readable record of one run (`run.json`). `failure` is present exactly
 * when the run failed, `skip` exactly when it was skipped.
 */
export const RunRecordSchema = z.discriminatedUnion('status', [
  runRecordBase.extend({ status: z.literal('success') }),
  runRecordBase.extend({ status: z.literal('failed'), failure: FailureRecordSchema }),
  runRecordBase.extend({ status: z.literal('skipped'), skip: RunSkipSchema }),
]);
export type RunRecord = z.infer<typeof RunRecordSchema>;
export type RunStatus = RunRecord['status'];
