import { BdiffError } from './bdiff-error.js';

/**
 * The error to throw once `signal` has aborted. If the abort reason is already a
 * {@link BdiffError} (e.g. a run timeout), that error is returned unchanged; otherwise an
 * `ABORTED` error wrapping the reason.
 */
export function abortError(signal: AbortSignal): BdiffError {
  const reason: unknown = signal.reason;
  if (reason instanceof BdiffError) {
    return reason;
  }
  return new BdiffError('ABORTED', 'Operation aborted', { cause: reason });
}

/** Throws {@link abortError} if `signal` has already aborted. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError(signal);
  }
}
