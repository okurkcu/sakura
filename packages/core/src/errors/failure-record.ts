import { z } from 'zod';

import { BdiffError } from './bdiff-error.js';
import { ErrorCodeSchema } from './codes.js';
import { JsonObjectSchema } from '../domain/json.js';
import { StageNameSchema } from '../domain/stage.js';
import type { StageName } from '../domain/stage.js';

/** Deepest `cause` chain recorded; guards against cycles and runaway nesting. */
const MAX_CAUSE_DEPTH = 10;

/** One link of an error's `cause` chain. */
export const FailureCauseSchema = z.object({ name: z.string(), message: z.string() });
export type FailureCause = z.infer<typeof FailureCauseSchema>;

/** Serializable description of why a run failed, as stored in `run.json`. */
export const FailureRecordSchema = z.object({
  code: ErrorCodeSchema,
  stage: StageNameSchema.exactOptional(),
  message: z.string(),
  details: JsonObjectSchema,
  causes: z.array(FailureCauseSchema),
});
export type FailureRecord = z.infer<typeof FailureRecordSchema>;

/**
 * Turns any thrown value into a {@link FailureRecord}. Non-bdiff errors become `INTERNAL`.
 *
 * @param error - The caught value; may be anything.
 * @param stage - Stage that was running, used when the error doesn't carry its own.
 */
export function toFailureRecord(error: unknown, stage?: StageName): FailureRecord {
  if (error instanceof BdiffError) {
    const recordStage = error.stage ?? stage;
    return {
      code: error.code,
      ...(recordStage === undefined ? {} : { stage: recordStage }),
      message: error.message,
      details: error.details,
      causes: causeChain(error.cause),
    };
  }
  return {
    code: 'INTERNAL',
    ...(stage === undefined ? {} : { stage }),
    message: error instanceof Error ? `${error.name}: ${error.message}` : describe(error),
    details: {},
    causes: error instanceof Error ? causeChain(error.cause) : [],
  };
}

function causeChain(cause: unknown): FailureCause[] {
  const chain: FailureCause[] = [];
  let current = cause;
  while (current !== undefined && chain.length < MAX_CAUSE_DEPTH) {
    if (current instanceof Error) {
      chain.push({ name: current.name, message: current.message });
      current = current.cause;
    } else {
      chain.push({ name: typeof current, message: describe(current) });
      current = undefined;
    }
  }
  return chain;
}

function describe(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  // JSON.stringify yields undefined (not a string) for these.
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    // Not serializable (circular, BigInt): fall back to the tag, which never throws.
    return Object.prototype.toString.call(value);
  }
}
