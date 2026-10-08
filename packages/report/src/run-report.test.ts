import { describe, expect, it } from 'vitest';

import { batchIndexHtml } from './batch-index.js';
import { runReportHtml } from './run-report.js';
import type { ReportView } from './run-report.js';
import {
  failedResult,
  fixtureTarget,
  skippedResult,
  successResult,
  TEST_PATHS,
} from './testing/results.js';

const view: ReportView = {
  paths: TEST_PATHS,
  logTails: [],
  logFiles: [TEST_PATHS.log('base'), TEST_PATHS.log('head')],
};

const pages = {
  success: () => runReportHtml(successResult(), view),
  failed: () => runReportHtml(failedResult(), view),
  skipped: () => runReportHtml(skippedResult(), view),
};

/** Everything that would make a browser fetch something from the network. */
const REMOTE_LOADS = [
  /\b(?:src|href|action|poster|srcset|data)\s*=\s*["']?\s*(?:https?:)?\/\//i,
  /url\(\s*["']?\s*(?:https?:)?\/\//i,
  /@import/i,
];

describe('runReportHtml', () => {
  it.each(Object.keys(pages) as (keyof typeof pages)[])(
    'renders the %s fixture run',
    async (state) => {
      await expect(pages[state]()).toMatchFileSnapshot(`./__snapshots__/${state}.html`);
    },
  );

  it.each(Object.keys(pages) as (keyof typeof pages)[])(
    'loads nothing from the network on the %s page',
    (state) => {
      const page = pages[state]();

      for (const pattern of REMOTE_LOADS) {
        expect(page).not.toMatch(pattern);
      }
      expect(page).toContain('default-src &#39;none&#39;');
    },
  );

  it('puts the sections in order, with why first on failed and skipped runs', () => {
    const order = (page: string, headings: string[]) =>
      headings.map((heading) => page.indexOf(heading));
    const success = order(pages.success(), [
      '<h2>Summary',
      'Evidence &amp; coverage',
      '<h2>UI changes',
      '<h2>API changes',
      '<h2>Runtime signals',
      '<h2>Details',
    ]);

    expect(success.every((index) => index >= 0)).toBe(true);
    expect([...success].sort((a, b) => a - b)).toEqual(success);
    expect(pages.failed()).toMatch(
      /<h2>Failed at environment: SETUP_BUILD_FAILED<\/h2>[\s\S]*Error: Expected &quot;}&quot; but found end of file/,
    );
    expect(pages.skipped()).toMatch(
      /<h2>Skipped: docs-only<\/h2>[\s\S]*only changes documentation[\s\S]*modified: README.md/,
    );
  });

  it('links images and logs by paths relative to the report, and findings by anchor', () => {
    const page = pages.success();

    expect(page).toMatch(/<img class="before" src="\.\.\/ui\/baseA\/login-[0-9a-f]{8}\.png"/);
    expect(page).toMatch(/<img class="overlay" src="\.\.\/diff\/ui\/login-[0-9a-f]{8}\.png"/);
    expect(page).toContain('href="../logs/head.log"');
    expect(page).toContain('href="#finding-7c1e4a0b9d2f3e58"');
    expect(page).toContain('id="finding-7c1e4a0b9d2f3e58"');
  });

  it('never links a file outside the run directory', () => {
    const result = successResult();
    const ui = (result.ui ?? []).map((capture) => ({ ...capture, screenshot: '/etc/passwd' }));

    expect(runReportHtml({ ...result, ui }, view)).not.toContain('passwd');
  });

  it('escapes an XSS attempt in the PR title and everywhere else repository content shows', () => {
    const xss = '<img src=x onerror=alert(1)><script>alert(document.cookie)</script>';
    const result = successResult(fixtureTarget({ prTitle: xss, headRef: `pr/${xss}` }));
    const findings = (result.findings ?? []).map((finding) =>
      finding.kind === 'text'
        ? { ...finding, after: [xss] }
        : finding.kind === 'runtime-error'
          ? { ...finding, after: { source: 'console-error', message: xss } }
          : finding,
    );
    const api =
      result.api === undefined
        ? undefined
        : {
            ...result.api,
            captures: result.api.captures.map((capture) =>
              capture.response === undefined
                ? capture
                : {
                    ...capture,
                    response: {
                      ...capture.response,
                      body: { kind: 'json' as const, json: { total: xss }, sha256: 'b'.repeat(64) },
                    },
                  },
            ),
          };
    const workspace =
      result.workspace === undefined
        ? undefined
        : {
            ...result.workspace,
            changedFiles: [{ status: 'modified' as const, path: `app/${xss}.tsx` }],
          };
    const failed = failedResult();
    const failure =
      failed.record.status === 'failed'
        ? { ...failed.record.failure, message: xss, details: { logTail: [xss] } }
        : undefined;

    const pagesWithXss = [
      runReportHtml(
        {
          ...result,
          findings,
          ...(api === undefined ? {} : { api }),
          ...(workspace === undefined ? {} : { workspace }),
        },
        view,
      ),
      runReportHtml(
        {
          ...failed,
          record:
            failure === undefined ? failed.record : { ...failed.record, status: 'failed', failure },
        },
        view,
      ),
    ];

    for (const page of pagesWithXss) {
      expect(page).not.toContain('<script>alert');
      expect(page).not.toContain('<img src=x');
      expect(page).not.toMatch(/<[^>]*\sonerror=/i);
      expect(page).toContain(
        '&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(document.cookie)&lt;/script&gt;',
      );
    }
  });
});

describe('batchIndexHtml', () => {
  it('lists every run with status, duration, cost, findings and risk, linking reports', async () => {
    const page = batchIndexHtml([
      { record: successResult().record, reportHref: 'runs/a/report/index.html' },
      { record: failedResult().record },
      { record: skippedResult().record, reportHref: 'runs/c/report/index.html' },
    ]);

    expect(page).toContain('3 runs · 1 failed');
    expect(page).toContain('failed: SETUP_BUILD_FAILED');
    expect(page).toContain('skipped: docs-only');
    expect(page).toContain('<span class="badge high">high</span>');
    expect(page).toContain('href="runs/a/report/index.html"');
    for (const pattern of REMOTE_LOADS) {
      expect(page).not.toMatch(pattern);
    }
    await expect(page).toMatchFileSnapshot('./__snapshots__/batch-index.html');
  });

  it('escapes run data', () => {
    const record = {
      ...skippedResult().record,
      target: fixtureTarget({ repoUrl: '<script>x</script>' }),
    };

    expect(batchIndexHtml([{ record }])).not.toContain('<script>x');
  });
});
