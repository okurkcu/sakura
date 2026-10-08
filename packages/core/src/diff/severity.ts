import type { FindingKind, Severity } from '../domain/finding.js';

/** Facts that can raise a finding's severity above its kind's default. */
export interface SeverityFacts {
  /** A runtime error that is an uncaught exception, not a console message. */
  readonly pageError?: boolean;
  /** The page or endpoint answered on base and no longer answers on head. */
  readonly noLongerAnswers?: boolean;
  readonly statusBefore?: number;
  readonly statusAfter?: number;
}

/** One rule of {@link SEVERITY_RULES}. */
export interface SeverityRule {
  readonly kind: FindingKind;
  readonly severity: Severity;
  /** The rule applies only when this holds; a rule without it always applies. */
  readonly when?: (facts: SeverityFacts) => boolean;
  /** Why, for the docs and the report. */
  readonly reason: string;
}

/**
 * Every severity rule, in one table: the first rule of a finding's kind whose `when` holds wins.
 * Breaking: what a client or user relies on stops working. Warning: likely unintended. Info:
 * visible change that may well be intended.
 */
export const SEVERITY_RULES: readonly SeverityRule[] = [
  { kind: 'type-changed', severity: 'breaking', reason: 'clients parse the old type' },
  { kind: 'field-removed', severity: 'breaking', reason: 'clients read the removed field' },
  {
    kind: 'status-changed',
    severity: 'breaking',
    when: (facts) =>
      facts.statusBefore !== undefined &&
      facts.statusAfter !== undefined &&
      facts.statusBefore < 400 &&
      facts.statusAfter >= 400,
    reason: 'a working page or endpoint now fails',
  },
  { kind: 'status-changed', severity: 'warning', reason: 'a different status' },
  {
    kind: 'runtime-error',
    severity: 'breaking',
    when: (facts) => facts.pageError === true,
    reason: 'a new uncaught exception',
  },
  { kind: 'runtime-error', severity: 'warning', reason: 'a new console error' },
  {
    kind: 'failed-request',
    severity: 'breaking',
    when: (facts) => facts.noLongerAnswers === true,
    reason: 'the page or endpoint no longer answers',
  },
  { kind: 'failed-request', severity: 'warning', reason: 'a request of the page now fails' },
  { kind: 'field-added', severity: 'warning', reason: 'a new field in a response' },
  { kind: 'content-type-changed', severity: 'warning', reason: 'clients may not parse it' },
  { kind: 'value-changed', severity: 'info', reason: 'same shape, another value' },
  { kind: 'visual', severity: 'info', reason: 'the page looks different' },
  { kind: 'text', severity: 'info', reason: 'the page reads different' },
];

/** The severity of a finding of `kind`, from {@link SEVERITY_RULES}. Pure. */
export function severityOf(kind: FindingKind, facts: SeverityFacts = {}): Severity {
  const rule = SEVERITY_RULES.find(
    (candidate) => candidate.kind === kind && (candidate.when?.(facts) ?? true),
  );
  return rule?.severity ?? 'info';
}
