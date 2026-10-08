import path from 'node:path';

import type { PageObservation, UiBrowserLauncher } from './browser.js';
import { appRelativeUrl, errorSummary, normalizeVisibleText, stripOrigin } from './normalize.js';
import type { FileSystem } from '../../adapters/file-system.js';
import type { RunningEnvironment } from '../../domain/environment.js';
import type { ImpactPlan } from '../../domain/impact.js';
import type { ProbeRun } from '../../domain/stage.js';
import type { UiCapture } from '../../domain/ui-capture.js';
import { abortError, throwIfAborted } from '../../errors/abort.js';
import type { Stage } from '../../pipeline/stage.js';

/** Default budget for capturing one page. */
export const DEFAULT_ROUTE_TIMEOUT_MS = 30_000;

/** Capture passes, in order: the base app twice (to tell noise from change), then head. */
export const PROBE_RUNS: readonly ProbeRun[] = ['baseA', 'baseB', 'head'];

/** Dependencies of the UI probe stage. */
export interface UiProbeStageDeps {
  readonly browser: UiBrowserLauncher;
  readonly fs: FileSystem;
  readonly routeTimeoutMs?: number;
}

/**
 * The UI probe stage: captures every page of the impact plan on `baseA`, then `baseB`, then
 * `head`, one page at a time in one browser. A page that fails or times out is recorded with an
 * `error` and the stage goes on; an abort or a browser failure stops it. The browser is closed
 * when the stage ends, and by a cleanup hook registered as soon as it is running.
 */
export function createUiProbeStage(
  deps: UiProbeStageDeps,
): Stage<{ environment: RunningEnvironment; impact: ImpactPlan }, UiCapture[]> {
  const timeoutMs = deps.routeTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS;
  return {
    name: 'probe-ui',
    run: async ({ environment, impact }, ctx) => {
      if (impact.pages.length === 0) {
        ctx.logger.info('no pages to capture');
        return [];
      }
      // launch() closes the browser itself when the run is aborted while it starts.
      const browser = await deps.browser.launch(ctx.signal);
      ctx.onCleanup('browser', () => browser.close());
      try {
        const captures: UiCapture[] = [];
        for (const probeRun of PROBE_RUNS) {
          const origin = environment.sides[probeRun === 'head' ? 'head' : 'base'].url;
          for (const route of impact.pages) {
            throwIfAborted(ctx.signal);
            const screenshotPath = ctx.paths.uiScreenshot(probeRun, route.path);
            await deps.fs.mkdir(path.dirname(screenshotPath));
            const started = ctx.clock.monotonicMs();
            let observation: PageObservation;
            try {
              observation = await browser.capture(new URL(route.path, origin).href, {
                screenshotPath,
                timeoutMs,
              });
            } catch (error) {
              throw ctx.signal.aborted ? abortError(ctx.signal) : error;
            }
            const capture = toUiCapture({
              probeRun,
              route: route.path,
              origin,
              observation,
              screenshotPath,
              durationMs: ctx.clock.monotonicMs() - started,
            });
            ctx.logger.info('page captured', {
              probeRun,
              route: capture.route,
              status: capture.status,
              settled: capture.settled,
              durationMs: capture.durationMs,
              ...(capture.error === undefined ? {} : { error: capture.error.code }),
            });
            captures.push(capture);
          }
        }
        ctx.addCounts({ routesProbed: impact.pages.length });
        return captures;
      } finally {
        await browser.close();
      }
    },
  };
}

/**
 * Turns what the browser saw into a {@link UiCapture}: normalizes the text, and removes the app's
 * origin from URLs, messages and text so base and head (on different ports) compare equal. Pure.
 */
export function toUiCapture(input: {
  probeRun: ProbeRun;
  route: string;
  origin: string;
  observation: PageObservation;
  screenshotPath: string;
  durationMs: number;
}): UiCapture {
  const { observation: seen, origin } = input;
  return {
    probeRun: input.probeRun,
    route: input.route,
    status: seen.status,
    title: stripOrigin(seen.title, origin),
    text: normalizeVisibleText(stripOrigin(seen.text, origin)),
    ...(seen.screenshotSaved ? { screenshot: input.screenshotPath } : {}),
    consoleErrors: seen.consoleErrors.map((message) => stripOrigin(message, origin)),
    pageErrors: seen.pageErrors.map((message) => stripOrigin(message, origin)),
    failedRequests: seen.failedRequests.map((request) => ({
      ...request,
      url: appRelativeUrl(request.url, origin),
      ...(request.failure === undefined ? {} : { failure: stripOrigin(request.failure, origin) }),
    })),
    blockedRequests: [...new Set(seen.blockedRequests)].sort(),
    settled: seen.settled,
    durationMs: Math.max(0, input.durationMs),
    ...(seen.error === undefined
      ? {}
      : { error: { code: seen.error.code, message: errorSummary(seen.error.message, origin) } }),
  };
}
