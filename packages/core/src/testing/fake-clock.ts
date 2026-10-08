import type { Clock } from '../adapters/clock.js';
import { abortError } from '../errors/abort.js';

interface Sleeper {
  readonly wakeAtMs: number;
  readonly resolve: () => void;
}

/** Default start time of a {@link FakeClock}. */
export const FAKE_CLOCK_START = new Date('2026-01-01T00:00:00.000Z');

/**
 * Manually driven {@link Clock}. Time only moves when a test calls {@link FakeClock.advance}, which
 * wakes every sleeper whose deadline has passed, in deadline order.
 */
export class FakeClock implements Clock {
  #wallMs: number;
  #monotonicMs = 0;
  #sleepers: Sleeper[] = [];

  constructor(start: Date = FAKE_CLOCK_START) {
    this.#wallMs = start.getTime();
  }

  now(): Date {
    return new Date(this.#wallMs);
  }

  monotonicMs(): number {
    return this.#monotonicMs;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      return Promise.reject(abortError(signal));
    }
    if (ms <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const sleeper: Sleeper = {
        wakeAtMs: this.#monotonicMs + ms,
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        this.#sleepers = this.#sleepers.filter((other) => other !== sleeper);
        if (signal !== undefined) {
          reject(abortError(signal));
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#sleepers.push(sleeper);
    });
  }

  /** Moves both clocks forward by `ms` and wakes sleepers that are now due. */
  advance(ms: number): void {
    this.#wallMs += ms;
    this.#monotonicMs += ms;
    const due = this.#sleepers
      .filter((sleeper) => sleeper.wakeAtMs <= this.#monotonicMs)
      .sort((a, b) => a.wakeAtMs - b.wakeAtMs);
    this.#sleepers = this.#sleepers.filter((sleeper) => !due.includes(sleeper));
    for (const sleeper of due) {
      sleeper.resolve();
    }
  }

  /** Sets the wall clock. The monotonic clock is unaffected, like a real clock adjustment. */
  set(date: Date): void {
    this.#wallMs = date.getTime();
  }

  /** Number of `sleep` calls still waiting. */
  get pendingSleeps(): number {
    return this.#sleepers.length;
  }
}
