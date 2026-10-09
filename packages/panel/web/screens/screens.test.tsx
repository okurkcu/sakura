import type { Finding, RunEvent, RunResult } from '@bdiff/core';
import { renderToString } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';

import { describeChange, RunDetailScreen } from './run-detail.js';
import { filterRuns, LiveRun } from './runs.js';
import type { RunDetailResponse, RunSummary } from '../../src/api.js';
import { testRecord } from '../../src/testing/helpers.js';
import { Status } from '../components/common.js';
import { shortPath } from '../components/sidebar.js';

const XSS = '<img src=x onerror=alert(1)><script>alert(document.cookie)</script>';
const RUN = '01k6t3y8k0g3m5x9a2b7c4d6ef';

const loaded = <T,>(data: T) => ({ data, loading: false, reload: () => undefined });

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: RUN,
    state: 'success',
    target: { repoUrl: 'https://github.com/acme/shop', baseRef: 'main', headRef: 'pr/1' },
    dataset: null,
    llmMode: 'off',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 1000,
    findings: { info: 0, warning: 0, breaking: 0, unexpected: 0 },
    costUsd: 0,
    note: '0 findings',
    ...overrides,
  };
}

/** Every way untrusted text could become markup: a raw tag or an event handler attribute. */
function expectNoInjection(html: string) {
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img src=x');
  expect(html).not.toMatch(/<[^>]+\sonerror=/);
  expect(html).toContain('&lt;script>');
}

describe('status rendering', () => {
  it.each(['running', 'success', 'failed', 'skipped', 'interrupted'] as const)(
    'shows %s as a dot and a word',
    (state) => {
      const html = renderToString(<Status state={state} />);

      expect(html).toBe(
        `<span class="status ${state}"><span class="dot" aria-hidden="true"></span>${state}</span>`,
      );
    },
  );
});

describe('filterRuns', () => {
  it('keeps the runs of the selected status', () => {
    const runs = [
      summary({ runId: 'a', state: 'failed' }),
      summary({ runId: 'b' }),
      summary({ runId: 'c', state: 'failed' }),
    ];

    expect(filterRuns(runs, 'failed').map((run) => run.runId)).toEqual(['a', 'c']);
    expect(filterRuns(runs, 'all')).toHaveLength(3);
    expect(filterRuns(runs, 'running')).toEqual([]);
  });
});

describe('escaping untrusted text', () => {
  it('escapes PR titles, findings, response bodies and log lines on the run page', () => {
    const record = testRecord(RUN, { prTitle: XSS });
    const finding: Finding = {
      id: 'f1',
      kind: 'text',
      severity: 'info',
      location: { route: '/login' },
      before: [XSS],
      after: [XSS],
      evidence: [],
    };
    const failed = {
      ...record,
      status: 'failed' as const,
      failure: {
        code: 'SETUP_BUILD_FAILED' as const,
        causes: [],
        message: XSS,
        stage: 'environment' as const,
        details: { logTail: [XSS] },
      },
    };
    const result: RunResult = {
      record: failed,
      findings: [
        finding,
        { ...finding, id: 'f2', kind: 'value-changed', location: { endpoint: `GET /api/${XSS}` } },
      ],
      api: {
        requests: [],
        captures: [],
        notProbed: [{ endpoint: XSS, reason: 'generation-failed', detail: XSS }],
      },
      interpretation: {
        source: 'llm',
        summary: [
          { text: XSS, findingIds: ['f1'] },
          { text: XSS, findingIds: ['f1'] },
        ],
        unexpected: [{ findingId: 'f1', reason: XSS }],
        riskLevel: 'high',
        coverageNote: XSS,
        reviewerChecklist: [XSS],
      },
    };
    const events: RunEvent[] = [
      { type: 'log', at: '2026-01-01T00:00:00.000Z', level: 'error', message: XSS },
    ];
    const detail: RunDetailResponse = {
      summary: summary({ state: 'failed', note: XSS, target: { ...failed.target, prTitle: XSS } }),
      record: failed,
      result,
      events,
      files: ['run.json'],
    };

    const html = renderToString(<RunDetailScreen detail={loaded(detail)} />);

    expectNoInjection(html);
    expect(html).toContain('SETUP_BUILD_FAILED');
  });

  it('escapes log lines and refs on the live run card', () => {
    const html = renderToString(
      <LiveRun
        run={summary({ state: 'running', target: { repoUrl: 'r', baseRef: XSS, headRef: XSS } })}
        now={Date.parse('2026-01-01T00:01:00.000Z')}
        suiteRunning={false}
        onEnd={() => undefined}
      />,
    );

    expectNoInjection(html);
  });
});

describe('describeChange', () => {
  const base: Finding = {
    id: 'x',
    kind: 'type-changed',
    severity: 'breaking',
    location: {},
    evidence: [],
  };

  it.each<[Partial<Finding>, string]>([
    [{ before: 'number', after: 'string' }, 'changed type: "number" → "string"'],
    [{ kind: 'field-added', after: 'USD' }, 'field added: "USD"'],
    [{ kind: 'field-removed', before: 1 }, 'field removed: was 1'],
    [{ kind: 'status-changed', before: 200, after: 500 }, '200 → 500'],
  ])('%o → %s', (overrides, text) => {
    expect(describeChange({ ...base, ...overrides })).toBe(text);
  });
});

describe('shortPath', () => {
  it('keeps the last two segments', () => {
    expect(shortPath('/Users/me/Desktop/sakura/.bdiff')).toBe('…/sakura/.bdiff');
    expect(shortPath('.bdiff')).toBe('.bdiff');
  });
});
