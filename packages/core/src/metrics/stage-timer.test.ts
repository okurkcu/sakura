import { describe, expect, it } from 'vitest';

import { createStageTimer } from './stage-timer.js';
import { BdiffError } from '../errors/bdiff-error.js';
import { FakeClock } from '../testing/fake-clock.js';

describe('createStageTimer', () => {
  it('records the duration of a successful stage and returns its result', async () => {
    const clock = new FakeClock();
    const timer = createStageTimer(clock);

    const result = await timer.measure('workspace', () => {
      clock.advance(1_250);
      return Promise.resolve('ok');
    });

    expect(result).toBe('ok');
    expect(timer.timings()).toEqual([
      { stage: 'workspace', durationMs: 1_250, outcome: 'success' },
    ]);
  });

  it('records the duration of a throwing stage and rethrows the same error', async () => {
    const clock = new FakeClock();
    const timer = createStageTimer(clock);
    const failure = new BdiffError('SETUP_UNSUPPORTED', 'no Next.js app found');

    await expect(
      timer.measure('recipe', () => {
        clock.advance(300);
        return Promise.reject(failure);
      }),
    ).rejects.toBe(failure);
    expect(timer.timings()).toEqual([{ stage: 'recipe', durationMs: 300, outcome: 'failed' }]);
  });

  it('keeps executions in start order, including repeats of a stage', async () => {
    const clock = new FakeClock();
    const timer = createStageTimer(clock);

    await timer
      .measure('environment', () => {
        clock.advance(10);
        return Promise.reject(new Error('build failed'));
      })
      .catch(() => undefined);
    await timer.measure('environment', () => {
      clock.advance(20);
      return Promise.resolve();
    });

    expect(timer.timings()).toEqual([
      { stage: 'environment', durationMs: 10, outcome: 'failed' },
      { stage: 'environment', durationMs: 20, outcome: 'success' },
    ]);
  });

  it('returns a copy, not its internal list', async () => {
    const timer = createStageTimer(new FakeClock());
    await timer.measure('diff', () => Promise.resolve());

    const snapshot = timer.timings();
    await timer.measure('report', () => Promise.resolve());

    expect(snapshot).toHaveLength(1);
  });
});
