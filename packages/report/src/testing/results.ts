// Run results shaped like the fixture's runs, for the report tests. Not part of the build.
import { BdiffError, createArtifactPaths } from '@bdiff/core';
import type { ApiCapture, ArtifactPaths, Finding, RunResult, Target, UiCapture } from '@bdiff/core';
import { createTestRunRecorder, TEST_RUN_ID } from '@bdiff/core/testing';

/** the artifact paths every test result uses. */
export const TEST_PATHS: ArtifactPaths = createArtifactPaths('/test/.bdiff', TEST_RUN_ID);

const SHA_BASE = '1'.repeat(40);
const SHA_HEAD = '2'.repeat(40);

/** the fixture repository as a target, with the given PR text. */
export const fixtureTarget = (overrides: Partial<Target> = {}): Target => ({
  repoUrl: '/tmp/bdiff-fixture',
  baseRef: 'main',
  headRef: 'pr/ui-change',
  prNumber: 7,
  prTitle: 'Add "Continue with Google" and format the latest order total',
  ...overrides,
});

const uiCapture = (probeRun: UiCapture['probeRun'], route: string, text: string): UiCapture => ({
  probeRun,
  route,
  status: 200,
  title: 'Sample shop',
  text,
  screenshot: TEST_PATHS.uiScreenshot(probeRun, route),
  consoleErrors: [],
  pageErrors: [],
  failedRequests: [],
  blockedRequests: [],
  settled: true,
  durationMs: 812,
});

const apiCapture = (
  probeRun: ApiCapture['probeRun'],
  json: Record<string, unknown>,
): ApiCapture => ({
  probeRun,
  requestKey: 'GET /api/orders/latest',
  durationMs: 41,
  artifact: TEST_PATHS.apiResponse(probeRun, 'GET /api/orders/latest'),
  response: {
    status: 200,
    contentType: 'application/json',
    headers: { 'content-type': 'application/json' },
    authRequired: false,
    body: { kind: 'json', json: json as never, sha256: 'a'.repeat(64) },
  },
});

/** findings like the fixture's `ui-change` and `api-breaking` branches produce. */
export const FIXTURE_FINDINGS: Finding[] = [
  {
    id: '7c1e4a0b9d2f3e58',
    kind: 'type-changed',
    severity: 'breaking',
    location: { endpoint: 'GET /api/orders/latest', jsonPath: '$.total' },
    before: 42,
    after: '$42.00',
    evidence: [
      TEST_PATHS.apiResponse('baseA', 'GET /api/orders/latest'),
      TEST_PATHS.apiResponse('head', 'GET /api/orders/latest'),
    ],
  },
  {
    id: '0f9a8b7c6d5e4f31',
    kind: 'field-added',
    severity: 'warning',
    location: { endpoint: 'GET /api/orders/latest', jsonPath: '$.currency' },
    after: 'USD',
    evidence: [
      TEST_PATHS.apiResponse('baseA', 'GET /api/orders/latest'),
      TEST_PATHS.apiResponse('head', 'GET /api/orders/latest'),
    ],
  },
  {
    id: '5b4c3d2e1f0a9b88',
    kind: 'runtime-error',
    severity: 'warning',
    location: { route: '/login' },
    after: { source: 'console-error', message: 'Google SDK failed to load' },
    evidence: [TEST_PATHS.uiScreenshot('head', '/login')],
  },
  {
    id: 'a83d0e6b91f24c07',
    kind: 'text',
    severity: 'info',
    location: { route: '/login' },
    before: [],
    after: ['or', 'Continue with Google'],
    evidence: [
      TEST_PATHS.uiScreenshot('baseA', '/login'),
      TEST_PATHS.uiScreenshot('head', '/login'),
    ],
  },
  {
    id: '4f1c2a9e0b7d3c55',
    kind: 'visual',
    severity: 'info',
    location: { route: '/login', bbox: { x: 24, y: 214, width: 238, height: 61 } },
    after: { regions: [{ x: 24, y: 214, width: 238, height: 61 }], changedPixels: 5321 },
    evidence: [
      TEST_PATHS.uiScreenshot('baseA', '/login'),
      TEST_PATHS.uiScreenshot('head', '/login'),
      TEST_PATHS.diffOverlay('/login'),
    ],
  },
];

/** a successful run with findings, an interpretation and every section filled. */
export function successResult(target: Target = fixtureTarget()): RunResult {
  const { recorder, clock } = createTestRunRecorder({ target });
  for (const stage of [
    'workspace',
    'impact',
    'recipe',
    'environment',
    'probe-ui',
    'probe-api',
    'diff',
    'interpret',
  ] as const) {
    void recorder.timer.measure(stage, () => {
      clock.advance(1_500);
      return Promise.resolve();
    });
  }
  recorder.recordLlmUsage('interpret', {
    model: 'test-model',
    inputTokens: 4_200,
    outputTokens: 380,
    cacheReadTokens: 3_100,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
  });
  recorder.addCounts({
    routesProbed: 1,
    endpointsProbed: 1,
    rawDiffs: 7,
    noiseDiffs: 2,
    findings: FIXTURE_FINDINGS.length,
  });
  recorder.setRiskLevel('high');
  return {
    record: recorder.finish({ status: 'success' }),
    workspace: {
      basePath: '/w/base',
      headPath: '/w/head',
      baseSha: SHA_BASE,
      headSha: SHA_HEAD,
      changedFiles: [
        { status: 'modified', path: 'app/login/page.tsx' },
        { status: 'modified', path: 'app/api/orders/latest/route.ts' },
      ],
    },
    impact: {
      pages: [{ path: '/login', kind: 'page', file: 'app/login/page.tsx', dynamic: false }],
      endpoints: [
        {
          path: '/api/orders/latest',
          kind: 'api',
          method: 'GET',
          file: 'app/api/orders/latest/route.ts',
          dynamic: false,
        },
      ],
      notProbed: [
        {
          route: {
            path: '/blog/[slug]',
            kind: 'page',
            file: 'app/blog/[slug]/page.tsx',
            dynamic: true,
          },
          reason: 'dynamic-params',
        },
      ],
      confidence: 'high',
      unmappedFiles: [],
      notes: [],
    },
    recipe: {
      installRoot: '.',
      appRoot: '.',
      nodeVersion: '22',
      packageManager: { name: 'pnpm', version: '12.9.1' },
      installCmd: ['pnpm', 'install', '--frozen-lockfile'],
      buildCmd: ['pnpm', 'run', 'build'],
      startCmd: ['pnpm', 'exec', 'next', 'start', '-p', '3000', '-H', '0.0.0.0'],
      port: 3000,
      healthPath: '/api/health',
      env: {},
      missingEnv: [],
      services: [],
      dbSetupCmds: [],
      confidence: 'high',
      notes: [],
    },
    ui: [
      uiCapture('baseA', '/login', 'Log in\nSign in'),
      uiCapture('baseB', '/login', 'Log in\nSign in'),
      uiCapture('head', '/login', 'Log in\nSign in\nor\nContinue with Google'),
    ],
    api: {
      requests: [
        {
          key: 'GET /api/orders/latest',
          source: 'route',
          method: 'GET',
          path: '/api/orders/latest',
          headers: {},
          endpoint: 'GET /api/orders/latest',
        },
        {
          key: 'POST /api/feedback',
          source: 'generated',
          method: 'POST',
          path: '/api/feedback',
          headers: {},
          body: { contentType: 'application/json', text: '{"message":"Great mugs","rating":5}' },
          description: 'Five-star feedback with a message',
          endpoint: 'POST /api/feedback',
        },
      ],
      captures: [
        apiCapture('baseA', { id: 1001, total: 42, items: [{ sku: 'mug', qty: 2 }] }),
        apiCapture('baseB', { id: 1001, total: 42, items: [{ sku: 'mug', qty: 2 }] }),
        apiCapture('head', {
          id: 1001,
          total: '$42.00',
          currency: 'USD',
          items: [{ sku: 'mug', qty: 2 }],
        }),
      ],
      notProbed: [],
    },
    findings: FIXTURE_FINDINGS,
    interpretation: {
      source: 'llm',
      summary: [
        {
          text: 'The login page gained an "or" separator and a "Continue with Google" button.',
          findingIds: ['a83d0e6b91f24c07', '4f1c2a9e0b7d3c55'],
        },
        {
          text: 'GET /api/orders/latest now returns total as a formatted string and adds currency.',
          findingIds: ['7c1e4a0b9d2f3e58', '0f9a8b7c6d5e4f31'],
        },
      ],
      unexpected: [
        {
          findingId: '7c1e4a0b9d2f3e58',
          reason:
            'The intent mentions formatting only; clients reading total as a number will break.',
        },
      ],
      riskLevel: 'high',
      coverageNote: 'The dynamic route /blog/[slug] was not probed.',
      reviewerChecklist: ['Check API clients that read total as a number.'],
      model: 'test-model',
    },
  };
}

/** a run that failed building head, with the log tail the environment stage records. */
export function failedResult(): RunResult {
  const { recorder, clock } = createTestRunRecorder({
    target: fixtureTarget({ headRef: 'test/broken-build' }),
  });
  void recorder.timer.measure('workspace', () => {
    clock.advance(900);
    return Promise.resolve();
  });
  const error = new BdiffError('SETUP_BUILD_FAILED', 'Building head failed (exit code 103)', {
    details: {
      side: 'head',
      exitCode: 103,
      logTail: [
        '> next build',
        './app/login/page.tsx:1:38',
        'Error: Expected "}" but found end of file',
        'Build failed',
      ],
    },
  });
  return { record: recorder.finish({ status: 'failed', error, stage: 'environment' }) };
}

/** a docs-only run, skipped by the impact stage. */
export function skippedResult(): RunResult {
  const { recorder } = createTestRunRecorder({
    target: fixtureTarget({ headRef: 'pr/docs-only', prTitle: 'Document the pages in the README' }),
  });
  return {
    record: recorder.finish({ status: 'skipped', reason: 'docs-only' }),
    workspace: {
      basePath: '/w/base',
      headPath: '/w/head',
      baseSha: SHA_BASE,
      headSha: SHA_HEAD,
      changedFiles: [{ status: 'modified', path: 'README.md' }],
    },
  };
}
