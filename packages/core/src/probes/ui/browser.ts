import type { ProbeError } from '../../domain/probe-error.js';
import type { FailedRequest } from '../../domain/ui-capture.js';

/** What the browser observed while loading one page. URLs and messages are as the browser saw them. */
export interface PageObservation {
  /** HTTP status of the document, or `null` when no response arrived. */
  readonly status: number | null;
  readonly title: string;
  /** `innerText` of the body, not normalized. */
  readonly text: string;
  /** Whether the full-page screenshot was written to the requested path. */
  readonly screenshotSaved: boolean;
  readonly consoleErrors: readonly string[];
  /** Uncaught exceptions, as `Name: message`. */
  readonly pageErrors: readonly string[];
  /** Subresource requests with an HTTP error status or no response; full URLs. */
  readonly failedRequests: readonly FailedRequest[];
  /** Requests to other origins that were blocked; full URLs. */
  readonly blockedRequests: readonly string[];
  /** `false` when some request was still waiting for its response when the settle budget ran out. */
  readonly settled: boolean;
  /** Set when the page could not be loaded or captured in time. */
  readonly error?: ProbeError;
}

/** Options of one {@link UiBrowser.capture}. */
export interface CaptureOptions {
  /** Where to write the full-page PNG. Its directory exists. */
  readonly screenshotPath: string;
  /** Budget for the whole capture: load, settle, read and screenshot. */
  readonly timeoutMs: number;
}

/** A launched browser. */
export interface UiBrowser {
  /**
   * Loads `url` in a fresh, deterministic browser context that can only reach `url`'s origin,
   * waits for it to settle, then reads it and takes a full-page screenshot. A page that fails to
   * load or times out yields an observation with `error`; only browser-level failures throw.
   */
  capture(url: string, options: CaptureOptions): Promise<PageObservation>;
  /** Closes the browser. Safe to call more than once. */
  close(): Promise<void>;
}

/** Starts browsers. */
export interface UiBrowserLauncher {
  /**
   * @param signal Closes the browser when aborted.
   * @throws BdiffError `BROWSER_UNAVAILABLE` when the browser can't be started.
   */
  launch(signal: AbortSignal): Promise<UiBrowser>;
}
