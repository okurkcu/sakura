import path from 'node:path';

import { coverageOf } from '@bdiff/core';
import type {
  ApiCapture,
  ApiProbe,
  ArtifactPaths,
  Finding,
  JsonValue,
  RunResult,
  Severity,
  UiCapture,
} from '@bdiff/core';

import { REPORT_CSP, REPORT_CSS, REPORT_SCRIPT } from './assets.js';
import { html, raw } from './html.js';
import type { Html } from './html.js';
import { jsonView } from './json-view.js';

/** The last lines of one log of the run. */
export interface LogTail {
  readonly name: string;
  readonly lines: readonly string[];
}

/** What the report needs besides the run result: where files are, and log excerpts. */
export interface ReportView {
  readonly paths: ArtifactPaths;
  /** Shown on a failed run's page. */
  readonly logTails: readonly LogTail[];
  /** The run's log files (absolute), linked in the details. */
  readonly logFiles: readonly string[];
}

const SEVERITIES: readonly Severity[] = ['breaking', 'warning', 'info'];
const EMPTY_PROBE: ApiProbe = { requests: [], captures: [], notProbed: [] };
const MAX_VALUE_CHARS = 200;

const LLM_MODE_NOTES: Readonly<Record<'off' | 'fake', string>> = {
  off: 'No model was used: the interpretation and setup repair were skipped. Set ANTHROPIC_API_KEY to turn it on.',
  fake: 'Canned answers, no model was called: the interpretation is a placeholder. Set ANTHROPIC_API_KEY for a real one.',
};

const SKIP_REASONS: Readonly<Record<string, string>> = {
  'no-changes': 'The pull request changes no files.',
  'docs-only': 'The pull request only changes documentation.',
  'tests-only': 'The pull request only changes tests.',
  'ci-only': 'The pull request only changes CI configuration.',
  'lockfile-only': 'The pull request only changes lockfiles.',
  'non-runtime-only': 'The pull request only changes documentation, tests, CI or lockfiles.',
};

/**
 * The HTML report of one run: a single self-contained page (inline CSS and script, no remote
 * URLs, images by relative path from `report/`). Sections: header; summary; evidence and coverage;
 * UI changes; API changes; runtime signals; details. A failed or skipped run starts with why.
 * Every value from the run is escaped. Pure: the same result renders the same page.
 */
export function runReportHtml(result: RunResult, view: ReportView): string {
  const { record } = result;
  const findings = result.findings ?? [];
  const page = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta http-equiv="Content-Security-Policy" content="${REPORT_CSP}" />
        <title>bdiff · ${record.target.headRef} · ${record.status}</title>
        <style>
          ${raw(REPORT_CSS)}
        </style>
      </head>
      <body>
        <main>
          ${header(result)} ${outcome(result, view)} ${summary(result, findings)}
          ${coverage(result)} ${uiChanges(result, findings, view)}
          ${apiChanges(result, findings, view)} ${runtimeSignals(findings)} ${details(result, view)}
        </main>
        <script>
          ${raw(REPORT_SCRIPT)};
        </script>
      </body>
    </html>`;
  return `${page.toString()}\n`;
}

function header(result: RunResult): Html {
  const { record, workspace } = result;
  const { target } = record;
  return html`<header>
    <h1>bdiff report <span class="badge ${record.status}">${record.status}</span></h1>
    <dl class="facts">
      <dt>Repository</dt>
      <dd class="mono">${target.repoUrl}</dd>
      ${
        target.prNumber === undefined && target.prTitle === undefined
          ? null
          : html`<dt>Pull request</dt>
              <dd>
                ${target.prNumber === undefined ? null : `#${String(target.prNumber)} `}${target.prTitle}
              </dd>`
      }
      <dt>Base</dt>
      <dd class="mono">
        ${target.baseRef}${workspace === undefined ? null : ` @ ${workspace.baseSha.slice(0, 10)}`}
      </dd>
      <dt>Head</dt>
      <dd class="mono">
        ${target.headRef}${workspace === undefined ? null : ` @ ${workspace.headSha.slice(0, 10)}`}
      </dd>
      <dt>Duration</dt>
      <dd>${duration(record.durationMs)}</dd>
      <dt>Cost</dt>
      <dd>
        LLM ${usd(record.totals.llmCostUsd)} · containers
        ${String(Math.round(record.totals.computeSeconds))} s
      </dd>
      ${runFacts(record)}
    </dl>
  </header>`;
}

/**
 * The run's identity, and its LLM mode when it is not the real model: the reader must know the
 * text is not a model's.
 */
function runFacts(record: RunResult['record']): Html {
  const run = html`<dt>Run</dt>
    <dd class="mono">${record.runId} · ${record.startedAt} · bdiff ${record.toolVersion}</dd>`;
  return record.llmMode === 'on'
    ? run
    : html`${run}
        <dt>LLM</dt>
        <dd>
          <span class="badge warning">llm ${record.llmMode}</span> ${LLM_MODE_NOTES[record.llmMode]}
        </dd>`;
}

/** Why a failed or skipped run ended, first thing on its page. */
function outcome(result: RunResult, view: ReportView): Html | null {
  const { record } = result;
  if (record.status === 'skipped') {
    const reason =
      SKIP_REASONS[record.skip.reason] ?? 'Nothing the pull request changes can be probed.';
    const files = result.workspace?.changedFiles ?? [];
    return html`<section class="callout skipped">
      <h2>Skipped: ${record.skip.reason}</h2>
      <p>${reason} Nothing was built or probed.</p>
      ${
        files.length === 0
          ? null
          : html`<p class="muted">Changed files:</p>
              <pre>${files.map((file) => `${file.status}: ${file.path}\n`)}</pre>`
      }
    </section>`;
  }
  if (record.status === 'failed') {
    const { failure } = record;
    const { logTail, ...details } = failure.details;
    // Container logs explain setup failures only; for any other stage they are noise (and stay
    // linked in the details).
    const tails: readonly LogTail[] =
      failure.stage !== 'environment'
        ? []
        : Array.isArray(logTail)
          ? [
              {
                name: 'log tail',
                lines: logTail.map((line) =>
                  typeof line === 'string' ? line : JSON.stringify(line),
                ),
              },
            ]
          : view.logTails;
    return html`<section class="callout failed">
      <h2>Failed${failure.stage === undefined ? null : ` at ${failure.stage}`}: ${failure.code}</h2>
      <p>${failure.message}</p>
      ${
        Object.keys(details).length === 0
          ? null
          : html`<pre>${JSON.stringify(details, null, 2)}</pre>`
      }
      ${tails.map(
        (tail) =>
          html`<h3>${tail.name}: last ${String(tail.lines.length)} lines</h3>
            <pre>${tail.lines.join('\n')}</pre>`,
      )}
    </section>`;
  }
  return null;
}

function summary(result: RunResult, findings: readonly Finding[]): Html | null {
  const { interpretation } = result;
  if (interpretation === undefined && findings.length === 0) {
    return null;
  }
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const counts = SEVERITIES.map((severity) => {
    const count = findings.filter((finding) => finding.severity === severity).length;
    return count === 0
      ? null
      : html`<span class="badge ${severity}">${String(count)} ${severity}</span> `;
  });
  return html`<section>
    <h2>Summary</h2>
    <p>
      ${
        interpretation === undefined
          ? null
          : html`<span class="badge ${interpretation.riskLevel}"
              >risk: ${interpretation.riskLevel}</span
            >`
      }
      ${counts}${findings.length === 0 ? null : html`<span class="muted">${String(findings.length)} findings</span>`}
    </p>
    ${
      interpretation === undefined
        ? html`<p class="muted">
            ${
              result.record.llmMode === 'off'
                ? 'No interpretation: the LLM was off (--llm off).'
                : 'No interpretation: the run ended before the interpret stage finished.'
            }
          </p>`
        : html`<ul class="summary">
              ${interpretation.summary.map(
                (bullet) =>
                  html`<li>
                    ${bullet.text} ${bullet.findingIds.map((id) => findingLink(byId.get(id), id))}
                  </li>`,
              )}
            </ul>
            ${
              interpretation.unexpected.length === 0
                ? null
                : html`<div class="callout unexpected">
                    <h3>Unexpected for the stated intent</h3>
                    <ul>
                      ${interpretation.unexpected.map(
                        (entry) =>
                          html`<li>
                            ${findingLink(byId.get(entry.findingId), entry.findingId)}
                            ${entry.reason}
                          </li>`,
                      )}
                    </ul>
                  </div>`
            }
            <p><strong>Not verified:</strong> ${interpretation.coverageNote}</p>
            ${
              interpretation.reviewerChecklist.length === 0
                ? null
                : html`<h3>Check by hand</h3>
                    <ul>
                      ${interpretation.reviewerChecklist.map((item) => html`<li>${item}</li>`)}
                    </ul>`
            }
            ${
              interpretation.model === undefined
                ? null
                : html`<p class="muted">Interpreted by ${interpretation.model}.</p>`
            }`
    }
  </section>`;
}

function coverage(result: RunResult): Html | null {
  const { impact, record } = result;
  if (impact === undefined || impact.skip !== undefined) {
    return null;
  }
  const api = result.api ?? EMPTY_PROBE;
  const covered = coverageOf(impact, result.ui ?? [], api);
  return html`<section>
    <h2>Evidence &amp; coverage</h2>
    <p class="muted">
      Stages:
      ${ownTimings(record.stageTimings)
        .map((timing) => `${timing.stage}${timing.outcome === 'failed' ? ' (failed)' : ''}`)
        .join(' → ')}
    </p>
    <dl class="facts">
      <dt>Pages probed</dt>
      <dd class="mono">${covered.pages.length === 0 ? '—' : covered.pages.join(', ')}</dd>
      <dt>Endpoints probed</dt>
      <dd class="mono">${covered.endpoints.length === 0 ? '—' : covered.endpoints.join(', ')}</dd>
      <dt>Impact confidence</dt>
      <dd>${impact.confidence}</dd>
    </dl>
    ${
      covered.gaps.length === 0
        ? html`<p>Everything the change can affect was probed.</p>`
        : html`<h3>Not probed</h3>
            <table>
              <tr>
                <th>What</th>
                <th>Why</th>
              </tr>
              ${covered.gaps.map(
                (gap) =>
                  html`<tr>
                    <td class="mono">${gap.what}</td>
                    <td>${gap.reason}</td>
                  </tr>`,
              )}
            </table>`
    }
    ${
      api.requests.length === 0
        ? null
        : html`<h3>API requests</h3>
            <table>
              <tr>
                <th>Request</th>
                <th>Source</th>
                <th>Description</th>
              </tr>
              ${api.requests.map(
                (request) =>
                  html`<tr>
                    <td class="mono">${request.key}</td>
                    <td>
                      <span class="badge ${request.source === 'generated' ? 'warning' : 'info'}"
                        >${request.source}</span
                      >
                    </td>
                    <td>${request.description}</td>
                  </tr>`,
              )}
            </table>`
    }
  </section>`;
}

function uiChanges(result: RunResult, findings: readonly Finding[], view: ReportView): Html | null {
  const pageFindings = findings.filter(
    (finding) => finding.location.route !== undefined && !isRuntimeSignal(finding),
  );
  const routes = [...new Set(pageFindings.map((finding) => finding.location.route ?? ''))];
  if (routes.length === 0) {
    return null;
  }
  return html`<section>
    <h2>UI changes</h2>
    ${routes.map((route) => {
      const own = pageFindings.filter((finding) => finding.location.route === route);
      const visual = own.find((finding) => finding.kind === 'visual');
      const before = capture(result.ui, 'baseA', route);
      const after = capture(result.ui, 'head', route);
      return html`<div class="ui-route" ${visual === undefined ? null : raw('data-compare')}>
        <h3 class="mono">${route}</h3>
        ${own.map(
          (finding) =>
            html`<div class="finding" id="finding-${finding.id}">
              ${findingHead(finding)} ${pageFindingBody(finding)}
            </div>`,
        )}
        ${
          visual === undefined
            ? null
            : comparison(
                href(before?.screenshot, view),
                href(after?.screenshot, view),
                href(view.paths.diffOverlay(route), view),
              )
        }
      </div>`;
    })}
  </section>`;
}

function comparison(
  before: string | undefined,
  after: string | undefined,
  overlay: string | undefined,
): Html | null {
  if (before === undefined || after === undefined) {
    return null;
  }
  return html`<div class="controls">
      <label
        >Before ◀
        <input type="range" min="0" max="100" value="50" aria-label="Before/after split" /> ▶
        After</label
      >
      ${
        overlay === undefined
          ? null
          : html`<label><input type="checkbox" class="overlay-toggle" /> Show what changed</label>`
      }
    </div>
    <div class="compare">
      <img class="before" src="${before}" alt="Before (base)" />
      <img class="after" src="${after}" alt="After (head)" />
      ${overlay === undefined ? null : html`<img class="overlay" src="${overlay}" alt="Changed pixels" />`}
    </div>`;
}

function pageFindingBody(finding: Finding): Html | null {
  switch (finding.kind) {
    case 'visual': {
      const regions =
        isRecord(finding.after) && Array.isArray(finding.after.regions)
          ? finding.after.regions.length
          : 0;
      return html`<p class="muted">
        ${String(regions)} changed
        region${regions === 1 ? '' : 's'}${
          finding.location.bbox === undefined
            ? null
            : `, within x ${String(finding.location.bbox.x)}, y ${String(finding.location.bbox.y)}, ${String(finding.location.bbox.width)}×${String(finding.location.bbox.height)} px`
        }.
      </p>`;
    }
    case 'text': {
      const removed = Array.isArray(finding.before) ? finding.before : [];
      const added = Array.isArray(finding.after) ? finding.after : [];
      return html`<pre>
${removed.map((line) => html`<span class="line removed">− ${text(line)}</span>`)}${added.map(
          (line) => html`<span class="line added">+ ${text(line)}</span>`,
        )}</pre>`;
    }
    default:
      return beforeAfter(finding);
  }
}

function apiChanges(
  result: RunResult,
  findings: readonly Finding[],
  view: ReportView,
): Html | null {
  const apiFindings = findings.filter((finding) => finding.location.endpoint !== undefined);
  if (apiFindings.length === 0) {
    return null;
  }
  const captures = result.api?.captures ?? [];
  const keyOf = (finding: Finding): string =>
    captures.find((item) => item.artifact === finding.evidence.at(-1))?.requestKey ??
    finding.location.endpoint ??
    '';
  const keys = [...new Set(apiFindings.map(keyOf))];
  return html`<section>
    <h2>API changes</h2>
    ${keys.map((key) => {
      const own = apiFindings.filter((finding) => keyOf(finding) === key);
      const before = apiCapture(captures, 'baseA', key);
      const after = apiCapture(captures, 'head', key);
      const changedPaths = own.flatMap((finding) =>
        finding.location.jsonPath === undefined ? [] : [finding.location.jsonPath],
      );
      return html`<div class="api-request">
        <h3 class="mono">${key}</h3>
        ${own.map(
          (finding) =>
            html`<div class="finding" id="finding-${finding.id}">
              ${findingHead(finding)} ${beforeAfter(finding)}
            </div>`,
        )}
        ${
          before?.response === undefined || after?.response === undefined
            ? null
            : html`<div class="side-by-side">
                <div>
                  <p class="muted">
                    Base · ${String(before.response.status)}${links(before, view)}
                  </p>
                  ${body(before, changedPaths)}
                </div>
                <div>
                  <p class="muted">Head · ${String(after.response.status)}${links(after, view)}</p>
                  ${body(after, changedPaths)}
                </div>
              </div>`
        }
      </div>`;
    })}
  </section>`;
}

function body(item: ApiCapture, changedPaths: readonly string[]): Html {
  const content = item.response?.body;
  switch (content?.kind) {
    case 'json':
      return jsonView(content.json, changedPaths);
    case 'text':
      return html`<pre>${content.text}${content.truncated ? '\n… (cut)' : ''}</pre>`;
    case 'binary':
      return html`<p class="muted">${String(content.bytes)} bytes of binary data</p>`;
    default:
      return html`<p class="muted">Empty body</p>`;
  }
}

function runtimeSignals(findings: readonly Finding[]): Html | null {
  const signals = findings.filter(isRuntimeSignal);
  if (signals.length === 0) {
    return null;
  }
  return html`<section>
    <h2>Runtime signals</h2>
    <table>
      <tr>
        <th>Page</th>
        <th>Severity</th>
        <th>What</th>
        <th>Message</th>
      </tr>
      ${signals.map((finding) => {
        const after = isRecord(finding.after) ? finding.after : {};
        return html`<tr class="finding" id="finding-${finding.id}">
          <td class="mono">${finding.location.route}</td>
          <td><span class="badge ${finding.severity}">${finding.severity}</span></td>
          <td>${typeof after.source === 'string' ? after.source : finding.kind}</td>
          <td class="mono">
            ${typeof after.message === 'string' ? after.message : text(finding.after)}
          </td>
        </tr>`;
      })}
    </table>
  </section>`;
}

function details(result: RunResult, view: ReportView): Html {
  const { record, recipe } = result;
  return html`<section>
    <h2>Details</h2>
    <h3>Stages</h3>
    <table>
      <tr>
        <th>Stage</th>
        <th>Outcome</th>
        <th>Duration</th>
      </tr>
      ${ownTimings(record.stageTimings).map(
        (timing) =>
          html`<tr>
            <td>${timing.stage}</td>
            <td>${timing.outcome}</td>
            <td>${duration(timing.durationMs)}</td>
          </tr>`,
      )}
    </table>
    <h3>LLM usage</h3>
    ${
      record.llmUsage.length === 0
        ? html`<p class="muted">No LLM calls.</p>`
        : html`<table>
            <tr>
              <th>Purpose</th>
              <th>Model</th>
              <th>Input</th>
              <th>Output</th>
              <th>Cache read</th>
              <th>Cost</th>
            </tr>
            ${record.llmUsage.map(
              (usage) =>
                html`<tr>
                  <td>${usage.purpose}</td>
                  <td class="mono">${usage.model}</td>
                  <td>${String(usage.inputTokens)}</td>
                  <td>${String(usage.outputTokens)}</td>
                  <td>${String(usage.cacheReadTokens)}</td>
                  <td>${usd(usage.costUsd)}</td>
                </tr>`,
            )}
          </table>`
    }
    ${
      recipe === undefined
        ? null
        : html`<h3>Recipe</h3>
            <dl class="facts">
              <dt>App</dt>
              <dd class="mono">${recipe.appRoot} (install in ${recipe.installRoot})</dd>
              <dt>Runtime</dt>
              <dd>
                Node ${recipe.nodeVersion}, ${recipe.packageManager.name}
                ${recipe.packageManager.version}
              </dd>
              <dt>Install</dt>
              <dd class="mono">${recipe.installCmd.join(' ')}</dd>
              <dt>Build</dt>
              <dd class="mono">${recipe.buildCmd.join(' ')}</dd>
              <dt>Start</dt>
              <dd class="mono">
                ${recipe.startCmd.join(' ')} (port ${String(recipe.port)}, health
                ${recipe.healthPath})
              </dd>
              <dt>Services</dt>
              <dd>
                ${recipe.services.length === 0 ? 'none' : recipe.services.map((service) => service.kind).join(', ')}
              </dd>
              <dt>Env</dt>
              <dd class="mono">
                ${Object.keys(recipe.env).length === 0 ? 'none' : Object.keys(recipe.env).join(', ')}
              </dd>
              <dt>Confidence</dt>
              <dd>${recipe.confidence}</dd>
            </dl>`
    }
    ${
      view.logFiles.length === 0
        ? null
        : html`<h3>Logs</h3>
            <ul>
              ${view.logFiles.map((file) => {
                const link = href(file, view);
                return link === undefined
                  ? null
                  : html`<li><a href="${link}">${path.basename(file)}</a></li>`;
              })}
            </ul>`
    }
  </section>`;
}

/** The stage timings without the report's own, which is still running while the page renders. */
function ownTimings(
  timings: RunResult['record']['stageTimings'],
): RunResult['record']['stageTimings'] {
  return timings.filter((timing) => timing.stage !== 'report');
}

function findingHead(finding: Finding): Html {
  const where =
    finding.location.jsonPath ?? finding.location.route ?? finding.location.endpoint ?? '';
  return html`<div class="finding-head">
    <span class="badge ${finding.severity}">${finding.severity}</span>
    <strong>${finding.kind}</strong>
    <span class="mono">${where}</span>
  </div>`;
}

function beforeAfter(finding: Finding): Html | null {
  if (finding.before === undefined && finding.after === undefined) {
    return null;
  }
  return html`<p class="mono">
    ${finding.before === undefined ? null : html`<span class="muted">before</span> ${text(finding.before)}`}
    ${finding.after === undefined ? null : html`<span class="muted">after</span> ${text(finding.after)}`}
  </p>`;
}

function findingLink(finding: Finding | undefined, id: string): Html {
  const label =
    finding === undefined
      ? id
      : `${finding.kind} ${finding.location.jsonPath ?? finding.location.route ?? finding.location.endpoint ?? ''}`;
  return html`<a class="badge ${finding?.severity ?? 'info'}" href="#finding-${id}">${label}</a>`;
}

function links(item: ApiCapture, view: ReportView): Html | null {
  const link = href(item.artifact, view);
  return link === undefined ? null : html` · <a href="${link}">raw</a>`;
}

function isRuntimeSignal(finding: Finding): boolean {
  return (
    finding.kind === 'runtime-error' ||
    (finding.kind === 'failed-request' &&
      isRecord(finding.after) &&
      typeof finding.after.source === 'string')
  );
}

function capture(
  ui: readonly UiCapture[] | undefined,
  probeRun: UiCapture['probeRun'],
  route: string,
): UiCapture | undefined {
  return ui?.find((item) => item.probeRun === probeRun && item.route === route);
}

function apiCapture(
  captures: readonly ApiCapture[],
  probeRun: ApiCapture['probeRun'],
  key: string,
): ApiCapture | undefined {
  return captures.find((item) => item.probeRun === probeRun && item.requestKey === key);
}

/**
 * The path of a run file relative to `report/`, URL-encoded; `undefined` for anything outside the
 * run directory, which the report never links.
 */
function href(file: string | undefined, view: ReportView): string | undefined {
  if (file === undefined) {
    return undefined;
  }
  const inRun = path.relative(view.paths.runDir, file);
  if (inRun === '' || inRun.startsWith('..') || path.isAbsolute(inRun)) {
    return undefined;
  }
  return path
    .relative(view.paths.reportDir, file)
    .split(path.sep)
    .map(encodeURIComponent)
    .join('/');
}

function text(value: JsonValue | undefined): string {
  const textValue = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return textValue.length > MAX_VALUE_CHARS ? `${textValue.slice(0, MAX_VALUE_CHARS)}…` : textValue;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function duration(ms: number): string {
  if (ms < 1_000) {
    return `${String(Math.round(ms))} ms`;
  }
  const seconds = Math.round(ms / 1_000);
  return seconds < 60
    ? `${String(seconds)} s`
    : `${String(Math.floor(seconds / 60))} min ${String(seconds % 60)} s`;
}

function usd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}
