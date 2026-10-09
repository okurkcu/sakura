import type { Clock } from '../adapters/clock.js';
import type { HttpClient } from '../adapters/http.js';
import type { Side } from '../domain/stage.js';
import { throwIfAborted } from '../errors/abort.js';

/** One side to wait for. */
export interface HealthTarget {
  readonly side: Side;
  /** Full URL polled for a 2xx, e.g. `http://127.0.0.1:55012/api/health`. */
  readonly url: string;
  /** Exit code of the app container, or undefined while it runs. */
  readonly exitCode: () => Promise<number | undefined>;
}

/** Why waiting ended. */
export type HealthOutcome =
  | { readonly kind: 'healthy' }
  | { readonly kind: 'exited'; readonly side: Side; readonly exitCode: number }
  | { readonly kind: 'timeout'; readonly side: Side };

/** Inputs of {@link waitUntilHealthy}. */
export interface HealthOptions {
  readonly clock: Clock;
  readonly http: HttpClient;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly intervalMs: number;
  /** Timeout of each health request. */
  readonly requestTimeoutMs: number;
  /** Called once per target when it first answers, e.g. to report progress. */
  readonly onHealthy?: (side: Side) => void;
}

/**
 * Polls every target until all answer with a 2xx (`healthy`), or until the first one fails: its
 * container exits (`exited`, checked before each request, so a broken build is reported at once)
 * or the deadline passes (`timeout`). Every pending target is checked on each tick, so both sides
 * are watched while they build in parallel.
 */
export async function waitUntilHealthy(
  targets: readonly HealthTarget[],
  options: HealthOptions,
): Promise<HealthOutcome> {
  const { clock, http } = options;
  const deadline = clock.monotonicMs() + options.timeoutMs;
  const pending = new Set(targets);

  while (pending.size > 0) {
    throwIfAborted(options.signal);
    for (const target of [...pending]) {
      const exitCode = await target.exitCode();
      if (exitCode !== undefined) {
        return { kind: 'exited', side: target.side, exitCode };
      }
      if (await answers(http, target.url, options)) {
        pending.delete(target);
        options.onHealthy?.(target.side);
      }
    }
    if (pending.size === 0) {
      break;
    }
    const [first] = pending;
    if (first !== undefined && clock.monotonicMs() >= deadline) {
      return { kind: 'timeout', side: first.side };
    }
    await clock.sleep(options.intervalMs, options.signal);
  }
  return { kind: 'healthy' };
}

async function answers(http: HttpClient, url: string, options: HealthOptions): Promise<boolean> {
  try {
    const { status } = await http.get(url, {
      timeoutMs: options.requestTimeoutMs,
      signal: options.signal,
    });
    return status >= 200 && status < 300;
  } catch {
    // Connection refused or a slow answer while the app is still starting: try again next tick.
    throwIfAborted(options.signal);
    return false;
  }
}
