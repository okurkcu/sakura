import type { ErrorCode } from './codes.js';
import type { JsonObject } from '../domain/json.js';
import type { StageName } from '../domain/stage.js';

/** Optional context attached to a {@link BdiffError}. */
export interface BdiffErrorOptions {
  /** Stage that failed. Adapters usually don't know it; the orchestrator fills it in. */
  readonly stage?: StageName;
  /** The underlying error, kept as the standard `Error.cause`. */
  readonly cause?: unknown;
  /** Structured, JSON-serializable context. Must never contain secrets. */
  readonly details?: JsonObject;
}

/** The only error type bdiff code throws on purpose. */
export class BdiffError extends Error {
  override readonly name = 'BdiffError';
  readonly code: ErrorCode;
  readonly stage: StageName | undefined;
  readonly details: JsonObject;

  constructor(code: ErrorCode, message: string, options: BdiffErrorOptions = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.code = code;
    this.stage = options.stage;
    this.details = options.details ?? {};
  }
}

/** Type guard for {@link BdiffError}. */
export function isBdiffError(value: unknown): value is BdiffError {
  return value instanceof BdiffError;
}
