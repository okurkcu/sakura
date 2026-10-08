import { describe, expect, it } from 'vitest';

import { systemClock } from './clock.js';
import { BdiffError } from '../errors/bdiff-error.js';

describe('systemClock', () => {
  it('sleeps for roughly the requested time', async () => {
    const start = systemClock.monotonicMs();
    await systemClock.sleep(20);

    expect(systemClock.monotonicMs() - start).toBeGreaterThanOrEqual(15);
  });

  it('rejects with ABORTED when the signal aborts during sleep', async () => {
    const controller = new AbortController();
    const sleeping = systemClock.sleep(10_000, controller.signal);
    controller.abort();

    await expect(sleeping).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('rejects with a BdiffError abort reason unchanged', async () => {
    const reason = new BdiffError('SETUP_TIMEOUT', 'health check timed out');
    const controller = new AbortController();
    controller.abort(reason);

    await expect(systemClock.sleep(10_000, controller.signal)).rejects.toBe(reason);
  });

  it('returns the current wall-clock time', () => {
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1_000);
  });
});
