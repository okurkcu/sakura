import type { RunRecord } from '@bdiff/core';

import { REPORT_CSP, REPORT_CSS } from './assets.js';
import { html, raw } from './html.js';

/** One run of a batch, with the link to its report (relative to the index). */
export interface BatchEntry {
  readonly record: RunRecord;
  /** e.g. `runs/<id>/report/index.html`; absent when the run has no report. */
  readonly reportHref?: string;
}

/**
 * The index of a batch of runs: one row per run with status, duration, cost, findings and risk,
 * linking to each report. Self-contained like the run report; every value escaped. Pure.
 */
export function batchIndexHtml(entries: readonly BatchEntry[]): string {
  const rows = [...entries].sort((a, b) => (a.record.startedAt < b.record.startedAt ? -1 : 1));
  const failed = rows.filter((entry) => entry.record.status === 'failed').length;
  const page = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}" />
        <title>bdiff · ${String(rows.length)} runs</title>
        <style>
          ${raw(REPORT_CSS)}
        </style>
      </head>
      <body>
        <main>
          <h1>bdiff batch</h1>
          <p class="muted">${String(rows.length)} runs · ${String(failed)} failed</p>
          <table>
            <tr>
              <th>Target</th>
              <th>Status</th>
              <th>Duration</th>
              <th>Cost</th>
              <th>Findings</th>
              <th>Risk</th>
              <th>Report</th>
            </tr>
            ${rows.map(({ record, reportHref }) => {
              const status =
                record.status === 'failed'
                  ? `failed: ${record.failure.code}`
                  : record.status === 'skipped'
                    ? `skipped: ${record.skip.reason}`
                    : 'success';
              return html`<tr>
                <td class="mono">
                  ${record.target.repoUrl}${record.target.prNumber === undefined ? null : ` #${String(record.target.prNumber)}`}<br />
                  <span class="muted">${record.target.baseRef} → ${record.target.headRef}</span>
                </td>
                <td><span class="badge ${record.status}">${status}</span></td>
                <td>${String(Math.round(record.durationMs / 1_000))} s</td>
                <td>$${record.totals.llmCostUsd.toFixed(4)}</td>
                <td>${String(record.counts.findings)}</td>
                <td>
                  ${record.riskLevel === null ? '—' : html`<span class="badge ${record.riskLevel}">${record.riskLevel}</span>`}
                </td>
                <td>${reportHref === undefined ? '—' : html`<a href="${reportHref}">open</a>`}</td>
              </tr>`;
            })}
          </table>
        </main>
      </body>
    </html>`;
  return `${page.toString()}\n`;
}
