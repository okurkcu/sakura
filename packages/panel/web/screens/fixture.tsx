import { useState } from 'preact/hooks';

import type { FixtureCheck, FixtureResponse, StatusResponse } from '../../src/api.js';
import { runFileUrl } from '../../src/paths.js';
import { Command, Icons, Tag } from '../components/common.js';
import type { Loaded } from '../lib/data.js';
import { postJson, routeHref, useNow } from '../lib/data.js';
import { ago } from '../lib/format.js';

/** Screen 3: the fixture suite compared with `fixtures/expected.json`. */
export function FixtureScreen({
  fixture,
  status,
  onSuiteChange,
}: {
  readonly fixture: Loaded<FixtureResponse>;
  readonly status: StatusResponse | undefined;
  readonly onSuiteChange: () => void;
}) {
  const checks = fixture.data?.checks ?? [];
  const firstFailure = checks.findIndex((check) => check.status === 'fail');
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const now = useNow(5000);
  const current =
    checks.find((check) => check.id === selected) ?? checks[firstFailure >= 0 ? firstFailure : 0];
  const passed = checks.filter((check) => check.status === 'pass').length;
  const suite = status?.suite ?? null;
  const suiteRunning = suite?.state === 'running';
  return (
    <main>
      <header
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '20px 40px' }}
      >
        <div class="page-title" style={{ flex: '999 1 420px', minWidth: 0 }}>
          <h1>
            Fixture check<span class="period">.</span>
          </h1>
          <p class="lede">
            The latest run of every fixture branch, compared with{' '}
            <code>fixtures/expected.json</code>. This is the ground truth: if a check fails here, it
            will fail on real repositories too.
          </p>
        </div>
        {checks.length === 0 ? null : (
          <div class="score">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
              <span class="big">
                {passed}
                <span class="of"> / {checks.length}</span>
              </span>
              <span style={{ fontSize: '13px', color: 'var(--dim)' }}>checks passing</span>
            </div>
            <div
              class="segments"
              aria-hidden="true"
              style={{ gridTemplateColumns: `repeat(${String(checks.length)}, minmax(0, 1fr))` }}
            >
              {checks.map((check) => (
                <span key={check.id} class={check.status} />
              ))}
            </div>
          </div>
        )}
      </header>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center' }}>
        <button
          type="button"
          class="btn"
          disabled={status?.canRunSuite !== true || suiteRunning}
          title={
            status?.canRunSuite === true
              ? undefined
              : status?.demo === true
                ? 'Not available with demo data'
                : 'The suite cannot run here'
          }
          onClick={() => {
            setError(undefined);
            postJson('/api/suite/run').then(onSuiteChange, (failure: unknown) => {
              setError(failure instanceof Error ? failure.message : String(failure));
            });
          }}
        >
          {Icons.rerun}
          {suiteRunning ? 'Suite running…' : 'Re-run suite'}
        </button>
        {suiteRunning ? (
          <button
            type="button"
            class="btn ghost"
            onClick={() => {
              void postJson('/api/suite/cancel').then(onSuiteChange);
            }}
          >
            Cancel
          </button>
        ) : null}
        <span class="hint">
          {suiteRunning
            ? 'Building the fixture repository and running every branch; follow it live on Runs.'
            : suite === null
              ? fixture.data?.lastRunAt === null || fixture.data === undefined
                ? 'No fixture run yet.'
                : `Last fixture run ${ago(fixture.data.lastRunAt, now)}.`
              : `Last suite ${suite.state}${suite.message === undefined ? '' : `: ${suite.message}`}.`}
          {status?.canRunSuite === true ? ` Runs use LLM mode ${status.llmMode}.` : ''}
        </span>
        {suiteRunning ? (
          <a href={routeHref({ screen: 'runs' })} style={{ fontSize: '13px' }}>
            Watch on Runs →
          </a>
        ) : null}
      </div>
      {error === undefined ? null : <p class="banner bad">{error}</p>}
      {fixture.error === undefined ? null : (
        <p class="banner bad">Could not load the fixture check: {fixture.error}</p>
      )}
      {fixture.data?.available === false ? (
        <p class="banner">
          fixtures/expected.json is not available here, so there is nothing to compare with.
        </p>
      ) : null}
      {current === undefined ? null : (
        <div class="split">
          <section class="checks" aria-label="Checks">
            {checks.map((check) => (
              <button
                key={check.id}
                type="button"
                class={`check ${check.status}`}
                aria-pressed={check.id === current.id ? 'true' : 'false'}
                onClick={() => {
                  setSelected(check.id);
                }}
              >
                <StatusTag check={check} />
                <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  <span class="title">{check.title}</span>
                  <span class="sub">{check.actual}</span>
                </span>
                {Icons.chevron}
              </button>
            ))}
          </section>
          <CheckDetail check={current} />
        </div>
      )}
    </main>
  );
}

function StatusTag({ check }: { readonly check: FixtureCheck }) {
  return (
    <Tag tone={check.status}>
      {check.status === 'pass' ? 'PASS' : check.status === 'fail' ? 'FAIL' : 'NO RUN'}
    </Tag>
  );
}

function CheckDetail({ check }: { readonly check: FixtureCheck }) {
  const failed = check.status === 'fail';
  return (
    <section class={`panel pad check-detail ${failed ? 'failure' : ''}`} aria-label="Check detail">
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}>
        <StatusTag check={check} />
        <h2 class="mono" style={{ fontSize: '14px' }}>
          {check.title}
        </h2>
      </div>
      <dl class="compare-boxes">
        <div>
          <dt class="label">Expected</dt>
          <dd>{check.expected}</dd>
        </div>
        <div class={failed ? 'bad' : ''}>
          <dt class="label">Actual</dt>
          <dd>{check.actual}</dd>
        </div>
      </dl>
      {check.problems.length === 0 ? null : (
        <ul class="problems">
          {check.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      {check.evidence === undefined ? null : (
        <div class="crops">
          {(['baseA', 'baseB', 'head'] as const).map((probeRun) => {
            const file = check.evidence?.screenshots[probeRun];
            const url =
              file === undefined || check.evidence === undefined
                ? undefined
                : runFileUrl(check.evidence.runId, file);
            return (
              <figure key={probeRun}>
                {url === undefined ? (
                  <span class="hint">no screenshot</span>
                ) : (
                  <img src={url} alt={`${check.evidence?.route ?? ''} on ${probeRun}`} />
                )}
                <figcaption>{probeRun}</figcaption>
              </figure>
            );
          })}
        </div>
      )}
      {check.stage === undefined ? null : (
        <p class="hint">
          Owning stage: <code>{check.stage}</code>
        </p>
      )}
      {check.runId === undefined ? null : (
        <a href={routeHref({ screen: 'run', runId: check.runId })} style={{ fontSize: '13px' }}>
          Open run →
        </a>
      )}
      {check.rerun === undefined ? null : <Command command={check.rerun} />}
    </section>
  );
}
