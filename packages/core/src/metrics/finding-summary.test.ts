import { describe, expect, it } from 'vitest';

import { summarizeFindings } from './finding-summary.js';
import type { Finding } from '../domain/finding.js';

const finding = (id: string, severity: Finding['severity']): Finding => ({
  id,
  kind: 'text',
  severity,
  location: { route: '/' },
  evidence: [],
});

describe('summarizeFindings', () => {
  it('counts findings by severity and the distinct unexpected ones', () => {
    const findings = [
      finding('a', 'breaking'),
      finding('b', 'info'),
      finding('c', 'info'),
      finding('d', 'warning'),
    ];

    expect(summarizeFindings(findings)).toEqual({
      info: 2,
      warning: 1,
      breaking: 1,
      unexpected: 0,
    });
    expect(
      summarizeFindings(findings, {
        unexpected: [
          { findingId: 'a', reason: 'x' },
          { findingId: 'a', reason: 'again' },
          { findingId: 'd', reason: 'y' },
        ],
      }).unexpected,
    ).toBe(2);
  });
});
