import type { Clock } from '../adapters/clock.js';
import { BdiffError } from '../errors/bdiff-error.js';
import type { ErrorCode } from '../errors/codes.js';

/**
 * Runs `task` with a fresh abort signal that fires after `timeoutMs` on `clock`. Resolves or
 * rejects with the task; if the timeout wins, rejects with a `BdiffError` of `code` and aborts the
 * task's signal so it can stop.
 */
export async function withTimeout<T>(
  clock: Clock,
  timeoutMs: number,
  code: ErrorCode,
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timedOut = clock.sleep(timeoutMs, controller.signal).then(() => {
    const error = new BdiffError(code, `${label} timed out after ${String(timeoutMs)} ms`, {
      details: { timeoutMs },
    });
    controller.abort(error);
    throw error;
  });
  // When the task wins, aborting below rejects the pending sleep; that rejection is expected.
  timedOut.catch(() => undefined);
  try {
    return await Promise.race([task(controller.signal), timedOut]);
  } finally {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  }
}

/**
 * Settles with `promise`, or rejects with `rejectWith()` as soon as `signal` aborts, whichever is
 * first. A promise that loses the race keeps running; its eventual rejection is ignored because the
 * run has already moved on and cleanup hooks release whatever it held.
 */
export async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  rejectWith: () => Error,
): Promise<T> {
  promise.catch(() => undefined);
  if (signal.aborted) {
    throw rejectWith();
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(rejectWith());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
