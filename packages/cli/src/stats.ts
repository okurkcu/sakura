import { StageNameSchema } from '@bdiff/core';
import type { RunRecord, StageName } from '@bdiff/core';

import { latestByEntry } from './run-records.js';

/** Median and 90th percentile of a set of values; `null` for an empty set. */
export interface Distribution {
  readonly count: number;
  readonly median: number | null;
  readonly p90: number | null;
}

/** The experiment's numbers for a group of runs. */
export interface GroupStats {
  readonly runs: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly skipRate: number | null;
  /**
   * Setup: runs that tried to set the app up (not skipped, got past the workspace and impact), and
   * those whose apps started.
   */
  readonly setup: {
    readonly attempted: number;
    readonly succeeded: number;
    readonly rate: number | null;
  };
  /** Runs whose setup needed the repair loop, and how many of those it repaired. */
  readonly repaired: { readonly attempted: number; readonly succeeded: number };
  /** Wall time of runs that were not skipped, in ms. */
  readonly durationMs: Distribution;
  /** Time per stage over the runs where it ran, in ms (all its executions summed). */
  readonly stageMs: Partial<Record<StageName, Distribution>>;
  /** LLM cost per run, in USD. */
  readonly llmCostUsd: Distribution & { readonly total: number };
  /** Container run time per run, both sides, in seconds. */
  readonly computeSeconds: Distribution & { readonly total: number };
  /** Differences found that were noise: `noiseDiffs / rawDiffs` over all runs. */
  readonly noiseRatio: number | null;
  /** Findings per successful run. */
  readonly findingsPerRun: Distribution & { readonly mean: number | null };
  /** Successful runs with at least one breaking or unexpected finding. */
  readonly breakingOrUnexpected: { readonly runs: number; readonly rate: number | null };
  /** Failure codes of failed runs, most frequent first. */
  readonly failureReasons: Readonly<Record<string, number>>;
}

/** A success criterion of the experiment, evaluated. */
export interface CriterionResult {
  readonly id: string;
  readonly description: string;
  /** What was measured, readable (e.g. `62% (5/8)`). */
  readonly measured: string;
  readonly verdict: 'pass' | 'fail' | 'n/a';
}

/** Everything `bdiff stats` reports; written as `stats.json`. */
export interface Stats {
  readonly records: number;
  readonly overall: GroupStats;
  /** Present with `--by <tag>`: the same numbers per tag value. */
  readonly groups?: { readonly by: string; readonly values: Readonly<Record<string, GroupStats>> };
  readonly criteria: readonly CriterionResult[];
}

/** Thresholds of the experiment's success criteria (epic SKR-14). */
export const SUCCESS_THRESHOLDS = {
  /** Setup works automatically in at least half the repositories. */
  setupRate: 0.5,
  /** Median run under 10 minutes. */
  medianDurationMs: 10 * 60_000,
  /** At most this share of refactor PRs (no behavior change expected) has a finding. */
  falseDifferenceRate: 0.1,
} as const;

/**
 * Computes the experiment's statistics over run records. Several records of one dataset entry
 * count once (the latest); single runs (no dataset entry) each count. With `by`, the numbers are
 * also grouped by that dataset tag (runs without it go under `(none)`). Pure.
 */
export function computeStats(records: readonly RunRecord[], by?: string): Stats {
  const latest = new Set(latestByEntry(records).values());
  const counted = records.filter((record) => record.dataset === null || latest.has(record));
  const stats: Stats = {
    records: counted.length,
    overall: groupStats(counted),
    criteria: evaluateCriteria(counted),
  };
  if (by === undefined) {
    return stats;
  }
  const values: Record<string, RunRecord[]> = {};
  for (const record of counted) {
    const value = record.dataset?.tags[by] ?? '(none)';
    (values[value] ??= []).push(record);
  }
  return {
    ...stats,
    groups: {
      by,
      values: Object.fromEntries(
        Object.entries(values)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([value, group]) => [value, groupStats(group)]),
      ),
    },
  };
}

/** The numbers for one group of runs. Pure. */
export function groupStats(records: readonly RunRecord[]): GroupStats {
  const skipped = records.filter((record) => record.status === 'skipped');
  const notSkipped = records.filter((record) => record.status !== 'skipped');
  const succeeded = records.filter((record) => record.status === 'success');
  const failed = records.filter((record) => record.status === 'failed');

  const setupAttempted = notSkipped.filter(triedSetup);
  const setupSucceeded = setupAttempted.filter((record) =>
    record.stageTimings.some((t) => t.stage === 'environment' && t.outcome === 'success'),
  );
  const repairs = notSkipped.filter((record) => record.setupAttempts.length > 0);

  const stageMs: Partial<Record<StageName, Distribution>> = {};
  for (const stage of StageNameSchema.options) {
    const times = notSkipped.flatMap((record) => {
      const timings = record.stageTimings.filter((timing) => timing.stage === stage);
      return timings.length === 0 ? [] : [timings.reduce((sum, t) => sum + t.durationMs, 0)];
    });
    if (times.length > 0) {
      stageMs[stage] = distribution(times);
    }
  }

  const raw = records.reduce((sum, record) => sum + record.counts.rawDiffs, 0);
  const noise = records.reduce((sum, record) => sum + record.counts.noiseDiffs, 0);
  const findings = succeeded.map((record) => record.counts.findings);
  const flagged = succeeded.filter(
    (record) => record.findingSummary.breaking > 0 || record.findingSummary.unexpected > 0,
  );
  const costs = records.map((record) => record.totals.llmCostUsd);
  const compute = notSkipped.map((record) => record.totals.computeSeconds);

  const failureReasons: Record<string, number> = {};
  for (const record of failed) {
    failureReasons[record.failure.code] = (failureReasons[record.failure.code] ?? 0) + 1;
  }

  return {
    runs: records.length,
    succeeded: succeeded.length,
    failed: failed.length,
    skipped: skipped.length,
    skipRate: ratio(skipped.length, records.length),
    setup: {
      attempted: setupAttempted.length,
      succeeded: setupSucceeded.length,
      rate: ratio(setupSucceeded.length, setupAttempted.length),
    },
    repaired: {
      attempted: repairs.length,
      succeeded: repairs.filter((r) => r.setupAttempts.some((a) => a.outcome === 'repaired'))
        .length,
    },
    durationMs: distribution(notSkipped.map((record) => record.durationMs)),
    stageMs,
    llmCostUsd: { ...distribution(costs), total: sum(costs) },
    computeSeconds: { ...distribution(compute), total: sum(compute) },
    noiseRatio: ratio(noise, raw),
    findingsPerRun: {
      ...distribution(findings),
      mean: findings.length === 0 ? null : sum(findings) / findings.length,
    },
    breakingOrUnexpected: {
      runs: flagged.length,
      rate: ratio(flagged.length, succeeded.length),
    },
    failureReasons: Object.fromEntries(
      Object.entries(failureReasons).sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)),
    ),
  };
}

/**
 * The epic's success criteria over the counted runs:
 * - setup works automatically in ≥ 50% of the runs that tried it;
 * - the median (not skipped) run takes < 10 minutes;
 * - few false differences: at most 10% of successful `refactor` PRs (no behavior change expected)
 *   have a finding;
 * - the behavior diff shows something the code diff hides: at least one run has a finding the
 *   interpretation flagged as unexpected for the PR's intent.
 *
 * Pure.
 */
export function evaluateCriteria(records: readonly RunRecord[]): CriterionResult[] {
  const overall = groupStats(records);
  const refactors = records.filter(
    (record) => record.status === 'success' && record.dataset?.tags.prType === 'refactor',
  );
  const refactorsWithFindings = refactors.filter((record) => record.counts.findings > 0);
  const falseRate = ratio(refactorsWithFindings.length, refactors.length);
  const unexpected = records.filter((record) => record.findingSummary.unexpected > 0);
  const median = overall.durationMs.median;
  return [
    {
      id: 'setup-success',
      description: 'Setup works automatically in ≥ 50% of repositories',
      measured: fraction(overall.setup.succeeded, overall.setup.attempted),
      verdict:
        overall.setup.rate === null
          ? 'n/a'
          : overall.setup.rate >= SUCCESS_THRESHOLDS.setupRate
            ? 'pass'
            : 'fail',
    },
    {
      id: 'median-duration',
      description: 'Median run < 10 min',
      measured: median === null ? 'no runs' : minutes(median),
      verdict:
        median === null ? 'n/a' : median < SUCCESS_THRESHOLDS.medianDurationMs ? 'pass' : 'fail',
    },
    {
      id: 'false-differences',
      description: 'Few false differences: ≤ 10% of refactor PRs have a finding',
      measured: fraction(refactorsWithFindings.length, refactors.length),
      verdict:
        falseRate === null
          ? 'n/a'
          : falseRate <= SUCCESS_THRESHOLDS.falseDifferenceRate
            ? 'pass'
            : 'fail',
    },
    {
      id: 'hidden-changes',
      description: 'Some PRs show a behavior change their intent does not account for',
      measured: `${String(unexpected.length)} run(s) with an unexpected finding`,
      verdict: records.length === 0 ? 'n/a' : unexpected.length > 0 ? 'pass' : 'fail',
    },
  ];
}

/**
 * Median (mean of the two middle values for an even count) and 90th percentile (nearest rank).
 * Pure.
 */
export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) {
    return { count: 0, median: null, p90: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  const p90 = sorted[Math.ceil(0.9 * sorted.length) - 1] ?? 0;
  return { count: sorted.length, median, p90 };
}

/** Whether a run got as far as setting the app up (recipe, environment or repair ran). */
function triedSetup(record: RunRecord): boolean {
  return record.stageTimings.some(
    (timing) =>
      timing.stage === 'recipe' || timing.stage === 'environment' || timing.stage === 'repair',
  );
}

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function fraction(part: number, whole: number): string {
  return whole === 0
    ? 'no runs'
    : `${String(Math.round((part / whole) * 100))}% (${String(part)}/${String(whole)})`;
}

function minutes(ms: number): string {
  return `${(ms / 60_000).toFixed(1)} min`;
}
