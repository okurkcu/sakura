import { createLogger, nodeFileSystem, systemClock } from '@bdiff/core';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDemoRunSource } from './demo-source.js';
import { startPanelServer } from './server.js';
import type { PanelServer } from './server.js';
import { ensureWebBuild, PANEL_PATHS } from './web-build.js';

/**
 * Smoke test of `bdiff ui --demo` in a real Chromium: the built UI against the bundled demo data,
 * without Docker or an API key.
 */
describe('panel with demo data', () => {
  let server: PanelServer;
  let browser: Browser;

  beforeAll(async () => {
    const logger = createLogger({ level: 'warn' });
    await ensureWebBuild({
      fs: nodeFileSystem,
      logger,
      sourceDir: PANEL_PATHS.webSource,
      outDir: PANEL_PATHS.webDist,
      sharedFiles: PANEL_PATHS.sharedSources,
    });
    server = await startPanelServer(
      {
        source: createDemoRunSource({
          fs: nodeFileSystem,
          clock: systemClock,
          root: PANEL_PATHS.demo,
          replayMs: 20_000,
          pauseMs: 5_000,
        }),
        fs: nodeFileSystem,
        clock: systemClock,
        logger,
        demo: true,
        toolVersion: 'test',
        llmMode: 'off',
        webRoot: PANEL_PATHS.webDist,
        expectedFile: new URL('../../../../fixtures/expected.json', import.meta.url).pathname,
        docker: {
          status: () => Promise.reject(new Error('demo needs no Docker')),
          leftovers: () => Promise.reject(new Error('demo needs no Docker')),
        },
        experiment: () => ({
          setup: { attempted: 4, succeeded: 3, rate: 0.75 },
          durationMs: { count: 4, median: 90_000 },
          llmCostUsd: { count: 4, median: 0 },
          targets: { setupRate: 0.5, medianDurationMs: 600_000 },
        }),
      },
      0,
    );
    browser = await chromium.launch({ chromiumSandbox: true });
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  /** Pages opened by the current test and the errors they had (scripts, failed requests). */
  let errors: string[] = [];

  beforeEach(() => {
    errors = [];
  });

  afterEach(() => {
    expect(errors).toEqual([]);
  });

  async function open(path: string, width = 1280): Promise<Page> {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('requestfailed', (request) => {
      // Event streams are cut when the page closes; that is not an error.
      if (!request.url().endsWith('/events')) {
        errors.push(`${request.failure()?.errorText ?? 'failed'}: ${request.url()}`);
      }
    });
    await page.goto(`${server.url}${path}`);
    return page;
  }

  it('shows the runs, the metric cards and a live run that updates without reload', async () => {
    const page = await open('/#/runs');

    await page.locator('main h1', { hasText: 'Runs' }).waitFor();
    await page.getByText('Demo data').first().waitFor();
    expect(await page.locator('.metric').count()).toBe(4);
    const live = page.getByRole('region', { name: 'Running now' });
    await live.waitFor();
    const before = await live.locator('.logs').textContent();
    await page.waitForFunction(
      (text) => document.querySelector('.live-run .logs')?.textContent !== text,
      before,
      { timeout: 10_000 },
    );
    expect(await page.locator('table.runs tbody tr').count()).toBeGreaterThanOrEqual(5);
    await page.close();
  });

  it('opens a run: timeline, API or page changes and the intent check', async () => {
    const page = await open('/#/runs');
    await page.locator('table.runs tbody tr', { hasText: 'pr/api-breaking' }).first().click();

    await page.getByRole('region', { name: 'Stage timeline' }).waitFor();
    await page.getByRole('region', { name: 'API changes' }).getByText('BREAKING').first().waitFor();
    await page.getByRole('region', { name: 'Intent check' }).waitFor();
    await page.close();
  });

  it('shows the fixture check with a score and every check', async () => {
    const page = await open('/#/fixture');

    await page.locator('main h1', { hasText: 'Fixture check' }).waitFor();
    await page.locator('.check').first().waitFor();
    expect(await page.locator('.check').count()).toBe(6);
    expect(await page.getByRole('button', { name: 'Re-run suite' }).isDisabled()).toBe(true);
    await page.close();
  });

  it.each(['/#/runs', '/#/fixture'])(
    'stacks at phone width without sideways scrolling: %s',
    async (path) => {
      const page = await open(path, 390);
      await page.locator('main h1').waitFor();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );

      expect(overflow).toBeLessThanOrEqual(0);
      await page.close();
    },
  );
});
