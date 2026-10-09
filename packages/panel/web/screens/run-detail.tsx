import type {
  ApiCapture,
  Finding,
  LlmMode,
  RunEvent,
  RunRecord,
  RunResult,
  UiCapture,
} from '@bdiff/core';
import { useState } from 'preact/hooks';

import type { RunDetailResponse, RunSummary } from '../../src/api.js';
import { runFileUrl } from '../../src/paths.js';
import { Command, Status, Tag } from '../components/common.js';
import type { Loaded } from '../lib/data.js';
import { useNow, useRunEvents } from '../lib/data.js';
import { clock, refs, repoName, shortDuration, usd } from '../lib/format.js';
import { lineDiff, prettyJson } from '../lib/json-diff.js';
import { logTail } from '../lib/pipeline.js';
import { buildTimeline } from '../lib/timeline.js';

const API_KINDS = new Set([
  'status-changed',
  'field-added',
  'field-removed',
  'type-changed',
  'value-changed',
  'content-type-changed',
]);

/** Screen 2: one run in detail. */
export function RunDetailScreen({ detail }: { readonly detail: Loaded<RunDetailResponse> }) {
  const data = detail.data;
  const running = data?.summary.state === 'running';
  const events = useRunEvents(
    data?.summary.runId ?? '',
    data?.events ?? NO_EVENTS,
    running,
    detail.reload,
  );
  if (data === undefined) {
    return (
      <main>
        <p class={detail.error === undefined ? 'foot' : 'banner bad'}>
          {detail.error === undefined ? 'Loading…' : `Could not load the run: ${detail.error}`}
        </p>
      </main>
    );
  }
  const { summary, record, result } = data;
  const findings = result?.findings ?? [];
  return (
    <main>
      <Header summary={summary} record={record} result={result} />
      {record?.status === 'failed' || summary.state === 'interrupted' ? (
        <Failure summary={summary} record={record} events={events} />
      ) : null}
      {record?.status === 'skipped' ? (
        <section class="panel pad" aria-label="Skipped">
          <h2>Skipped: {record.skip.reason}</h2>
          <p class="lede">Nothing the pull request changes can be probed, so nothing was built.</p>
        </section>
      ) : null}
      <TimelinePanel
        events={events}
        running={running}
        finishedAt={record === undefined ? undefined : Date.parse(record.finishedAt)}
      />
      {result === undefined ? (
        running ? null : (
          <p class="foot">
            No result.json for this run (it was recorded before the panel existed), so only its
            record is shown.
          </p>
        )
      ) : (
        <div class="split">
          <div class="wide">
            <ApiChanges
              runId={summary.runId}
              findings={findings}
              result={result}
              interpretation={result.interpretation}
            />
            <Pages runId={summary.runId} findings={findings} captures={result.ui ?? []} />
          </div>
          <div class="narrow">
            <IntentCheck result={result} llmMode={summary.llmMode} findings={findings} />
            <Coverage result={result} />
            <Files runId={summary.runId} files={data.files} />
          </div>
        </div>
      )}
      {result === undefined && !running ? <Files runId={summary.runId} files={data.files} /> : null}
    </main>
  );
}

const NO_EVENTS: readonly RunEvent[] = [];

function Header({
  summary,
  record,
  result,
}: {
  readonly summary: RunSummary;
  readonly record: RunRecord | undefined;
  readonly result: RunResult | undefined;
}) {
  const now = useNow();
  const { target } = summary;
  const workspace = result?.workspace;
  const breaking = summary.findings.breaking;
  const duration =
    summary.state === 'running' ? now - Date.parse(summary.startedAt) : summary.durationMs;
  const facts: [string, string][] = [
    ['Duration', clock(duration)],
    ['Cost', usd(summary.costUsd)],
    ['Pages', record === undefined ? '—' : String(record.counts.routesProbed)],
    ['Endpoints', record === undefined ? '—' : String(record.counts.endpointsProbed)],
    [
      'Noise masked',
      record === undefined || record.counts.rawDiffs === 0
        ? '—'
        : `${String(record.counts.noiseDiffs)} / ${String(record.counts.rawDiffs)}`,
    ],
  ];
  return (
    <header class="detail-head">
      <div class="row">
        <Status state={summary.state} />
        {breaking > 0 ? <Tag tone="breaking">{breaking} BREAKING</Tag> : null}
        {summary.findings.unexpected > 0 ? (
          <Tag tone="warning">{summary.findings.unexpected} UNEXPECTED</Tag>
        ) : null}
        {summary.llmMode === 'on' ? null : (
          <Tag tone="warning">LLM {summary.llmMode.toUpperCase()}</Tag>
        )}
        {summary.dataset === null ? null : <Tag tone="none">{summary.dataset.id}</Tag>}
      </div>
      <h1>
        {target.prNumber === undefined ? '' : `#${String(target.prNumber)} `}
        {target.prTitle ?? refs(target)}
      </h1>
      <p class="sub">
        {repoName(target.repoUrl)} · {refs(target)}
        {workspace === undefined
          ? ''
          : ` · ${workspace.baseSha.slice(0, 7)}..${workspace.headSha.slice(0, 7)}`}
        {workspace === undefined
          ? ''
          : ` · ${String(workspace.changedFiles.length)} file(s) changed`}
        {` · run ${summary.runId}`}
      </p>
      <dl class="facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </header>
  );
}

function Failure({
  summary,
  record,
  events,
}: {
  readonly summary: RunSummary;
  readonly record: RunRecord | undefined;
  readonly events: readonly RunEvent[];
}) {
  const failure = record?.status === 'failed' ? record.failure : undefined;
  const tail = failure?.details.logTail;
  const lines = Array.isArray(tail)
    ? tail.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).slice(-100)
    : logTail(events, 100).map(
        (line) => `${line.level.padEnd(5)} ${line.stage ?? ''} ${line.message}`,
      );
  return (
    <section class="panel pad failure" aria-label="Why the run failed">
      <h2>
        {failure === undefined
          ? 'Interrupted: its process is gone'
          : `Failed${failure.stage === undefined ? '' : ` at ${failure.stage}`}: ${failure.code}`}
      </h2>
      <p>{failure?.message ?? summary.note}</p>
      <h3>Last {lines.length} log lines</h3>
      <pre class="logs">{lines.length === 0 ? 'No log lines.' : lines.join('\n')}</pre>
    </section>
  );
}

function TimelinePanel({
  events,
  running,
  finishedAt,
}: {
  readonly events: readonly RunEvent[];
  readonly running: boolean;
  readonly finishedAt: number | undefined;
}) {
  const now = useNow(running ? 500 : 60_000);
  const timeline = buildTimeline(events, now, finishedAt);
  if (timeline.lanes.length === 0) {
    return null;
  }
  const pct = (ms: number) => `${((ms / timeline.spanMs) * 100).toFixed(2)}%`;
  const env = timeline.lanes.find((lane) => lane.name === 'environment');
  return (
    <section class="panel pad" aria-label="Stage timeline">
      <div
        class="row"
        style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'space-between' }}
      >
        <h2>Timeline</h2>
        <span class="aside" style={{ fontSize: '12.5px', color: 'var(--faint)' }}>
          Base and head build in parallel
          {env === undefined
            ? ''
            : ` · environment is ${String(Math.round((env.totalMs / timeline.spanMs) * 100))}% of the run`}
        </span>
      </div>
      <div class="gantt">
        <div class="gantt-grid">
          {timeline.lanes.map((lane) => (
            <div key={lane.name} class="gantt-row">
              <span class={`lane-name ${lane.side === undefined ? '' : 'side'}`} title={lane.name}>
                {lane.side ?? lane.name}
              </span>
              <div class="track">
                {lane.bars.map((bar, index) => (
                  <div
                    key={index}
                    class={`seg ${bar.state} ${lane.side === undefined ? '' : 'side'}`}
                    style={{ left: pct(bar.start), width: pct(bar.end - bar.start) }}
                    title={`${lane.name}: ${bar.state}, ${shortDuration(bar.end - bar.start)}`}
                  />
                ))}
              </div>
              <span class="t">
                {lane.bars.every((bar) => bar.state === 'skipped')
                  ? 'skipped'
                  : shortDuration(lane.totalMs)}
              </span>
            </div>
          ))}
          <div class="gantt-row">
            <span />
            <div class="axis">
              {timeline.ticks.map((tick) => (
                <span key={tick} style={{ left: pct(tick) }}>
                  {clock(tick)}
                </span>
              ))}
            </div>
            <span />
          </div>
        </div>
      </div>
    </section>
  );
}

function ApiChanges({
  runId,
  findings,
  result,
  interpretation,
}: {
  readonly runId: string;
  readonly findings: readonly Finding[];
  readonly result: RunResult;
  readonly interpretation: RunResult['interpretation'];
}) {
  const apiFindings = findings.filter(
    (finding) => API_KINDS.has(finding.kind) || finding.location.endpoint !== undefined,
  );
  const unexpected = new Map(
    (interpretation?.unexpected ?? []).map((entry) => [entry.findingId, entry.reason]),
  );
  const byEndpoint = new Map<string, Finding[]>();
  for (const finding of apiFindings) {
    const key = finding.location.endpoint ?? '(endpoint)';
    byEndpoint.set(key, [...(byEndpoint.get(key) ?? []), finding]);
  }
  return (
    <section class="panel pad" aria-label="API changes">
      <h2>API changes</h2>
      {byEndpoint.size === 0 ? (
        <p class="hint">
          {(result.api?.requests.length ?? 0) === 0
            ? 'No API request was probed.'
            : `${String(result.api?.requests.length ?? 0)} request(s) answered the same on base and head.`}
        </p>
      ) : (
        [...byEndpoint].map(([endpoint, list]) => {
          const captures = result.api?.captures ?? [];
          const [beforePath, afterPath] = list[0]?.evidence ?? [];
          const before = captures.find((capture) => capture.artifact === beforePath);
          const after = captures.find((capture) => capture.artifact === afterPath);
          return (
            <div key={endpoint} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '10px',
                  justifyContent: 'space-between',
                }}
              >
                <code style={{ fontSize: '12.5px' }}>{endpoint}</code>
                <span class="hint">
                  baseA → head
                  {before === undefined ? null : (
                    <>
                      {' · '}
                      <FileLink runId={runId} file={before.artifact} label="base response" />
                    </>
                  )}
                  {after === undefined ? null : (
                    <>
                      {' · '}
                      <FileLink runId={runId} file={after.artifact} label="head response" />
                    </>
                  )}
                </span>
              </div>
              <ResponseDiff before={before} after={after} />
              <ul class="finding-list">
                {list.map((finding) => (
                  <li key={finding.id}>
                    <Tag tone={finding.severity}>{finding.severity.toUpperCase()}</Tag>
                    <span class="what">
                      <code>{finding.location.jsonPath ?? finding.kind}</code>{' '}
                      <span class="dim">{describeChange(finding)}</span>
                      {unexpected.has(finding.id) ? (
                        <span class="unexpected"> · unexpected: {unexpected.get(finding.id)}</span>
                      ) : null}
                    </span>
                    <span class="hint">{finding.kind}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}

function ResponseDiff({
  before,
  after,
}: {
  readonly before: ApiCapture | undefined;
  readonly after: ApiCapture | undefined;
}) {
  const text = (capture: ApiCapture | undefined) => {
    const response = capture?.response;
    if (response === undefined) {
      return capture?.error === undefined ? '' : `(no response: ${capture.error.code})`;
    }
    const head = `HTTP ${String(response.status)} ${response.contentType ?? ''}`.trim();
    const body =
      response.body.kind === 'json'
        ? prettyJson(response.body.json)
        : response.body.kind === 'text'
          ? response.body.text
          : response.body.kind === 'binary'
            ? `(${String(response.body.bytes)} bytes of binary)`
            : '(empty)';
    return `${head}\n${body}`;
  };
  const rows = lineDiff(text(before), text(after));
  return (
    <pre class="diff" aria-label="Response diff, base to head">
      {rows.map((row, index) => (
        <span
          key={index}
          class={`line ${row.kind === '-' ? 'del' : row.kind === '+' ? 'add' : row.kind === '…' ? 'fold' : ''}`}
        >
          <i>{row.kind === '-' ? '−' : row.kind === '+' ? '+' : row.kind === '…' ? '⋯' : ' '}</i>
          <span>{row.text}</span>
        </span>
      ))}
    </pre>
  );
}

/** `number → string`, `added: "USD"`, `200 → 500`: what a finding changed. Pure. */
export function describeChange(finding: Finding): string {
  const show = (value: unknown) => {
    const text = JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 77)}…` : text;
  };
  switch (finding.kind) {
    case 'type-changed':
      return `changed type: ${show(finding.before)} → ${show(finding.after)}`;
    case 'field-added':
      return `field added${finding.after === undefined ? '' : `: ${show(finding.after)}`}`;
    case 'field-removed':
      return `field removed${finding.before === undefined ? '' : `: was ${show(finding.before)}`}`;
    default:
      return finding.before === undefined && finding.after === undefined
        ? finding.kind
        : `${show(finding.before)} → ${show(finding.after)}`;
  }
}

function Pages({
  runId,
  findings,
  captures,
}: {
  readonly runId: string;
  readonly findings: readonly Finding[];
  readonly captures: readonly UiCapture[];
}) {
  const routes = [...new Set(captures.map((capture) => capture.route))];
  const changed = routes.filter((route) =>
    findings.some((finding) => finding.location.route === route),
  );
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [position, setPosition] = useState(50);
  const [overlay, setOverlay] = useState(false);
  const route = picked ?? changed[0] ?? routes[0];
  if (route === undefined) {
    return (
      <section class="panel pad" aria-label="Pages">
        <h2>Pages</h2>
        <p class="hint">No page was captured.</p>
      </section>
    );
  }
  const capture = (probeRun: UiCapture['probeRun']) =>
    captures.find((entry) => entry.route === route && entry.probeRun === probeRun);
  const before = capture('baseA');
  const after = capture('head');
  const pageFindings = findings.filter((finding) => finding.location.route === route);
  const visual = pageFindings.find((finding) => finding.kind === 'visual');
  const text = pageFindings.find((finding) => finding.kind === 'text');
  const overlayFile = visual?.evidence[2];
  const beforeUrl =
    before?.screenshot === undefined ? undefined : runFileUrl(runId, before.screenshot);
  const afterUrl =
    after?.screenshot === undefined ? undefined : runFileUrl(runId, after.screenshot);
  const overlayUrl = overlayFile === undefined ? undefined : runFileUrl(runId, overlayFile);
  return (
    <section class="panel pad" aria-label="Pages">
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '10px',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <h2>Pages</h2>
        <div class="tabs page-tabs" role="tablist" aria-label="Page">
          {routes.map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={entry === route ? 'true' : 'false'}
              onClick={() => {
                setPicked(entry);
              }}
            >
              <span class="mono">{entry}</span>
              {changed.includes(entry) ? <span class="dot running" aria-label="changed" /> : null}
            </button>
          ))}
        </div>
      </div>
      {beforeUrl === undefined || afterUrl === undefined ? (
        <p class="hint">No screenshots of {route} on both sides.</p>
      ) : (
        <>
          <div class="compare">
            <img src={beforeUrl} alt={`${route} on base`} />
            <div class="after" style={{ clipPath: `inset(0 0 0 ${String(position)}%)` }}>
              <img
                src={overlay && overlayUrl !== undefined ? overlayUrl : afterUrl}
                alt={`${route} on head`}
              />
            </div>
            <div class="handle" style={{ left: `${String(position)}%` }} aria-hidden="true" />
            <span class="lbl" style={{ left: '10px' }}>
              BEFORE · baseA
            </span>
            <span class="lbl" style={{ right: '10px' }}>
              AFTER · head{overlay ? ' · overlay' : ''}
            </span>
            <label
              class="visually-hidden"
              for="compare-range"
              style={{ position: 'absolute', left: '-9999px' }}
            >
              Compare before and after
            </label>
            <input
              id="compare-range"
              type="range"
              min={0}
              max={100}
              value={position}
              onInput={(event) => {
                setPosition(Number((event.target as HTMLInputElement).value));
              }}
            />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', alignItems: 'center' }}>
            <label class="toggle">
              <input
                type="checkbox"
                checked={overlay}
                disabled={overlayUrl === undefined}
                onChange={(event) => {
                  setOverlay((event.target as HTMLInputElement).checked);
                }}
              />
              Diff overlay
            </label>
            <span class="hint">
              {visual === undefined
                ? 'No visual change on this page.'
                : `${String((visual.after as { changedPixels?: number } | undefined)?.changedPixels ?? 0)} pixels changed outside the noise mask.`}
            </span>
          </div>
        </>
      )}
      <h3>Text</h3>
      {text === undefined ? (
        <p class="hint">No text change on this page.</p>
      ) : (
        <ul class="text-diff" aria-label="Text diff">
          {(Array.isArray(text.before) ? text.before : []).map((line, index) => (
            <li key={`b${String(index)}`} class="del">
              − {lineText(line)}
            </li>
          ))}
          {(Array.isArray(text.after) ? text.after : []).map((line, index) => (
            <li key={`a${String(index)}`} class="add">
              + {lineText(line)}
            </li>
          ))}
        </ul>
      )}
      {pageFindings
        .filter((finding) => finding.kind !== 'visual' && finding.kind !== 'text')
        .map((finding) => (
          <p key={finding.id} class="hint">
            <Tag tone={finding.severity}>{finding.severity.toUpperCase()}</Tag> {finding.kind}:{' '}
            {describeChange(finding)}
          </p>
        ))}
    </section>
  );
}

function IntentCheck({
  result,
  llmMode,
  findings,
}: {
  readonly result: RunResult;
  readonly llmMode: LlmMode;
  readonly findings: readonly Finding[];
}) {
  const { interpretation, record } = result;
  const target = record.target;
  return (
    <section class="panel pad intent" aria-label="Intent check">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '10px',
        }}
      >
        <h2>Intent check</h2>
        <Tag tone={llmMode === 'on' ? 'pass' : 'warning'}>LLM {llmMode.toUpperCase()}</Tag>
      </div>
      <dl>
        <div>
          <dt>PR says</dt>
          <dd>{target.prTitle ?? 'No PR text: the intent comes from the commit messages.'}</dd>
        </div>
        {interpretation === undefined ? null : (
          <div>
            <dt>
              Observed
              {interpretation.source === 'no-findings' ? '' : ` · risk ${interpretation.riskLevel}`}
            </dt>
            <dd>
              <ul>
                {interpretation.summary.map((bullet, index) => (
                  <li key={index}>{bullet.text}</li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {interpretation === undefined || interpretation.unexpected.length === 0 ? null : (
          <div>
            <dt>Not accounted for by the intent</dt>
            <dd>
              <ul>
                {interpretation.unexpected.map((entry) => (
                  <li key={entry.findingId}>
                    {findings.find((finding) => finding.id === entry.findingId)?.kind ?? 'finding'}:{' '}
                    {entry.reason}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {interpretation === undefined || interpretation.reviewerChecklist.length === 0 ? null : (
          <div>
            <dt>Check by hand</dt>
            <dd>
              <ul>
                {interpretation.reviewerChecklist.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </dd>
          </div>
        )}
      </dl>
      <p class="muted">
        {interpretation === undefined
          ? llmMode === 'off'
            ? 'The LLM was off for this run, so nothing was interpreted. With ANTHROPIC_API_KEY in .env, the summary appears here and changes the PR does not mention are flagged.'
            : 'No interpretation: the run ended before the interpret stage finished.'
          : llmMode === 'fake'
            ? 'Fake mode: these texts are canned, no model read the PR. Add ANTHROPIC_API_KEY for a real interpretation.'
            : interpretation.coverageNote}
      </p>
      {interpretation?.model === undefined ? null : (
        <p class="muted">Interpreted by {interpretation.model}.</p>
      )}
    </section>
  );
}

function Coverage({ result }: { readonly result: RunResult }) {
  const impact = result.impact;
  const probed = [
    ...(impact?.pages ?? []).map((route) => route.path),
    ...(result.api?.requests ?? []).map((request) => `${request.method} ${request.path}`),
  ];
  const notProbed = [
    ...(impact?.notProbed ?? []).map((entry) => ({
      what: entry.route.path,
      why: entry.reason === 'dynamic-params' ? 'dynamic route' : 'over the cap',
    })),
    ...(result.api?.notProbed ?? []).map((entry) => ({
      what: entry.endpoint,
      why: `no request: ${entry.detail}`,
    })),
  ];
  return (
    <section class="panel pad" aria-label="Coverage">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px' }}>
        <h2>Coverage</h2>
        {impact === undefined ? null : <span class="hint">{impact.confidence} confidence</span>}
      </div>
      <div class="coverage">
        <div>
          <h3>Probed</h3>
          <ul>
            {probed.length === 0 ? (
              <li class="hint">nothing</li>
            ) : (
              probed.map((entry) => (
                <li key={entry}>
                  <code>{entry}</code>
                </li>
              ))
            )}
          </ul>
        </div>
        <div>
          <h3>Not probed</h3>
          <ul>
            {notProbed.length === 0 ? (
              <li class="hint">nothing left out</li>
            ) : (
              notProbed.map((entry) => (
                <li key={entry.what}>
                  <code>{entry.what}</code>
                  <span class="why">{entry.why}</span>
                </li>
              ))
            )}
          </ul>
        </div>
      </div>
    </section>
  );
}

const FILE_ORDER = ['report/index.html', 'run.json', 'result.json', 'events.jsonl', 'compose.yml'];

function Files({ runId, files }: { readonly runId: string; readonly files: readonly string[] }) {
  const listed = [
    ...FILE_ORDER.filter((file) => files.includes(file)),
    ...files.filter((file) => file.startsWith('logs/')),
  ];
  return (
    <section class="panel pad" aria-label="Files">
      <h2>Files</h2>
      <div class="files">
        {listed.map((file) => (
          <FileLink
            key={file}
            runId={runId}
            file={file}
            label={file === 'report/index.html' ? 'report (HTML)' : file}
          />
        ))}
      </div>
      {listed.includes('report/index.html') ? null : (
        <Command command={`open .bdiff/runs/${runId}`} />
      )}
    </section>
  );
}

function FileLink({
  runId,
  file,
  label,
}: {
  readonly runId: string;
  readonly file: string;
  readonly label: string;
}) {
  const url = runFileUrl(runId, file);
  return url === undefined ? null : (
    <a href={url} target="_blank" rel="noopener noreferrer">
      <span>{label}</span>
      <span aria-hidden="true">↗</span>
    </a>
  );
}

/** A line of a text finding: lines are strings; anything else is shown as JSON. Pure. */
function lineText(line: unknown): string {
  return typeof line === 'string' ? line : JSON.stringify(line);
}
