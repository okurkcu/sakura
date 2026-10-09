import type { Finding, UiCapture } from '@bdiff/core';
import { describe, expect, it } from 'vitest';

import { checkFixture, ExpectedFixtureSchema, latestFixtureRuns } from './fixture-check.js';
import type { ExpectedFixture, FixtureRun } from './fixture-check.js';
import { testRecord, testResult } from '../testing/helpers.js';

const expected: ExpectedFixture = ExpectedFixtureSchema.parse({
  baseBranch: 'main',
  noisyRoutes: ['/dashboard'],
  branches: {
    'pr/ui-change': {
      description: 'login button',
      impact: { routes: ['/login'], endpoints: [] },
      findings: [
        { kind: 'visual', severity: 'info', location: { route: '/login' } },
        { kind: 'text', severity: 'info', location: { route: '/login' } },
      ],
    },
    'pr/docs-only': {
      description: 'readme',
      impact: { skip: { reason: 'docs-only' }, routes: [], endpoints: [] },
      findings: [],
    },
  },
});

const finding = (
  kind: Finding['kind'],
  route: string,
  severity: Finding['severity'] = 'info',
): Finding => ({
  id: `${kind}-${route}`,
  kind,
  severity,
  location: { route, bbox: { x: 0, y: 0, width: 1, height: 1 } },
  evidence: [],
});

const page = (path: string) => ({
  path,
  kind: 'page' as const,
  file: `app${path}/page.tsx`,
  dynamic: false,
});

const capture = (runId: string, probeRun: UiCapture['probeRun'], route: string): UiCapture => ({
  probeRun,
  route,
  status: 200,
  title: '',
  text: '',
  screenshot: `/somewhere/.bdiff/runs/${runId}/ui/${probeRun}/dashboard-12345678.png`,
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  blockedRequests: [],
  settled: true,
  durationMs: 10,
});

function uiRun(
  runId: string,
  findings: Finding[],
  startedAt = '2026-01-02T00:00:00.000Z',
): FixtureRun {
  const record = testRecord(runId, { headRef: 'pr/ui-change', startedAt });
  return {
    record,
    result: testResult(record, {
      findings,
      impact: {
        pages: [page('/login')],
        endpoints: [],
        notProbed: [],
        confidence: 'high',
        unmappedFiles: [],
        notes: [],
      },
      ui: [],
    }),
  };
}

const docsRun = (): FixtureRun => ({
  record: testRecord('01k6t3yddddddddddddddddddd', { headRef: 'pr/docs-only', status: 'skipped' }),
});

describe('checkFixture', () => {
  it('passes a branch with exactly the expected findings, and a skipped docs branch', () => {
    const report = checkFixture(
      expected,
      [
        uiRun('01k6t3y8k0g3m5x9a2b7c4d6ef', [
          finding('visual', '/login'),
          finding('text', '/login'),
        ]),
        docsRun(),
      ],
      { status: 'clean' },
      'off',
    );

    expect(report.checks.map((check) => [check.id, check.status])).toEqual([
      ['branch:pr/ui-change', 'pass'],
      ['branch:pr/docs-only', 'pass'],
      ['noise', 'missing'],
      ['cleanup', 'pass'],
    ]);
    expect(report.checks[0]?.rerun).toBe(
      `pnpm bdiff run --repo https://github.com/acme/shop.git --base main --head pr/ui-change --llm off`,
    );
  });

  it('fails a branch with a missing or an extra finding, owned by the diff stage', () => {
    const report = checkFixture(
      expected,
      [
        uiRun('01k6t3y8k0g3m5x9a2b7c4d6ef', [
          finding('visual', '/login'),
          finding('runtime-error', '/login', 'warning'),
        ]),
      ],
      { status: 'clean' },
      'fake',
    );

    expect(report.checks[0]).toMatchObject({
      status: 'fail',
      stage: 'diff',
      problems: [
        'missing finding: text info /login',
        'unexpected finding: runtime-error warning /login',
      ],
    });
  });

  it('uses the latest run of a branch', () => {
    const runs = [
      uiRun('01k6t3y8k0g3m5x9a2b7c4d6ef', [], '2026-01-01T00:00:00.000Z'),
      uiRun(
        '01k6t3y9aaaaaaaaaaaaaaaaaa',
        [finding('visual', '/login'), finding('text', '/login')],
        '2026-01-03T00:00:00.000Z',
      ),
    ];

    expect(latestFixtureRuns(expected, runs).get('pr/ui-change')?.record.runId).toBe(
      '01k6t3y9aaaaaaaaaaaaaaaaaa',
    );
    expect(checkFixture(expected, runs, { status: 'clean' }, 'off').checks[0]?.status).toBe('pass');
  });

  it('marks a branch never run as missing, with a command to run the suite', () => {
    const check = checkFixture(expected, [], { status: 'clean' }, 'off').checks[0];

    expect(check).toMatchObject({ status: 'missing', actual: 'not run yet' });
    expect(check?.rerun).toContain('fixture:dataset');
  });

  it('fails the noise check when a noisy page has a finding, with its three screenshots', () => {
    const runId = '01k6t3y8k0g3m5x9a2b7c4d6ef';
    const run = uiRun(runId, [
      finding('visual', '/login'),
      finding('text', '/login'),
      finding('visual', '/dashboard'),
    ]);
    const withCaptures: FixtureRun = {
      record: run.record,
      result: {
        ...(run.result ?? { record: run.record }),
        ui: (['baseA', 'baseB', 'head'] as const).map((probeRun) =>
          capture(runId, probeRun, '/dashboard'),
        ),
      },
    };

    const noise = checkFixture(expected, [withCaptures], { status: 'clean' }, 'off').checks.find(
      (check) => check.id === 'noise',
    );

    expect(noise).toMatchObject({
      status: 'fail',
      stage: 'diff',
      evidence: {
        runId,
        route: '/dashboard',
        screenshots: {
          baseA: 'ui/baseA/dashboard-12345678.png',
          baseB: 'ui/baseB/dashboard-12345678.png',
          head: 'ui/head/dashboard-12345678.png',
        },
      },
    });
  });

  it('reports leftovers, or that Docker could not be asked', () => {
    const leftovers = checkFixture(
      expected,
      [],
      { status: 'leftovers', items: ['container bdiff-x'] },
      'off',
    );
    const unknown = checkFixture(
      expected,
      [],
      { status: 'unknown', reason: 'Docker is not reachable' },
      'off',
    );

    expect(leftovers.checks.at(-1)).toMatchObject({
      status: 'fail',
      problems: ['container bdiff-x'],
    });
    expect(unknown.checks.at(-1)).toMatchObject({
      status: 'missing',
      actual: 'Docker is not reachable',
    });
  });

  it('fails a branch whose run failed, owned by the stage that failed', () => {
    const record = testRecord('01k6t3y8k0g3m5x9a2b7c4d6ef', { headRef: 'pr/ui-change' });
    const failed: FixtureRun = {
      record: {
        ...record,
        status: 'failed',
        failure: {
          code: 'SETUP_BUILD_FAILED' as const,
          causes: [],
          message: 'build failed',
          stage: 'environment',
          details: {},
        },
      },
    };

    expect(checkFixture(expected, [failed], { status: 'clean' }, 'off').checks[0]).toMatchObject({
      status: 'fail',
      stage: 'environment',
      actual: 'failed at environment: SETUP_BUILD_FAILED',
    });
  });

  it('ignores runs of other base branches or repositories’ branches', () => {
    const record = testRecord('01k6t3y8k0g3m5x9a2b7c4d6ef', { headRef: 'feature/x' });

    expect(latestFixtureRuns(expected, [{ record }]).size).toBe(0);
  });
});
