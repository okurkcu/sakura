import { z } from 'zod';

import { ProbeRunSchema, SideSchema, StageNameSchema } from '../domain/stage.js';
import { TargetSchema } from '../domain/target.js';
import { LlmModeSchema } from '../llm/llm-mode.js';
import { RunIdSchema } from '../metrics/run-id.js';

const at = z.iso.datetime();
const ms = z.number().nonnegative();

/** The run began: what it compares, in which LLM mode, and the process running it. */
export const RunStartedEventSchema = z.strictObject({
  type: z.literal('run-started'),
  at,
  runId: RunIdSchema,
  target: TargetSchema,
  toolVersion: z.string().min(1),
  llmMode: LlmModeSchema,
  /** Process id of the bdiff run, to tell a run in progress from one that was killed. */
  pid: z.number().int().positive(),
});

/** A stage began (a stage can run more than once in the repair loop). */
export const StageStartedEventSchema = z.strictObject({
  type: z.literal('stage-started'),
  at,
  stage: StageNameSchema,
});

/** A stage ended without error, or was left out (`skipped`, 0 ms) by the LLM mode. */
export const StageFinishedEventSchema = z.strictObject({
  type: z.literal('stage-finished'),
  at,
  stage: StageNameSchema,
  durationMs: ms,
  status: z.enum(['success', 'skipped']),
});

/** A stage threw; `code` is the error code (`INTERNAL` for an unexpected error). */
export const StageFailedEventSchema = z.strictObject({
  type: z.literal('stage-failed'),
  at,
  stage: StageNameSchema,
  durationMs: ms,
  code: z.string().min(1),
});

/** One environment side's lane: started, ready (apps answering) or failed. */
export const EnvironmentSideEventSchema = z.strictObject({
  type: z.literal('environment-side'),
  at,
  side: SideSchema,
  status: z.enum(['started', 'ready', 'failed']),
});

/** One page captured (or not) in one probe run. */
export const CaptureEventSchema = z.strictObject({
  type: z.literal('capture'),
  at,
  probeRun: ProbeRunSchema,
  route: z.string(),
  status: z.enum(['ok', 'error']),
  ms,
  /** Pages this probe run captures in all, for progress. */
  total: z.number().int().nonnegative(),
});

/** A log line of level info or above (debug lines stay out). */
export const LogEventSchema = z.strictObject({
  type: z.literal('log'),
  at,
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
  stage: StageNameSchema.exactOptional(),
});

/** The run ended; `run.json` follows. */
export const RunFinishedEventSchema = z.strictObject({
  type: z.literal('run-finished'),
  at,
  status: z.enum(['success', 'failed', 'skipped']),
  durationMs: ms,
  failure: z
    .strictObject({ stage: StageNameSchema.exactOptional(), code: z.string() })
    .exactOptional(),
});

/**
 * One line of `runs/<id>/events.jsonl`: the run's live progress, appended as it happens. Readers
 * (the dev panel) tail the file; `run.json` stays the run's complete record.
 */
export const RunEventSchema = z.discriminatedUnion('type', [
  RunStartedEventSchema,
  StageStartedEventSchema,
  StageFinishedEventSchema,
  StageFailedEventSchema,
  EnvironmentSideEventSchema,
  CaptureEventSchema,
  LogEventSchema,
  RunFinishedEventSchema,
]);
export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventType = RunEvent['type'];

/** Distributes `Omit` over a union, keeping each member's own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before it is stamped with its time. */
export type RunEventInput = DistributiveOmit<RunEvent, 'at'>;

/** The events a stage reports itself (through `StageContext.progress`). */
export type StageProgressEvent = Extract<
  RunEventInput,
  { type: 'capture' } | { type: 'environment-side' }
>;

/** `event` without its timestamp, e.g. to compare events regardless of when they happened. Pure. */
export function withoutTime(event: RunEvent): RunEventInput {
  const copy: Partial<RunEvent> = { ...event };
  delete copy.at;
  return copy as RunEventInput;
}

/**
 * Parses the lines of an `events.jsonl` file. Blank lines are ignored; a line that is not a valid
 * event (e.g. the last one, still being written) is counted in `invalid`. Pure.
 */
export function parseRunEvents(text: string): { events: RunEvent[]; invalid: number } {
  const events: RunEvent[] = [];
  let invalid = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const parsed = safeJson(line);
    const event = parsed === undefined ? undefined : RunEventSchema.safeParse(parsed);
    if (event?.success === true) {
      events.push(event.data);
    } else {
      invalid += 1;
    }
  }
  return { events, invalid };
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}
