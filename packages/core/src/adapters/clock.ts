import { setTimeout as delay } from 'node:timers/promises';

import { abortError } from '../errors/abort.js';

/** Time source. Inject it instead of calling `Date.now()` or `setTimeout` directly. */
export interface Clock {
  /** Current wall-clock time, for timestamps in records. */
  now(): Date;
  /** Monotonic milliseconds, for measuring durations. Only differences are meaningful. */
  monotonicMs(): number;
  /** Resolves after `ms`; rejects with the abort error if `signal` aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The real clock. */
export const systemClock: Clock = {
  now: () => new Date(),
  monotonicMs: () => performance.now(),
  sleep: async (ms, signal) => {
    try {
      await delay(ms, undefined, signal === undefined ? {} : { signal });
    } catch (error) {
      if (signal?.aborted === true) {
        throw abortError(signal);
      }
      throw error;
    }
  },
};
