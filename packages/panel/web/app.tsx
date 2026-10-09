import type {
  FixtureResponse,
  RunDetailResponse,
  RunsResponse,
  StatusResponse,
} from '../src/api.js';
import { Sidebar } from './components/sidebar.js';
import { usePolling, useRoute } from './lib/data.js';
import { FixtureScreen } from './screens/fixture.js';
import { RunDetailScreen } from './screens/run-detail.js';
import { RunsScreen } from './screens/runs.js';

/** The panel: sidebar, top bar and the screen of the current route. */
export function App() {
  const route = useRoute();
  const status = usePolling<StatusResponse>('/api/status', 3000);
  const runs = usePolling<RunsResponse>('/api/runs', 2000);
  const fixture = usePolling<FixtureResponse>(
    '/api/fixture',
    route.screen === 'fixture' ? 4000 : 30_000,
  );
  const detail = usePolling<RunDetailResponse>(
    route.screen === 'run' ? `/api/runs/${encodeURIComponent(route.runId)}` : null,
    0,
  );
  const latest = runs.data?.runs.find((run) => run.state !== 'running');
  return (
    <div class="shell">
      <div class="backdrop" aria-hidden="true">
        <div class="paper" />
        <div class="grid" />
      </div>
      <Sidebar
        route={route}
        status={status.data}
        runCount={runs.data?.runs.length}
        failingChecks={fixture.data?.checks.filter((check) => check.status === 'fail').length}
        latestRunId={latest?.runId}
      />
      <div class="content">
        <div class="topbar">
          <span class="crumbs">
            <a href="#/runs">{status.data?.demo === true ? 'demo workspace' : 'workspace'}</a>
            <span class="sep"> / </span>
            <span class="here">
              {route.screen === 'runs'
                ? 'runs'
                : route.screen === 'fixture'
                  ? 'fixture check'
                  : `run ${route.runId}`}
            </span>
          </span>
          <span class="right">
            {status.data?.demo === true ? <span class="chip demo">Demo data</span> : null}
            {status.error === undefined ? null : (
              <span class="hint">panel server unreachable: {status.error}</span>
            )}
          </span>
        </div>
        {route.screen === 'runs' ? <RunsScreen runs={runs} status={status.data} /> : null}
        {route.screen === 'run' ? <RunDetailScreen key={route.runId} detail={detail} /> : null}
        {route.screen === 'fixture' ? (
          <FixtureScreen fixture={fixture} status={status.data} onSuiteChange={status.reload} />
        ) : null}
      </div>
    </div>
  );
}
