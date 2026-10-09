import type { FindingSummary } from './run-record.js';
import type { Finding } from '../domain/finding.js';
import type { Interpretation } from '../domain/interpretation.js';

/**
 * Counts findings by severity, and the distinct findings the interpretation (if any) flagged as
 * unexpected for the PR's stated intent. Pure.
 */
export function summarizeFindings(
  findings: readonly Finding[],
  interpretation?: Pick<Interpretation, 'unexpected'>,
): FindingSummary {
  const bySeverity = (severity: Finding['severity']): number =>
    findings.filter((finding) => finding.severity === severity).length;
  return {
    info: bySeverity('info'),
    warning: bySeverity('warning'),
    breaking: bySeverity('breaking'),
    unexpected: new Set(interpretation?.unexpected.map((entry) => entry.findingId) ?? []).size,
  };
}
