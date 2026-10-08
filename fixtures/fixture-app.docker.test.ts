import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { nodeFileSystem } from '@bdiff/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BASE_BRANCH, PR_BRANCHES } from './branches.js';
import type { FixtureBranch } from './branches.js';
import { loadExpected } from './expected-schema.js';
import type { Expected } from './expected-schema.js';
import { buildTempFixtureRepo, exec, git } from './test-helpers.js';

const signal = new AbortController().signal;
const RESULT_MARKER = 'BDIFF_FIXTURE_RESULT ';

/**
 * Runs inside the container: install, build, start, wait for health, then fetch every route and
 * print one JSON line with each route's status and body.
 */
function containerScript(paths: readonly string[]): string {
  const probe = `
    const paths = ${JSON.stringify(paths)};
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    (async () => {
      for (let attempt = 0; attempt < 120; attempt++) {
        try { if ((await fetch('http://127.0.0.1:3000/api/health')).ok) break; } catch {}
        await wait(500);
      }
      const results = {};
      for (const route of paths) {
        const response = await fetch('http://127.0.0.1:3000' + route);
        results[route] = { status: response.status, body: await response.text() };
      }
      console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify(results));
    })().catch((error) => { console.error(error); process.exit(1); });
  `;
  return [
    'set -e',
    'cd /app',
    'export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1 CI=1 TZ=UTC NODE_ENV=production',
    'corepack enable',
    'pnpm install --frozen-lockfile --prod=false',
    'pnpm build',
    '(pnpm start > /tmp/server.log 2>&1 &)',
    `node -e ${shellQuote(probe)}`,
  ].join('\n');
}

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

async function docker(args: readonly string[], timeoutMs = 120_000) {
  return exec.run('docker', args, { timeoutMs, signal });
}

describe('fixture app in node:22 (@docker)', () => {
  let repo: Awaited<ReturnType<typeof buildTempFixtureRepo>>;
  let expected: Expected;

  beforeAll(async () => {
    repo = await buildTempFixtureRepo();
    expected = await loadExpected(nodeFileSystem);
  });

  afterAll(async () => {
    await repo.remove();
  });

  it.each<FixtureBranch>([BASE_BRANCH, ...PR_BRANCHES])(
    'installs, builds and serves every route on %s',
    async (branch) => {
      const checkout = path.join(path.dirname(repo.path), branch.replaceAll('/', '-'));
      await git(repo.path, ['worktree', 'add', '--quiet', '--detach', checkout, branch]);
      const container = `bdiff-fixture-test-${randomBytes(4).toString('hex')}`;
      const routes = [
        ...expected.pages,
        ...expected.endpoints.flatMap((endpoint) =>
          endpoint.startsWith('GET ') ? [endpoint.slice('GET '.length)] : [],
        ),
      ];

      try {
        const created = await docker([
          'create',
          '--name',
          container,
          'node:22',
          'sh',
          '-c',
          containerScript(routes),
        ]);
        expect(created.exitCode, created.stderr).toBe(0);
        const copied = await docker(['cp', `${checkout}/.`, `${container}:/app`]);
        expect(copied.exitCode, copied.stderr).toBe(0);

        const run = await docker(['start', '--attach', container], 10 * 60_000);
        expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);

        const line = run.stdout
          .split('\n')
          .find((candidate) => candidate.startsWith(RESULT_MARKER));
        expect(line, run.stdout).toBeDefined();
        const results = JSON.parse((line ?? '').slice(RESULT_MARKER.length)) as Record<
          string,
          { status: number; body: string }
        >;

        for (const route of routes) {
          expect(results[route]?.status, `${branch} ${route}`).toBe(200);
        }
        const latest = JSON.parse(results['/api/orders/latest']?.body ?? '{}') as Record<
          string,
          unknown
        >;
        if (branch === 'pr/api-breaking') {
          expect(latest).toMatchObject({ total: '$42.50', currency: 'USD' });
        } else {
          expect(latest.total).toBe(42.5);
          expect(latest).not.toHaveProperty('currency');
        }
        expect(results['/login']?.body.includes('Continue with Google')).toBe(
          branch === 'pr/ui-change',
        );
      } finally {
        await docker(['rm', '--force', container]);
        await git(repo.path, ['worktree', 'remove', '--force', checkout]);
      }
    },
  );
});
