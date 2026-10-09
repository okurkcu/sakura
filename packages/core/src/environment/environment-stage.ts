import { CONTAINER_SOURCE_DIR } from './app-script.js';
import {
  appService,
  buildComposeSpec,
  composeProjectName,
  DEFAULT_CONTAINER_LIMITS,
  renderCompose,
  serviceName,
} from './compose-spec.js';
import type { ContainerLimits } from './compose-spec.js';
import { createComposeProject } from './docker-compose.js';
import type { ComposeProject } from './docker-compose.js';
import { waitUntilHealthy } from './health.js';
import { setupFailure, setupTimeout } from './setup-failure.js';
import type { Exec } from '../adapters/exec.js';
import type { FileSystem } from '../adapters/file-system.js';
import type { HttpClient } from '../adapters/http.js';
import type { RunningEnvironment } from '../domain/environment.js';
import type { Recipe } from '../domain/recipe.js';
import type { Side } from '../domain/stage.js';
import type { Workspace } from '../domain/workspace.js';
import type { RunId } from '../metrics/run-id.js';
import type { Stage, StageContext } from '../pipeline/stage.js';

/** Default limit for install, database setup, build and start, both sides in parallel. */
export const DEFAULT_SETUP_TIMEOUT_MS = 10 * 60_000;
const HEALTH_INTERVAL_MS = 2_000;
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;
const SIDES = ['base', 'head'] as const;

/** Dependencies of the environment stage. */
export interface EnvironmentStageDeps {
  readonly exec: Exec;
  readonly fs: FileSystem;
  readonly http: HttpClient;
  readonly limits?: ContainerLimits;
  readonly setupTimeoutMs?: number;
  readonly healthIntervalMs?: number;
}

/** What the environment stage keeps about a run between its attempts. */
interface RunState {
  /** Attempts started so far in this run. */
  attempts: number;
  /** The recipe of the latest attempt: its services are the containers to time. */
  recipe: Recipe;
  /** Container run time of earlier attempts, whose containers are already removed. */
  readonly earlierSeconds: Record<Side, number>;
}

/**
 * The environment stage: runs base and head in parallel, each in its own container of one compose
 * project (`bdiff-<runId>`), configured identically, and returns the URLs to probe.
 *
 * Source trees are copied into the containers (nothing from the host is mounted) and every repo
 * command runs inside them; the host only runs the docker CLI. A cleanup hook, registered before
 * anything is created, saves the logs, records each side's container run time and removes the
 * project's containers, networks and volumes, whatever happens.
 *
 * The stage may run again in the same run with a repaired recipe (setup repair loop). It then
 * first sets the previous attempt aside: its logs are kept as `logs/<side>-attempt-<n>.log`, its
 * container run time is added to the run's, and its project is removed.
 *
 * @throws BdiffError `DOCKER_UNAVAILABLE`, `SETUP_INSTALL_FAILED`, `SETUP_DB_FAILED`,
 *   `SETUP_BUILD_FAILED`, `SETUP_START_FAILED`, `SETUP_TIMEOUT` or `SETUP_PORT_CONFLICT`; setup
 *   failures carry the last 100 log lines in `details.logTail`.
 */
export function createEnvironmentStage(
  deps: EnvironmentStageDeps,
): Stage<{ workspace: Workspace; recipe: Recipe }, RunningEnvironment> {
  const runs = new Map<RunId, RunState>();
  return {
    name: 'environment',
    run: async ({ workspace, recipe }, ctx) => {
      const project = composeProjectName(ctx.runId);
      const compose = createComposeProject(deps.exec, ctx.paths.composeFile, project, ctx.signal);
      await compose.checkDocker();

      let state = runs.get(ctx.runId);
      if (state === undefined) {
        const created: RunState = { attempts: 0, recipe, earlierSeconds: { base: 0, head: 0 } };
        runs.set(ctx.runId, created);
        ctx.onCleanup('docker compose project', async (signal) => {
          runs.delete(ctx.runId);
          await tearDown(deps, ctx, created, signal);
        });
        state = created;
      } else {
        await setAside(deps, ctx, compose, state);
      }
      state.attempts += 1;
      state.recipe = recipe;

      await deps.fs.mkdir(ctx.paths.runDir);
      await deps.fs.writeFile(
        ctx.paths.composeFile,
        renderCompose(
          buildComposeSpec(recipe, {
            runId: ctx.runId,
            limits: deps.limits ?? DEFAULT_CONTAINER_LIMITS,
          }),
        ),
      );

      await compose.create();
      await compose.copyInto(appService('base'), workspace.basePath, CONTAINER_SOURCE_DIR);
      await compose.copyInto(appService('head'), workspace.headPath, CONTAINER_SOURCE_DIR);
      await compose.up();
      ctx.logger.info('containers started; installing and building', { project });
      for (const side of SIDES) {
        ctx.progress({ type: 'environment-side', side, status: 'started' });
      }

      const urls = {
        base: `http://${await compose.port(appService('base'), recipe.port)}`,
        head: `http://${await compose.port(appService('head'), recipe.port)}`,
      };
      const setupTimeoutMs = deps.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
      const outcome = await waitUntilHealthy(
        SIDES.map((side) => ({
          side,
          url: `${urls[side]}${recipe.healthPath}`,
          exitCode: async () => {
            const state = (await compose.states()).find(
              (entry) => entry.service === appService(side),
            );
            return state === undefined || state.running ? undefined : state.exitCode;
          },
        })),
        {
          clock: ctx.clock,
          http: deps.http,
          signal: ctx.signal,
          timeoutMs: setupTimeoutMs,
          intervalMs: deps.healthIntervalMs ?? HEALTH_INTERVAL_MS,
          requestTimeoutMs: HEALTH_REQUEST_TIMEOUT_MS,
          onHealthy: (side) => {
            ctx.progress({ type: 'environment-side', side, status: 'ready' });
          },
        },
      );
      if (outcome.kind !== 'healthy') {
        ctx.progress({ type: 'environment-side', side: outcome.side, status: 'failed' });
      }
      await saveLogs(deps, ctx, compose);

      if (outcome.kind === 'exited') {
        throw setupFailure(
          outcome.side,
          outcome.exitCode,
          await compose.logs(appService(outcome.side)),
        );
      }
      if (outcome.kind === 'timeout') {
        throw setupTimeout(
          outcome.side,
          setupTimeoutMs,
          await compose.logs(appService(outcome.side)),
        );
      }
      ctx.logger.info('environment ready', { base: urls.base, head: urls.head });
      return {
        project,
        sides: {
          base: { url: urls.base, service: appService('base') },
          head: { url: urls.head, service: appService('head') },
        },
      };
    },
  };
}

/** Writes each side's app log to `logs/<side>.log`. */
async function saveLogs(
  deps: EnvironmentStageDeps,
  ctx: StageContext,
  compose: ComposeProject,
): Promise<void> {
  await deps.fs.mkdir(ctx.paths.logsDir);
  for (const side of SIDES) {
    await deps.fs.writeFile(ctx.paths.log(side), await compose.logs(appService(side)));
  }
}

/**
 * Before a retry: keep the previous attempt's logs under `<side>-attempt-<n>`, add its container run
 * time to `state.earlierSeconds` (best effort, logged on failure), and remove its project.
 */
async function setAside(
  deps: EnvironmentStageDeps,
  ctx: StageContext,
  compose: ComposeProject,
  state: RunState,
): Promise<void> {
  try {
    const now = ctx.clock.now();
    for (const side of SIDES) {
      state.earlierSeconds[side] += await compose.runSeconds(sideServices(state.recipe, side), now);
      if (await deps.fs.exists(ctx.paths.log(side))) {
        await deps.fs.rename(
          ctx.paths.log(side),
          ctx.paths.log(`${side}-attempt-${String(state.attempts)}`),
        );
      }
    }
  } catch (error) {
    ctx.logger.warn("could not keep the previous attempt's logs or run times", { err: error });
  }
  await compose.down(ctx.signal);
  ctx.logger.info('previous attempt removed', { attempt: state.attempts });
}

/**
 * Cleanup: save final logs and run times (best effort, logged on failure), then remove the
 * project. Only a failed removal fails the hook, because that is what would leak resources.
 */
async function tearDown(
  deps: EnvironmentStageDeps,
  ctx: StageContext,
  state: RunState,
  signal: AbortSignal,
): Promise<void> {
  const compose = createComposeProject(
    deps.exec,
    ctx.paths.composeFile,
    composeProjectName(ctx.runId),
    signal,
  );
  try {
    await saveLogs(deps, ctx, compose);
    const now = ctx.clock.now();
    for (const side of SIDES) {
      ctx.setComputeSeconds(
        side,
        state.earlierSeconds[side] +
          (await compose.runSeconds(sideServices(state.recipe, side), now)),
      );
    }
  } catch (error) {
    ctx.logger.warn('could not save container logs or run times', { err: error });
  }
  await compose.down(signal);
  ctx.logger.info('docker compose project removed', { project: composeProjectName(ctx.runId) });
}

function sideServices(recipe: Recipe, side: Side): string[] {
  return [appService(side), ...recipe.services.map((service) => serviceName(service, side))];
}
