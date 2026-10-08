import { describe, expect, it } from 'vitest';

import { canonicalJson, sortFindings, toFinding } from './findings.js';
import type { FindingDraft } from './findings.js';
import { severityOf } from './severity.js';
import type { SeverityFacts } from './severity.js';
import type { FindingKind, Severity } from '../domain/finding.js';

describe('severityOf', () => {
  it.each<[FindingKind, SeverityFacts, Severity]>([
    ['type-changed', {}, 'breaking'],
    ['field-removed', {}, 'breaking'],
    ['status-changed', { statusBefore: 200, statusAfter: 500 }, 'breaking'],
    ['status-changed', { statusBefore: 302, statusAfter: 404 }, 'breaking'],
    ['status-changed', { statusBefore: 200, statusAfter: 201 }, 'warning'],
    ['status-changed', { statusBefore: 500, statusAfter: 200 }, 'warning'],
    ['runtime-error', { pageError: true }, 'breaking'],
    ['runtime-error', {}, 'warning'],
    ['failed-request', { noLongerAnswers: true }, 'breaking'],
    ['failed-request', {}, 'warning'],
    ['field-added', {}, 'warning'],
    ['content-type-changed', {}, 'warning'],
    ['value-changed', {}, 'info'],
    ['visual', {}, 'info'],
    ['text', {}, 'info'],
  ])('rates %s with %j as %s', (kind, facts, severity) => {
    expect(severityOf(kind, facts)).toBe(severity);
  });
});

describe('toFinding', () => {
  const draft: FindingDraft = {
    kind: 'type-changed',
    severity: 'breaking',
    location: { endpoint: 'GET /api/orders/latest', jsonPath: '$.total' },
    before: 42,
    after: '$42.00',
    evidence: ['/out/runs/01aaa/api/baseA/x.json', undefined, '/out/runs/01aaa/api/head/x.json'],
  };

  it('has a stable id that ignores evidence paths (they contain the run id)', () => {
    const finding = toFinding(draft);
    const otherRun = toFinding({ ...draft, evidence: ['/out/runs/01bbb/api/head/x.json'] });

    expect(finding.id).toMatch(/^[0-9a-f]{16}$/);
    expect(otherRun.id).toBe(finding.id);
    expect(toFinding({ ...draft, after: '$43.00' }).id).not.toBe(finding.id);
    expect(toFinding({ ...draft, requestKey: 'GET /api/orders/latest #2' }).id).not.toBe(
      finding.id,
    );
    expect(finding.evidence).toEqual([
      '/out/runs/01aaa/api/baseA/x.json',
      '/out/runs/01aaa/api/head/x.json',
    ]);
  });

  it('serializes keys in order for the id', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ f: 1, e: 2 }] } })).toBe(
      '{"a":{"c":[{"e":2,"f":1}],"d":2},"b":1}',
    );
    expect(
      toFinding({ ...draft, location: { jsonPath: '$.total', endpoint: 'GET /api/orders/latest' } })
        .id,
    ).toBe(toFinding(draft).id);
  });
});

describe('sortFindings', () => {
  it('puts breaking first, then orders by place and kind', () => {
    const findings = [
      toFinding({ kind: 'text', severity: 'info', location: { route: '/b' }, evidence: [] }),
      toFinding({
        kind: 'field-added',
        severity: 'warning',
        location: { endpoint: 'GET /x', jsonPath: '$.a' },
        evidence: [],
      }),
      toFinding({ kind: 'visual', severity: 'info', location: { route: '/a' }, evidence: [] }),
      toFinding({
        kind: 'type-changed',
        severity: 'breaking',
        location: { endpoint: 'GET /x', jsonPath: '$.b' },
        evidence: [],
      }),
    ];

    expect(sortFindings(findings).map((finding) => finding.kind)).toEqual([
      'type-changed',
      'field-added',
      'visual',
      'text',
    ]);
    expect(sortFindings(findings)).toEqual(sortFindings([...findings].reverse()));
  });
});
