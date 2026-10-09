import type { Finding, LlmMode, RunRecord, RunResult } from '@bdiff/core';
import { z } from 'zod';

import type { FixtureCheck, FixtureResponse } from '../api.js';
import { runRelativePath } from '../paths.js';

const LocationSchema = z.looseObject({
  route: z.string().exactOptional(),
  endpoint: z.string().exactOptional(),
  jsonPath: z.string().exactOptional(),
});

/**
 * The parts of `fixtures/expected.json` the panel checks (its full schema lives in
 * `@bdiff/fixtures`; the panel reads the file as data and validates what it uses).
 */
export const ExpectedFixtureSchema = z.looseObject({
  baseBranch: z.string().min(1),
  noisyRoutes: z.array(z.string()),
  branches: z.record(
    z.string(),
    z.looseObject({
      description: z.string(),
      impact: z.looseObject({
        skip: z.looseObject({ reason: z.string() }).exactOptional(),
        routes: z.array(z.string()),
      }),
      findings: z.array(
        z.looseObject({ kind: z.string(), severity: z.string(), location: LocationSchema }),
      ),
    }),
  ),
});
export type ExpectedFixture = z.infer<typeof ExpectedFixtureSchema>;

/** A finished run and what it produced. */
export interface FixtureRun {
  readonly record: RunRecord;
  readonly result?: RunResult;
}

/** Whether runs left Docker resources behind. */
export type Leftovers =
  | { readonly status: 'clean' }
  | { readonly status: 'leftovers'; readonly items: readonly string[] }
  | { readonly status: 'unknown'; readonly reason: string };

/** The latest finished run of each fixture branch (same base branch), by start time. Pure. */
export function latestFixtureRuns(
  expected: ExpectedFixture,
  runs: readonly FixtureRun[],
): Map<string, FixtureRun> {
  const latest = new Map<string, FixtureRun>();
  for (const run of runs) {
    const { target, startedAt } = run.record;
    if (target.baseRef !== expected.baseBranch || !(target.headRef in expected.branches)) {
      continue;
    }
    const current = latest.get(target.headRef);
    if (current === undefined || current.record.startedAt < startedAt) {
      latest.set(target.headRef, run);
    }
  }
  return latest;
}

/**
 * Compares the latest run of every fixture branch with `expected.json`: one check per branch
 * (skip reason, or exactly the expected findings and probed pages), one that no noisy page ever
 * has a finding, and one that no Docker resources were left behind. Pure.
 */
export function checkFixture(
  expected: ExpectedFixture,
  runs: readonly FixtureRun[],
  leftovers: Leftovers,
  llmMode: LlmMode,
): FixtureResponse {
  const latest = latestFixtureRuns(expected, runs);
  const checks: FixtureCheck[] = Object.entries(expected.branches).map(([branch, want]) =>
    checkBranch(branch, want, latest.get(branch), llmMode, expected.baseBranch),
  );
  checks.push(checkNoise(expected, [...latest.values()]));
  checks.push(checkCleanup(leftovers));
  const lastRunAt = [...latest.values()]
    .map((run) => run.record.startedAt)
    .sort()
    .at(-1);
  return { available: true, checks, lastRunAt: lastRunAt ?? null };
}

type ExpectedBranch = ExpectedFixture['branches'][string];
type ExpectedFinding = ExpectedBranch['findings'][number];

function checkBranch(
  branch: string,
  want: ExpectedBranch,
  run: FixtureRun | undefined,
  llmMode: LlmMode,
  baseBranch: string,
): FixtureCheck {
  const expectedText =
    want.impact.skip === undefined
      ? describeFindings(want.findings)
      : `skipped: ${want.impact.skip.reason}`;
  const base = { id: `branch:${branch}`, title: branch, expected: expectedText };
  if (run === undefined) {
    return {
      ...base,
      status: 'missing',
      actual: 'not run yet',
      problems: [],
      rerun: `pnpm bdiff batch "$(pnpm --silent fixture:dataset)" --llm ${llmMode}`,
    };
  }
  const { record, result } = run;
  const runInfo = {
    runId: record.runId,
    rerun: `pnpm bdiff run --repo ${record.target.repoUrl} --base ${baseBranch} --head ${branch} --llm ${llmMode}`,
  };
  if (want.impact.skip !== undefined) {
    const ok = record.status === 'skipped' && record.skip.reason === want.impact.skip.reason;
    return {
      ...base,
      ...runInfo,
      status: ok ? 'pass' : 'fail',
      actual: describeRecord(record, result),
      problems: ok ? [] : [`expected the run to be skipped with ${want.impact.skip.reason}`],
      ...(ok ? {} : { stage: 'impact' as const }),
    };
  }
  if (record.status !== 'success') {
    return {
      ...base,
      ...runInfo,
      status: 'fail',
      actual: describeRecord(record, result),
      problems: [
        record.status === 'failed'
          ? `the run failed: ${record.failure.code}: ${record.failure.message}`
          : `the run was skipped: ${record.skip.reason}`,
      ],
      ...(record.status === 'failed' && record.failure.stage !== undefined
        ? { stage: record.failure.stage }
        : { stage: 'impact' as const }),
    };
  }
  if (result?.findings === undefined) {
    return {
      ...base,
      ...runInfo,
      status: 'missing',
      actual: `${String(record.counts.findings)} finding(s); no result.json to compare them`,
      problems: ['the run has no result.json (recorded before the panel existed); run it again'],
    };
  }
  const problems: string[] = [];
  const missing = subtract(want.findings.map(expectedKey), result.findings.map(actualKey));
  const extra = subtract(result.findings.map(actualKey), want.findings.map(expectedKey));
  problems.push(...missing.map((key) => `missing finding: ${key}`));
  problems.push(...extra.map((key) => `unexpected finding: ${key}`));
  const pages = (result.impact?.pages ?? []).map((page) => page.path).sort();
  const wantPages = [...want.impact.routes].sort();
  const pagesDiffer = pages.join(',') !== wantPages.join(',');
  if (pagesDiffer) {
    problems.push(
      `probed pages ${pages.join(', ') || 'none'}, expected ${wantPages.join(', ') || 'none'}`,
    );
  }
  const findingsDiffer = missing.length > 0 || extra.length > 0;
  return {
    ...base,
    ...runInfo,
    status: problems.length === 0 ? 'pass' : 'fail',
    actual: describeRecord(record, result),
    problems,
    ...(findingsDiffer
      ? { stage: 'diff' as const }
      : pagesDiffer
        ? { stage: 'impact' as const }
        : {}),
  };
}

function checkNoise(expected: ExpectedFixture, runs: readonly FixtureRun[]): FixtureCheck {
  const noisy = new Set(expected.noisyRoutes);
  const routes = expected.noisyRoutes.join(', ');
  const base = {
    id: 'noise',
    title: `noise · ${routes}`,
    expected: `No finding on ${routes} in any branch`,
  };
  const probed = runs.filter((run) =>
    (run.result?.ui ?? []).some((capture) => noisy.has(capture.route)),
  );
  const offending = runs.flatMap((run) =>
    (run.result?.findings ?? [])
      .filter(
        (finding) => finding.location.route !== undefined && noisy.has(finding.location.route),
      )
      .map((finding) => ({ run, finding })),
  );
  const first = offending[0];
  if (first !== undefined) {
    const route = first.finding.location.route ?? '';
    const { runId } = first.run.record;
    const screenshots: Partial<Record<'baseA' | 'baseB' | 'head', string>> = {};
    for (const capture of first.run.result?.ui ?? []) {
      const relative =
        capture.route === route && capture.screenshot !== undefined
          ? runRelativePath(capture.screenshot, runId)
          : undefined;
      if (relative !== undefined) {
        screenshots[capture.probeRun] = relative;
      }
    }
    return {
      ...base,
      status: 'fail',
      actual: `${String(offending.length)} finding(s): ${offending
        .map(
          ({ run, finding }) =>
            `${finding.kind} on ${finding.location.route ?? ''} in ${run.record.target.headRef}`,
        )
        .join('; ')}`,
      runId,
      stage: 'diff',
      problems: offending.map(({ finding }) => describeFinding(finding)),
      evidence: { runId, route, screenshots },
      rerun: `pnpm bdiff run --repo ${first.run.record.target.repoUrl} --base ${expected.baseBranch} --head ${first.run.record.target.headRef}`,
    };
  }
  return probed.length === 0
    ? { ...base, status: 'missing', actual: `no run probed ${routes} yet`, problems: [] }
    : {
        ...base,
        status: 'pass',
        actual: `no finding in ${String(probed.length)} run(s) that probed it`,
        problems: [],
      };
}

function checkCleanup(leftovers: Leftovers): FixtureCheck {
  const base = {
    id: 'cleanup',
    title: 'cleanup',
    expected: 'No bdiff containers, networks or volumes left behind',
  };
  switch (leftovers.status) {
    case 'clean':
      return { ...base, status: 'pass', actual: 'nothing left behind', problems: [] };
    case 'leftovers':
      return {
        ...base,
        status: 'fail',
        actual: `${String(leftovers.items.length)} left behind`,
        problems: [...leftovers.items],
        stage: 'environment',
        rerun: 'docker ps -a --filter name=bdiff-',
      };
    case 'unknown':
      return { ...base, status: 'missing', actual: leftovers.reason, problems: [] };
  }
}

function expectedKey(finding: ExpectedFinding): string {
  return findingKey(finding.kind, finding.severity, finding.location);
}

function actualKey(finding: Finding): string {
  return findingKey(finding.kind, finding.severity, finding.location);
}

function findingKey(
  kind: string,
  severity: string,
  location: { readonly route?: string; readonly endpoint?: string; readonly jsonPath?: string },
): string {
  const where = [location.route, location.endpoint, location.jsonPath]
    .filter((part) => part !== undefined)
    .join(' ');
  return `${kind} ${severity} ${where}`;
}

/** Items of `from` not matched one-to-one by an item of `remove` (multiset difference). */
function subtract(from: readonly string[], remove: readonly string[]): string[] {
  const left = [...remove];
  return from.filter((item) => {
    const at = left.indexOf(item);
    if (at >= 0) {
      left.splice(at, 1);
      return false;
    }
    return true;
  });
}

function describeFindings(findings: readonly ExpectedFinding[]): string {
  return findings.length === 0
    ? '0 findings'
    : findings
        .map((finding) => findingKey(finding.kind, finding.severity, finding.location))
        .join('; ');
}

function describeFinding(finding: Finding): string {
  return actualKey(finding);
}

function describeRecord(record: RunRecord, result: RunResult | undefined): string {
  switch (record.status) {
    case 'skipped':
      return `skipped: ${record.skip.reason}`;
    case 'failed':
      return `failed at ${record.failure.stage ?? 'unknown stage'}: ${record.failure.code}`;
    case 'success': {
      const findings = result?.findings;
      return findings === undefined
        ? `${String(record.counts.findings)} finding(s)`
        : findings.length === 0
          ? '0 findings'
          : findings.map(describeFinding).join('; ');
    }
  }
}
