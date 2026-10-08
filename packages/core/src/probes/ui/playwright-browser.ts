import { setTimeout as delay } from 'node:timers/promises';

import { chromium, errors } from 'playwright';
import type { Browser, BrowserContext, Page, Request } from 'playwright';

import type { CaptureOptions, PageObservation, UiBrowserLauncher } from './browser.js';
import type { ProbeError } from '../../domain/probe-error.js';
import type { FailedRequest } from '../../domain/ui-capture.js';
import { abortError, throwIfAborted } from '../../errors/abort.js';
import { BdiffError } from '../../errors/bdiff-error.js';

/** The time every page's `Date` starts at, so client-rendered times match between captures. */
export const CAPTURE_TIME = Date.UTC(2025, 0, 1, 12);

/** The command that installs the browser bdiff uses. */
export const BROWSER_INSTALL_COMMAND = 'pnpm browser:install';

const VIEWPORT = { width: 1280, height: 800 } as const;
const LAUNCH_TIMEOUT_MS = 60_000;
/** How long no request may wait for its response before the network counts as quiet. */
const QUIET_MS = 500;
const QUIET_POLL_MS = 50;
/** Most of the capture budget kept for reading and the screenshot when the network never idles. */
const MAX_CAPTURE_RESERVE_MS = 10_000;
const CLOSE_TIMEOUT_MS = 10_000;

/** Freezes CSS animations and transitions at their end state and hides the text caret. */
const FREEZE_CSS =
  '*,*::before,*::after{animation-delay:0s!important;animation-duration:0s!important;' +
  'transition-delay:0s!important;transition-duration:0s!important;' +
  'caret-color:transparent!important;scroll-behavior:auto!important}';

/**
 * Starts `Date` at {@link CAPTURE_TIME} in every document and lets it run on from there. Timers
 * and `performance` stay native. Playwright's own clock (`page.clock`) is not used: it runs timers
 * through its controller, which reports an exception thrown in a timer callback as a console
 * message instead of an uncaught page error.
 */
const CLOCK_SCRIPT = `(() => {
  const RealDate = Date;
  const offset = ${String(CAPTURE_TIME)} - RealDate.now();
  const now = () => RealDate.now() + offset;
  function FakeDate(...args) {
    if (new.target === undefined) return new RealDate(now()).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [now()] : args, new.target);
  }
  Object.setPrototypeOf(FakeDate, RealDate);
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = now;
  Object.defineProperty(RealDate.prototype, 'constructor', {
    value: FakeDate, writable: true, configurable: true,
  });
  globalThis.Date = FakeDate;
})();`;

/** Options of {@link createPlaywrightLauncher}. */
export interface PlaywrightLauncherOptions {
  /** Pause after the page settled and fonts loaded, before reading it. Default 500 ms. */
  readonly settleMs?: number;
}

/**
 * {@link UiBrowserLauncher} over Playwright's headless Chromium, sandbox on. Each capture gets a
 * new context with fixed viewport (1280×800, scale 1), locale `en-US`, time zone UTC, reduced
 * motion, light color scheme, blocked service workers and downloads, `Date` starting at
 * {@link CAPTURE_TIME}, and CSS that freezes animations (the page's CSP is bypassed so that CSS
 * always applies). Requests and WebSockets to any origin but the page's own are blocked: pages come
 * from untrusted repositories, and must not reach the internet or other services on the host.
 */
export function createPlaywrightLauncher(
  options: PlaywrightLauncherOptions = {},
): UiBrowserLauncher {
  const settleMs = options.settleMs ?? 500;
  return {
    launch: async (signal) => {
      throwIfAborted(signal);
      let browser: Browser;
      try {
        browser = await chromium.launch({ chromiumSandbox: true, timeout: LAUNCH_TIMEOUT_MS });
      } catch (error) {
        throw new BdiffError(
          'BROWSER_UNAVAILABLE',
          launchFailureMessage(error instanceof Error ? error.message : String(error)),
          { cause: error },
        );
      }
      if (signal.aborted) {
        await browser.close();
        throw abortError(signal);
      }
      const closeOnAbort = (): void => {
        // Fire and forget: the stage's own close() (in finally, and its cleanup hook) awaits the
        // same close and reports a failure.
        void browser.close().catch(() => undefined);
      };
      signal.addEventListener('abort', closeOnAbort, { once: true });
      let closed = false;
      return {
        capture: async (url, captureOptions) => {
          throwIfAborted(signal);
          try {
            const observation = await capturePage(browser, url, captureOptions, settleMs);
            // An abort closes the browser mid-capture, which can look like a page error.
            throwIfAborted(signal);
            return observation;
          } catch (error) {
            if (signal.aborted) {
              throw abortError(signal);
            }
            throw new BdiffError('PROBE_FAILED', 'The browser failed', { cause: error });
          }
        },
        close: async () => {
          if (closed) {
            return;
          }
          closed = true;
          signal.removeEventListener('abort', closeOnAbort);
          const timedOut = await Promise.race([
            browser.close().then(() => false),
            delay(CLOSE_TIMEOUT_MS, true, { ref: false }),
          ]);
          if (timedOut) {
            throw new BdiffError(
              'PROBE_FAILED',
              `Chromium did not close within ${String(CLOSE_TIMEOUT_MS)} ms`,
            );
          }
        },
      };
    },
  };
}

/**
 * Explains why Chromium did not start, from Playwright's launch error. The sandbox is never turned
 * off to work around a failure: the pages bdiff loads come from untrusted repositories. Pure.
 */
export function launchFailureMessage(errorMessage: string): string {
  if (errorMessage.includes("Executable doesn't exist")) {
    return `Chromium for Playwright is not installed; run \`${BROWSER_INSTALL_COMMAND}\``;
  }
  if (errorMessage.includes('No usable sandbox')) {
    return (
      'Chromium could not start its sandbox; on Ubuntu 23.10+ allow unprivileged user namespaces ' +
      '(see "Chromium sandbox on Linux" in docs/cli.md)'
    );
  }
  return 'Could not start Chromium';
}

/**
 * One capture. Page-level problems (timeouts, navigation errors) become `error`; anything that
 * happens once the browser itself is gone is rethrown.
 */
async function capturePage(
  browser: Browser,
  url: string,
  { screenshotPath, timeoutMs }: CaptureOptions,
  settleMs: number,
): Promise<PageObservation> {
  const deadline = performance.now() + timeoutMs;
  const remaining = (): number => Math.max(1, Math.round(deadline - performance.now()));
  // A page that keeps polling never goes quiet; keep part of the budget to capture it anyway.
  const reserveMs = Math.min(MAX_CAPTURE_RESERVE_MS, timeoutMs / 3);
  const origin = new URL(url).origin;
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    colorScheme: 'light',
    serviceWorkers: 'block',
    acceptDownloads: false,
    bypassCSP: true,
  });
  try {
    const page = await context.newPage();
    const observed = await observe(page, context, origin);
    await context.addInitScript({ content: CLOCK_SCRIPT });

    let status: number | null = null;
    let settled = false;
    let screenshotSaved = false;
    let title = '';
    let text = '';
    let error: ProbeError | undefined;
    try {
      const response = await page.goto(url, { waitUntil: 'load', timeout: remaining() });
      status = response?.status() ?? null;
      await page.addStyleTag({ content: FREEZE_CSS });
      settled = await observed.waitForQuiet(Math.max(1, remaining() - reserveMs));
      await page.waitForFunction("document.fonts.status === 'loaded'", undefined, {
        timeout: remaining(),
      });
      await page.waitForTimeout(Math.min(settleMs, remaining()));
      title = await page.title();
      text = await page.evaluate<string>("document.body?.innerText ?? ''");
      await page.screenshot({
        path: screenshotPath,
        fullPage: true,
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
        timeout: remaining(),
      });
      screenshotSaved = true;
    } catch (cause) {
      if (!browser.isConnected()) {
        throw cause;
      }
      error = {
        code: cause instanceof errors.TimeoutError ? 'PROBE_TIMEOUT' : 'PROBE_FAILED',
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
    return {
      status,
      title,
      text,
      screenshotSaved,
      settled,
      ...observed.snapshot(),
      ...(error === undefined ? {} : { error }),
    };
  } finally {
    // Fails only when the browser is already gone (an abort); closing the browser reports that.
    await context.close().catch(() => undefined);
  }
}

/** What {@link observe} watches on a page. */
interface PageWatch {
  /**
   * Resolves `true` once no request has waited for its response for {@link QUIET_MS}, or `false`
   * after `timeoutMs`. Unlike Playwright's `networkidle`, a request whose response arrived but
   * whose body is still open (unread by the page, or streamed) does not count: such a request may
   * never finish.
   */
  waitForQuiet(timeoutMs: number): Promise<boolean>;
  snapshot(): Pick<
    PageObservation,
    'consoleErrors' | 'pageErrors' | 'failedRequests' | 'blockedRequests'
  >;
}

/**
 * Blocks other origins, then watches a page's requests and records its errors, failed and blocked
 * requests. Resolves once the blocking routes are in place, so it must be awaited before
 * navigating.
 */
async function observe(page: Page, context: BrowserContext, origin: string): Promise<PageWatch> {
  const waiting = new Set<Request>();
  let lastActivity = performance.now();
  const settle = (request: Request): void => {
    waiting.delete(request);
    lastActivity = performance.now();
  };
  page.on('request', (request) => {
    waiting.add(request);
    lastActivity = performance.now();
  });
  page.on('response', (response) => {
    settle(response.request());
  });
  page.on('requestfailed', settle);

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: FailedRequest[] = [];
  const blocked = new Set<string>();
  const isDocument = (request: Request): boolean =>
    request.isNavigationRequest() && request.frame() === page.mainFrame();

  const host = new URL(origin).host;
  await context.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    if (URL.parse(requestUrl)?.origin === origin) {
      await route.continue();
    } else {
      blocked.add(requestUrl);
      await route.abort('blockedbyclient');
    }
  });
  await context.routeWebSocket(
    (wsUrl) => wsUrl.host !== host,
    async (ws) => {
      blocked.add(ws.url());
      await ws.close();
    },
  );
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(`${error.name}: ${error.message}`);
  });
  page.on('response', (response) => {
    const request = response.request();
    if (response.status() >= 400 && !isDocument(request)) {
      failedRequests.push({
        url: request.url(),
        method: request.method(),
        status: response.status(),
      });
    }
  });
  page.on('requestfailed', (request) => {
    if (!blocked.has(request.url()) && !isDocument(request)) {
      failedRequests.push({
        url: request.url(),
        method: request.method(),
        status: null,
        failure: request.failure()?.errorText ?? 'failed',
      });
    }
  });
  return {
    waitForQuiet: async (timeoutMs) => {
      const deadline = performance.now() + timeoutMs;
      while (!page.isClosed() && performance.now() < deadline) {
        if (waiting.size === 0 && performance.now() - lastActivity >= QUIET_MS) {
          return true;
        }
        await delay(QUIET_POLL_MS);
      }
      return false;
    },
    snapshot: () => ({
      consoleErrors: [...consoleErrors],
      pageErrors: [...pageErrors],
      failedRequests: [...failedRequests],
      blockedRequests: [...blocked].sort(),
    }),
  };
}
