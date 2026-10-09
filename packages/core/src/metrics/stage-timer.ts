import type { StageTiming } from './run-record.js';
import type { Clock } from '../adapters/clock.js';
import type { StageName } from '../domain/stage.js';

/** Measures stage durations for the run record. */
export interface StageTimer {
  /**
   * Runs `fn` and records how long it took as a timing for `stage`. The timing is recorded even
   * when `fn` throws; the error is rethrown unchanged.
   */
  measure<T>(stage: StageName, fn: () => Promise<T>): Promise<T>;
  /** Records that `stage` was left out (0 ms, `skipped`), e.g. the interpretation with the LLM off. */
  skip(stage: StageName): void;
  /** Every measured execution so far, in the order they started. */
  timings(): readonly StageTiming[];
}

/** Creates a {@link StageTimer} that reads time from `clock`. */
export function createStageTimer(clock: Clock): StageTimer {
  const timings: StageTiming[] = [];
  return {
    measure: async (stage, fn) => {
      const startedAt = clock.monotonicMs();
      const index = timings.length;
      timings.push({ stage, durationMs: 0, outcome: 'success' });
      const record = (outcome: StageTiming['outcome']) => {
        timings[index] = {
          stage,
          durationMs: Math.round(clock.monotonicMs() - startedAt),
          outcome,
        };
      };
      try {
        const result = await fn();
        record('success');
        return result;
      } catch (error) {
        record('failed');
        throw error;
      }
    },
    skip: (stage) => {
      timings.push({ stage, durationMs: 0, outcome: 'skipped' });
    },
    timings: () => [...timings],
  };
}
