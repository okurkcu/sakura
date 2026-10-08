import type { UiCapture } from '../domain/ui-capture.js';

/** Something that went wrong while a page loaded. */
export interface RuntimeSignal {
  readonly source: 'page-error' | 'console-error' | 'failed-request';
  /** The error message, or `METHOD url → status|failure` for a request. */
  readonly message: string;
}

/** Signals new in head, once noise is set aside. */
export interface RuntimeDiff {
  readonly signals: RuntimeSignal[];
  /** Signals of head that baseA does not have. */
  readonly raw: number;
  /** Of those, the ones baseB has: they come and go, so they are noise. */
  readonly noise: number;
}

/**
 * The console errors, uncaught page errors and failed requests of head that neither baseA nor
 * baseB had. One seen in baseB but not baseA comes and goes on the same code: noise. Pure.
 */
export function diffRuntime(baseA: UiCapture, baseB: UiCapture, head: UiCapture): RuntimeDiff {
  const [a, b] = [new Set(signalsOf(baseA).map(keyOf)), new Set(signalsOf(baseB).map(keyOf))];
  const fresh = unique(signalsOf(head)).filter((signal) => !a.has(keyOf(signal)));
  const signals = fresh.filter((signal) => !b.has(keyOf(signal)));
  return { signals, raw: fresh.length, noise: fresh.length - signals.length };
}

function signalsOf(capture: UiCapture): RuntimeSignal[] {
  return [
    ...capture.pageErrors.map((message) => ({ source: 'page-error' as const, message })),
    ...capture.consoleErrors.map((message) => ({ source: 'console-error' as const, message })),
    ...capture.failedRequests.map((request) => ({
      source: 'failed-request' as const,
      message: `${request.method} ${request.url} → ${request.status === null ? (request.failure ?? 'failed') : String(request.status)}`,
    })),
  ];
}

function keyOf(signal: RuntimeSignal): string {
  return `${signal.source}\u0000${signal.message}`;
}

function unique(signals: RuntimeSignal[]): RuntimeSignal[] {
  return [...new Map(signals.map((signal) => [keyOf(signal), signal])).values()];
}
