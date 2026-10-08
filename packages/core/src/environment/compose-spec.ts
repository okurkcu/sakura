import { stringify } from 'yaml';

import { buildAppScript } from './app-script.js';
import type { Recipe, RecipeService } from '../domain/recipe.js';
import type { Side } from '../domain/stage.js';

/** Resource limits of the containers of one side. */
export interface ContainerLimits {
  readonly appCpus: number;
  /** Docker memory string, e.g. `4g`. */
  readonly appMemory: string;
  readonly serviceCpus: number;
  readonly serviceMemory: string;
}

/** Defaults: 2 CPUs and 4 GB per app, 1 CPU and 1 GB per backing service. */
export const DEFAULT_CONTAINER_LIMITS: ContainerLimits = {
  appCpus: 2,
  appMemory: '4g',
  serviceCpus: 1,
  serviceMemory: '1g',
};

/** Same for every side and every run, so base and head differ only in their code. */
export const DETERMINISTIC_ENV: Readonly<Record<string, string>> = {
  TZ: 'UTC',
  LANG: 'C.UTF-8',
  NODE_ENV: 'production',
  NEXT_TELEMETRY_DISABLED: '1',
  CI: '1',
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  HOSTNAME: '0.0.0.0',
};

const POSTGRES = { user: 'bdiff', password: 'bdiff', db: 'bdiff' } as const;

/** Inputs of {@link buildComposeSpec}. */
export interface ComposeSpecOptions {
  readonly runId: string;
  readonly limits: ContainerLimits;
}

/** A compose file as a plain object; render with {@link renderCompose}. */
export type ComposeSpec = Record<string, unknown>;

/** Compose service name of a side's app, e.g. `app-head`. */
export function appService(side: Side): string {
  return `app-${side}`;
}

/** Compose service name of a backing service of one side, e.g. `db-head`. */
export function serviceName(service: RecipeService, side: Side): string {
  return `${service.kind === 'postgres' ? 'db' : service.kind}-${side}`;
}

/** URL an app uses to reach a backing service of its own side, over the project network. */
export function serviceUrl(service: RecipeService, side: Side): string {
  const host = serviceName(service, side);
  return service.kind === 'postgres'
    ? `postgresql://${POSTGRES.user}:${POSTGRES.password}@${host}:5432/${POSTGRES.db}`
    : `redis://${host}:6379`;
}

/**
 * The compose project of a run: per side an app container (`node:<version>`, running the recipe
 * through {@link buildAppScript}) and its own backing services. Both sides are configured
 * identically. Hardening: the app port is published on 127.0.0.1 only (random host port), no new
 * privileges, an init process and a process limit; nothing from the host is mounted. Pure.
 */
export function buildComposeSpec(recipe: Recipe, options: ComposeSpecOptions): ComposeSpec {
  const services: Record<string, unknown> = {};
  const script = buildAppScript(recipe);
  for (const side of ['base', 'head'] as const) {
    const env: Record<string, string> = { ...DETERMINISTIC_ENV, PORT: String(recipe.port) };
    for (const [key, { value }] of Object.entries(recipe.env)) {
      env[key] = value;
    }
    const dependsOn: Record<string, { condition: string }> = {};
    for (const service of recipe.services) {
      const name = serviceName(service, side);
      env[service.envVar] = serviceUrl(service, side);
      dependsOn[name] = { condition: 'service_healthy' };
      services[name] = backingService(service, side, options);
    }
    services[appService(side)] = {
      image: `node:${recipe.nodeVersion}`,
      working_dir: '/',
      command: ['sh', '-c', script],
      environment: env,
      ports: [`127.0.0.1::${String(recipe.port)}`],
      ...(Object.keys(dependsOn).length > 0 ? { depends_on: dependsOn } : {}),
      ...hardening(options.runId, side, options.limits.appCpus, options.limits.appMemory),
    };
  }
  return { name: composeProjectName(options.runId), services };
}

function backingService(
  service: RecipeService,
  side: Side,
  options: ComposeSpecOptions,
): Record<string, unknown> {
  const common = hardening(
    options.runId,
    side,
    options.limits.serviceCpus,
    options.limits.serviceMemory,
  );
  if (service.kind === 'postgres') {
    return {
      image: `postgres:${service.version}`,
      environment: {
        POSTGRES_USER: POSTGRES.user,
        POSTGRES_PASSWORD: POSTGRES.password,
        POSTGRES_DB: POSTGRES.db,
      },
      healthcheck: {
        test: ['CMD-SHELL', `pg_isready -U ${POSTGRES.user} -d ${POSTGRES.db}`],
        interval: '2s',
        timeout: '3s',
        retries: 60,
      },
      ...common,
    };
  }
  return {
    image: `redis:${service.version}`,
    healthcheck: { test: ['CMD', 'redis-cli', 'ping'], interval: '2s', timeout: '3s', retries: 60 },
    ...common,
  };
}

function hardening(
  runId: string,
  side: Side,
  cpus: number,
  memory: string,
): Record<string, unknown> {
  return {
    init: true,
    cpus,
    mem_limit: memory,
    pids_limit: 4096,
    security_opt: ['no-new-privileges:true'],
    stop_grace_period: '5s',
    labels: { 'dev.bdiff.run': runId, 'dev.bdiff.side': side },
  };
}

/** Compose project name of a run. Run ids are lowercase, as compose requires. */
export function composeProjectName(runId: string): string {
  return `bdiff-${runId}`;
}

/**
 * Renders a compose spec as YAML. Every `$` is doubled: compose would otherwise interpolate
 * variables in env values and the script, and those come from untrusted repository content. Pure.
 */
export function renderCompose(spec: ComposeSpec): string {
  return stringify(escapeDollars(spec), { lineWidth: 0 });
}

function escapeDollars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replaceAll('$', () => '$$');
  }
  if (Array.isArray(value)) {
    return value.map(escapeDollars);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, escapeDollars(item)]),
    );
  }
  return value;
}
