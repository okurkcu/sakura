import { Icons } from './common.js';
import type { StatusResponse } from '../../src/api.js';
import logo from '../assets/sakura-256.webp';
import type { Route } from '../lib/data.js';
import { routeHref } from '../lib/data.js';

const LLM_NOTES = {
  on: null,
  off: 'No interpretation or setup repair. Add ANTHROPIC_API_KEY to .env to turn the LLM on.',
  fake: 'Canned answers, no model. Add ANTHROPIC_API_KEY to .env for real ones.',
} as const;

/** The panel's sidebar: logo, navigation and the environment block. */
export function Sidebar({
  route,
  status,
  runCount,
  failingChecks,
  latestRunId,
}: {
  readonly route: Route;
  readonly status: StatusResponse | undefined;
  readonly runCount: number | undefined;
  readonly failingChecks: number | undefined;
  readonly latestRunId: string | undefined;
}) {
  const onLatest = route.screen === 'run' && route.runId === latestRunId;
  const current = (screen: Route['screen']) =>
    (
      screen === 'run'
        ? onLatest
        : route.screen === screen || (screen === 'runs' && route.screen === 'run' && !onLatest)
    )
      ? 'page'
      : undefined;
  const llmNote = status === undefined ? null : LLM_NOTES[status.llmMode];
  return (
    <aside class="sidebar">
      <a class="brand" href={routeHref({ screen: 'runs' })} aria-label="Sakura dev panel, runs">
        <img src={logo} alt="" width={28} height={28} />
        <span class="name">Sakura</span>
        <span class="chip">dev</span>
        {status?.demo === true ? <span class="chip demo">demo</span> : null}
      </a>
      <nav class="nav" aria-label="Panel">
        <a href={routeHref({ screen: 'runs' })} aria-current={current('runs')}>
          {Icons.runs}
          Runs
          {runCount === undefined ? null : <span class="count">{runCount}</span>}
        </a>
        <a href={routeHref({ screen: 'fixture' })} aria-current={current('fixture')}>
          {Icons.fixture}
          Fixture check
          {failingChecks === undefined || failingChecks === 0 ? null : (
            <span class="count bad">{failingChecks} fail</span>
          )}
        </a>
        <a
          href={
            latestRunId === undefined
              ? routeHref({ screen: 'runs' })
              : routeHref({ screen: 'run', runId: latestRunId })
          }
          aria-current={current('run')}
        >
          {Icons.report}
          Latest report
        </a>
      </nav>
      <section class="env" aria-label="Environment">
        <h2 class="label">Environment</h2>
        <dl>
          <dt>Docker</dt>
          <dd>
            <span class={`dot ${status?.docker ?? 'unknown'}`} aria-hidden="true" />
            {status === undefined ? '…' : status.demo ? 'not needed' : status.docker}
          </dd>
          <dt>LLM</dt>
          <dd style={{ color: status?.llmMode === 'on' ? undefined : 'var(--warning)' }}>
            <span
              class={`dot ${status?.llmMode === 'on' ? 'connected' : 'warning'}`}
              aria-hidden="true"
            />
            {status?.llmMode ?? '…'}
          </dd>
          <dt>Workspace</dt>
          <dd class="path" title={status?.workspace}>
            {status === undefined ? '…' : shortPath(status.workspace)}
          </dd>
          <dt>Version</dt>
          <dd class="path">{status === undefined ? '…' : status.toolVersion.slice(0, 12)}</dd>
        </dl>
        {llmNote === null ? null : <p class="hint">{llmNote}</p>}
      </section>
      <div class="inscription" aria-hidden="true">
        <span class="jp" lang="ja">
          見極める
        </span>
        <span class="en">
          mikiwameru
          <br />
          to discern
        </span>
      </div>
    </aside>
  );
}

/** The last two segments of a path, e.g. `…/sakura/.bdiff`. Pure. */
export function shortPath(file: string): string {
  const parts = file.split('/').filter((part) => part !== '');
  return parts.length <= 2 ? file : `…/${parts.slice(-2).join('/')}`;
}
