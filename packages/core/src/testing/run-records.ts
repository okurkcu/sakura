import { FakeClock } from './fake-clock.js';
import type { Target } from '../domain/target.js';
import { createCostCalculator } from '../metrics/pricing.js';
import type { CostCalculator } from '../metrics/pricing.js';
import type { RunId } from '../metrics/run-id.js';
import { createRunRecorder } from '../metrics/run-recorder.js';
import type { RunRecorder } from '../metrics/run-recorder.js';

/** A fixed, valid run id for tests. */
export const TEST_RUN_ID: RunId = '01k6t3y8k0g3m5x9a2b7c4d6ef';

/** A fixed target for tests. */
export const TEST_TARGET: Target = {
  repoUrl: 'https://github.com/acme/shop.git',
  baseRef: 'main',
  headRef: 'pr/api-breaking',
  prNumber: 42,
};

/** Costs for the model `test-model`: $1 / $2 per MTok input / output, $0.1 cache read, $1.25 / $2 cache writes. */
export function createTestCostCalculator(): CostCalculator {
  return createCostCalculator({
    currency: 'USD',
    source: 'https://example.com/pricing',
    retrievedAt: '2026-01-01',
    models: {
      'test-model': {
        tiers: [
          {
            inputPerMTok: 1,
            outputPerMTok: 2,
            cacheReadPerMTok: 0.1,
            cacheWrite5mPerMTok: 1.25,
            cacheWrite1hPerMTok: 2,
          },
        ],
      },
    },
  });
}

/** A {@link RunRecorder} for {@link TEST_RUN_ID} on a {@link FakeClock}, with test pricing. */
export function createTestRunRecorder(overrides: { clock?: FakeClock; target?: Target } = {}): {
  recorder: RunRecorder;
  clock: FakeClock;
} {
  const clock = overrides.clock ?? new FakeClock();
  const recorder = createRunRecorder({
    runId: TEST_RUN_ID,
    target: overrides.target ?? TEST_TARGET,
    toolVersion: 'a'.repeat(40),
    clock,
    costs: createTestCostCalculator(),
  });
  return { recorder, clock };
}
