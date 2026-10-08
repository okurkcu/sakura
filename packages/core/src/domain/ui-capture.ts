import { z } from 'zod';

import { ProbeErrorSchema } from './probe-error.js';
import { ProbeRunSchema } from './stage.js';

/** A request of the page that got an HTTP error status or no response at all. */
export const FailedRequestSchema = z.strictObject({
  /** Path and query for requests to the app itself, the full URL otherwise. */
  url: z.string().min(1),
  method: z.string().min(1),
  /** HTTP status (400 or more), or `null` when no response arrived. */
  status: z.number().int().nullable(),
  /** Why no response arrived, e.g. `net::ERR_CONNECTION_REFUSED`. */
  failure: z.string().exactOptional(),
});
export type FailedRequest = z.infer<typeof FailedRequestSchema>;

/**
 * What one page looked like and how it behaved in one probe run. Strings are normalized so the
 * base and head apps, served on different ports, compare equal when they behave the same: the
 * app's own origin is removed from URLs, messages and text.
 */
export const UiCaptureSchema = z.strictObject({
  probeRun: ProbeRunSchema,
  /** Route path, e.g. `/login`. */
  route: z.string().startsWith('/'),
  /** HTTP status of the document, or `null` when no response arrived. */
  status: z.number().int().nullable(),
  title: z.string(),
  /** Visible text of the page body, with whitespace normalized. */
  text: z.string(),
  /** Full-page PNG, from `ArtifactPaths.uiScreenshot`; absent when the page could not be captured. */
  screenshot: z.string().min(1).exactOptional(),
  consoleErrors: z.array(z.string()),
  /** Uncaught exceptions in the page, as `Name: message`. */
  pageErrors: z.array(z.string()),
  failedRequests: z.array(FailedRequestSchema),
  /** Requests to other origins, blocked so the page only talks to its own app. Sorted, unique. */
  blockedRequests: z.array(z.string()),
  /**
   * `false` when the network never went quiet (no request waiting for its response for 500 ms)
   * within the route timeout; the page was captured anyway.
   */
  settled: z.boolean(),
  durationMs: z.number().nonnegative(),
  error: ProbeErrorSchema.exactOptional(),
});
export type UiCapture = z.infer<typeof UiCaptureSchema>;
