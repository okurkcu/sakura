import type { CleanupHook } from './stage.js';
import { withTimeout } from './with-timeout.js';
import type { Clock } from '../adapters/clock.js';
import type { Logger } from '../adapters/logger.js';
import { BdiffError } from '../errors/bdiff-error.js';

/** A cleanup hook that failed or timed out. */
export interface CleanupFailure {
  readonly name: string;
  readonly error: unknown;
}

/** Collects cleanup hooks during a run and runs them once at the end. */
export interface CleanupRegistry {
  register(name: string, hook: CleanupHook): void;
  /**
   * Runs every hook in reverse registration order (LIFO). A failing or hanging hook never stops the
   * others. Afterwards the registry is closed: registering throws. Returns the failures.
   */
  runAll(): Promise<CleanupFailure[]>;
}

/** Creates a {@link CleanupRegistry}; each hook gets `hookTimeoutMs` on `clock`. */
export function createCleanupRegistry(
  clock: Clock,
  logger: Logger,
  hookTimeoutMs: number,
): CleanupRegistry {
  const hooks: { name: string; hook: CleanupHook }[] = [];
  let closed = false;

  return {
    register: (name, hook) => {
      if (closed) {
        throw new BdiffError('INTERNAL', `Cleanup hook "${name}" registered after cleanup ran`);
      }
      hooks.push({ name, hook });
    },
    runAll: async () => {
      closed = true;
      const failures: CleanupFailure[] = [];
      for (const { name, hook } of [...hooks].reverse()) {
        try {
          await withTimeout(clock, hookTimeoutMs, 'CLEANUP_FAILED', `Cleanup "${name}"`, hook);
          logger.debug('cleanup done', { hook: name });
        } catch (error) {
          logger.error('cleanup failed', { hook: name, err: error });
          failures.push({ name, error });
        }
      }
      return failures;
    },
  };
}
