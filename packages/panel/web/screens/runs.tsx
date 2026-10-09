import type { RunEvent } from '@bdiff/core';
import { useMemo, useState } from 'preact/hooks';

import type { Metric, RunsResponse, RunState, RunSummary, StatusResponse } from '../../src/api.js';
import { Bar, Command, Status, Tag } from '../components/common.js';
import type { Loaded } from '../lib/data.js';
import { postJson, routeHref, useNow, useRunEvents } from '../lib/data.js';
import { ago, clock, refs, shortDuration, shortRunId, timeOfDay, usd } from '../lib/format.js';
import { captureProgress, logTail, pipelineStrip } from '../lib/pipeline.js';

type Filter = 'all' | RunState;

const FILTERS: readonly [Filter, string][] = [
  ['all', 'All'],
  ['success', 'Success'],
  ['running', 'Running'],
  ['skipped', 'Skipped'],
  ['failed', 'Failed'],
  ['interrupted', 'Interrupted'],
];

/** The runs a filter tab shows. Pure. */
export function filterRuns(runs: readonly RunSummary[], filter: Filter): RunSummary[] {
  return filter === 'all' ? [...runs] : runs.filter((run) => run.state === filter);
}

/** Screen 1: metric cards, the runs in progress and every run. */
export function RunsScreen({
  runs,
  status,
}: {
  readonly runs: Loaded<RunsResponse>;
  readonly status: StatusResponse | undefined;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const now = useNow();
  const all = runs.data?.runs ?? [];
  const running = all.filter((run) => run.state === 'running');
  const shown = filterRuns(all, filter);
  const longest = Math.max(1, ...all.map((run) => run.durationMs));
  return (
    <main>
      <header class="page-title">
        <h1>
          Runs<span class="period">.</span>
        </h1>
        <p class="lede">
          Every bdiff run in this workspace, newest first. Numbers are measured against the
          experiment targets.
        </p>
      </header>
      {runs.error === undefined ? null : (
        <p class="banner bad">Could not load runs: {runs.error}</p>
      )}
      {runs.data === undefined ? null : <Metrics metrics={runs.data.metrics} />}
      {running.map((run) => (
        <LiveRun
          key={run.runId}
          run={run}
          now={now}
          suiteRunning={status?.suite?.state === 'running'}
          onEnd={runs.reload}
        />
      ))}
      {runs.data !== undefined && all.length === 0 ? (
        <EmptyState demo={status?.demo === true} />
      ) : (
        <section class="panel" aria-label="All runs">
          <div class="panel-head">
            <h2>All runs</h2>
            <div
              class="tabs"
              role="tablist"
              aria-label="Filter by status"
              style={{ marginLeft: 'auto' }}
            >
              {FILTERS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={filter === value ? 'true' : 'false'}
                  onClick={() => {
                    setFilter(value);
                  }}
                >
                  {label}{' '}
                  <span class="n">
                    {value === 'all' ? all.length : all.filter((run) => run.state === value).length}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div class="table-wrap">
            <table class="runs">
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Pull request</th>
                  <th scope="col">Findings</th>
                  <th scope="col">Duration</th>
                  <th scope="col" style={{ textAlign: 'right' }}>
                    Cost
                  </th>
                  <th scope="col">Started</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((run) => (
                  <RunRow key={run.runId} run={run} longest={longest} now={now} />
                ))}
              </tbody>
            </table>
          </div>
          {shown.length === 0 && runs.data !== undefined ? (
            <p class="empty">No runs with this status.</p>
          ) : null}
        </section>
      )}
      {runs.data !== undefined && runs.data.unreadable > 0 ? (
        <p class="foot">
          {runs.data.unreadable} run(s) have an unreadable run.json and are left out.
        </p>
      ) : null}
      {status?.demo === true ? (
        <p class="foot">
          Demo data from the fixture repo · the live run is a recorded run replayed
        </p>
      ) : null}
    </main>
  );
}

function Metrics({ metrics }: { readonly metrics: readonly Metric[] }) {
  const colors: Record<Metric['verdict'], string> = {
    'on-track': 'var(--success)',
    'off-track': 'var(--warning)',
    'not-measured': 'var(--faint)',
    info: 'var(--accent)',
  };
  const notes: Record<Metric['verdict'], string> = {
    'on-track': 'on track',
    'off-track': 'off track',
    'not-measured': 'not measured yet',
    info: 'measured',
  };
  return (
    <section class="metrics" aria-label="Experiment metrics">
      {metrics.map((metric) => (
        <div key={metric.id} class="panel metric">
          <span class="label">{metric.label}</span>
          <div>
            <span class="value">{metric.value}</span>
          </div>
          <Bar fraction={metric.fraction ?? 0} color={colors[metric.verdict]} />
          <span class={`note ${metric.verdict}`}>
            Target {metric.target} · {notes[metric.verdict]}
          </span>
          <span class="note">{metric.basis}</span>
        </div>
      ))}
    </section>
  );
}

/** The card of a run in progress: pipeline strip, captures and log tail, live over SSE. */
export function LiveRun({
  run,
  now,
  suiteRunning,
  onEnd,
}: {
  readonly run: RunSummary;
  readonly now: number;
  readonly suiteRunning: boolean;
  readonly onEnd: () => void;
}) {
  const initial = useMemo<readonly RunEvent[]>(() => [], []);
  const events = useRunEvents(run.runId, initial, true, onEnd);
  const strip = pipelineStrip(events, undefined, false, now);
  const captures = captureProgress(events);
  const logs = logTail(events, 20);
  const started = events.find((event) => event.type === 'run-started');
  const elapsed = now - Date.parse(started?.at ?? run.startedAt);
  return (
    <section class="panel live-run" aria-label="Running now">
      <div class="panel-head">
        <span class="live-dot" aria-hidden="true" />
        <h2>Running</h2>
        <a
          class="mono"
          href={routeHref({ screen: 'run', runId: run.runId })}
          style={{ color: 'var(--text)', textDecoration: 'none' }}
        >
          {refs(run.target)}
        </a>
        <span class="mono" style={{ fontSize: '11.5px', color: 'var(--faint)' }}>
          {shortRunId(run.runId)} · llm {run.llmMode}
        </span>
        <span class="elapsed">{clock(elapsed)} elapsed</span>
        {suiteRunning ? (
          <button
            type="button"
            class="btn ghost"
            onClick={() => {
              void postJson('/api/suite/cancel');
            }}
          >
            Cancel
          </button>
        ) : null}
      </div>
      <div class="strip">
        <ol aria-label="Pipeline stages">
          {strip.map((cell) => (
            <li key={cell.stage} class={cell.state}>
              <span class="link" aria-hidden="true" />
              <span class="node" aria-hidden="true">
                {cell.state === 'done' ? '✓' : cell.state === 'failed' ? '!' : ''}
              </span>
              <span class="name">{cell.stage}</span>
              <span class="time">
                {cell.state === 'skipped'
                  ? 'skipped'
                  : cell.state === 'unused'
                    ? 'not needed'
                    : cell.durationMs === undefined
                      ? '—'
                      : shortDuration(cell.durationMs)}
              </span>
            </li>
          ))}
        </ol>
      </div>
      <div class="live-body">
        <div class="captures">
          <h3>probe-ui · captures</h3>
          {captures.length === 0 ? (
            <p class="hint">No page captured yet.</p>
          ) : (
            captures.map((capture) => (
              <div key={capture.probeRun} class="capture-row">
                <span>{capture.probeRun}</span>
                <Bar
                  fraction={capture.total === 0 ? 0 : capture.done / capture.total}
                  color={capture.done === capture.total ? 'var(--text)' : 'var(--accent)'}
                />
                <span class="count">
                  {capture.done} / {capture.total}
                </span>
              </div>
            ))
          )}
        </div>
        <pre class="logs" aria-label="Log tail">
          {logs.length === 0
            ? 'Waiting for the first log line…'
            : logs.map((line, index) => (
                <span key={index} class={line.level === 'info' ? undefined : line.level}>
                  <span class="t">{timeOfDay(line.at)}</span>
                  {'  '}
                  {line.stage === undefined ? null : <span class="stage">{line.stage} </span>}
                  {line.message}
                  {'\n'}
                </span>
              ))}
        </pre>
      </div>
    </section>
  );
}

function RunRow({
  run,
  longest,
  now,
}: {
  readonly run: RunSummary;
  readonly longest: number;
  readonly now: number;
}) {
  const href = routeHref({ screen: 'run', runId: run.runId });
  const ended = run.state !== 'running';
  const pill = (count: number, tone: 'breaking' | 'warning' | 'info', label: string) =>
    !ended ? (
      <Tag tone="none">– {label}</Tag>
    ) : (
      <Tag tone={count === 0 ? 'zero' : tone}>
        {count} {label}
      </Tag>
    );
  return (
    <tr
      onClick={() => {
        location.hash = href;
      }}
    >
      <td>
        <Status state={run.state} />
      </td>
      <td>
        <a class="target" href={href}>
          {run.target.prNumber === undefined ? '' : `#${String(run.target.prNumber)} `}
          {refs(run.target)}
        </a>
        <div
          class={`row-note ${run.state === 'failed' || run.state === 'interrupted' ? 'failed' : ''}`}
        >
          {run.target.prTitle === undefined ? run.note : `${run.target.prTitle} · ${run.note}`}
        </div>
      </td>
      <td>
        <span class="pills">
          {pill(run.findings.breaking, 'breaking', 'breaking')}
          {pill(run.findings.warning, 'warning', 'warn')}
          {pill(run.findings.info, 'info', 'info')}
        </span>
      </td>
      <td>
        <div class="duration">
          <Bar
            fraction={run.durationMs / longest}
            color={ended ? 'rgba(236,233,228,0.5)' : 'var(--accent)'}
          />
          {clock(run.durationMs)}
        </div>
      </td>
      <td class="num" style={{ textAlign: 'right' }}>
        {usd(run.costUsd)}
      </td>
      <td class="num" title={run.startedAt}>
        {ended ? ago(run.startedAt, now) : 'now'}
      </td>
    </tr>
  );
}

function EmptyState({ demo }: { readonly demo: boolean }) {
  return (
    <section class="panel empty-state" aria-label="No runs yet">
      <h2>No runs in this workspace yet</h2>
      <p class="lede">
        Start a run and it shows up here live. Without an API key the LLM is off;{' '}
        <code>--llm fake</code> shows canned interpretations.
      </p>
      <Command command="pnpm bdiff run https://github.com/<owner>/<repo>/pull/<n> --llm fake" />
      <Command command={'pnpm bdiff batch "$(pnpm --silent fixture:dataset)" --llm off'} />
      {demo ? null : (
        <p class="hint">
          Or look around with demo data: <code>pnpm bdiff ui --demo</code>
        </p>
      )}
    </section>
  );
}
