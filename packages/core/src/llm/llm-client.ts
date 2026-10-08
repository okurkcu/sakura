import type { ZodType } from 'zod';

import type { LlmUsage } from '../metrics/run-record.js';
import type { StageContext } from '../pipeline/stage.js';

/** Which model class a call needs: `fast` (cheap, default) or `smart` (hard cases). */
export type LlmTier = 'fast' | 'smart';

/** One turn of an LLM conversation. */
export interface LlmMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** A structured LLM call: the answer must be JSON matching `schema`. */
export interface LlmRequest<T> {
  /** What the call is for (e.g. `interpret`); recorded with its usage and used by fakes. */
  readonly purpose: string;
  /** Static instructions; cached, so keep run-specific data out of it. */
  readonly system: string;
  /** The conversation; must end with a user turn. */
  readonly messages: readonly LlmMessage[];
  /** Shape of the answer. Validated on every response; it is also sent as the output format. */
  readonly schema: ZodType<T>;
  readonly tier: LlmTier;
  /** Output limit, thinking included (current models always think a little). */
  readonly maxOutputTokens: number;
}

/** A validated answer and what it cost. */
export interface LlmResponse<T> {
  readonly data: T;
  /** Usage of the call that produced `data`; every call, retries included, is also recorded. */
  readonly usage: LlmUsage;
}

/** The run services an LLM call needs: budget, usage recording, abort and logging. */
export type LlmCallContext = Pick<StageContext, 'budget' | 'recordLlmUsage' | 'signal' | 'logger'>;

/**
 * The only way bdiff talks to an LLM. Every call is budget-checked before it is sent and its usage
 * recorded; answers are validated against the request's schema (one retry with the validation
 * problem, then `LLM_INVALID_OUTPUT`).
 */
export interface LlmClient {
  /**
   * @throws BdiffError `BUDGET_EXCEEDED`, `LLM_INVALID_OUTPUT`, `LLM_REFUSED`, `LLM_UNAVAILABLE`
   *   (no credentials), `LLM_REQUEST_FAILED`, or the abort error of `ctx.signal`.
   */
  complete<T>(request: LlmRequest<T>, ctx: LlmCallContext): Promise<LlmResponse<T>>;
}
