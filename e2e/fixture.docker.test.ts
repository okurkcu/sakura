import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { EXIT_CODES } from '@bdiff/cli';
import {
  createArtifactPaths,
  createExecaExec,
  INTERPRET_PURPOSE,
  nodeFileSystem,
  RunRecordSchema,
} from '@bdiff/core';
import type { Finding, LlmTier, RunRecord } from '@bdiff/core';
import { FakeLlmClient } from '@bdiff/core/testing';
import { BASE_BRANCH, buildFixtureRepo, loadExpected, PR_BRANCHES } from '@bdiff/fixtures';
import type { Expected, ExpectedFinding, FixtureRepo, PrBranch } from '@bdiff/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { composeLeftovers } from './compose-leftovers.js';
import { configuredModels, runBdiff } from './run-bdiff.js';
import type { CliRun } from './run-bdiff.js';
import { withScriptedInterpretation } from './scripted-interpretation.js';
import { worktreeLeftovers } from './worktree-leftovers.js';

const exec = createExecaExec();
const signal = new AbortController().signal;

/** The first line `bdiff run` prints for each branch. */
const OUTCOME_LINES: Readonly<Record<PrBranch, string>> = {
  'pr/ui-change': 'bdiff: success, 2 findings (2 info)',
  'pr/api-breaking': 'bdiff: success, 2 findings (1 breaking, 1 warning)',
  'pr/refactor-no-change': 'bdiff: success, 0 findings',
  'pr/docs-only': 'bdiff: skipped: docs-only',
};

/** Kind and place of a finding, as `expected.json` describes it (no bounding box), as a key. */
function placeKey(finding: Pick<ExpectedFinding, 'kind' | 'location'>): string {
  const { route, endpoint, jsonPath } = finding.location;
  return JSON.stringify([finding.kind, route ?? null, endpoint ?? null, jsonPath ?? null]);
}

/** The HTML of one finding in the report, from its anchor to the next finding. */
function findingHtml(report: string, id: string): string {
  const start = report.indexOf(`id="finding-${id}"`);
  const next = report.indexOf('id="finding-', start + 1);
  return start === -1 ? '' : report.slice(start, next === -1 ? undefined : next);
}

/** The report's "Unexpected for the stated intent" callout, or `''`. */
function unexpectedHtml(report: string): string {
  const start = report.indexOf('<div class="callout unexpected">');
  return start === -1 ? '' : report.slice(start, report.indexOf('</div>', start));
}

describe('bdiff on every fixture branch (@docker)', () => {
  let root: string;
  let cacheDir: string;
  let fixture: FixtureRepo;
  let expected: Expected;
  /** The configured model of each tier, so the fake LLM's usage is priced like a real call's. */
  let models: Record<LlmTier, string>;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-e2e-fixture-'));
    cacheDir = path.join(root, 'cache');
    expected = await loadExpected(nodeFileSystem);
    models = await configuredModels();
    fixture = await buildFixtureRepo({
      targetDir: path.join(root, 'fixture'),
      exec,
      fs: nodeFileSystem,
      signal,
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /**
   * Runs `bdiff run` on `branch` with a {@link FakeLlmClient} that answers the interpret call with
   * a scripted interpretation of the diff stage's findings. Returns what it printed and the
   * findings.
   */
  async function bdiff(
    branch: PrBranch,
    outDir: string,
  ): Promise<CliRun & { findings: Finding[]; llm: FakeLlmClient }> {
    const llm = new FakeLlmClient({ models });
    let findings: Finding[] = [];
    const run = await runBdiff({
      repo: fixture.path,
      base: BASE_BRANCH,
      head: branch,
      outDir,
      cacheDir,
      cwd: root,
      llm,
      editStages: (stages) =>
        withScriptedInterpretation(stages, llm, (found) => {
          findings = found;
        }),
    });
    return { ...run, findings, llm };
  }

  it.each(PR_BRANCHES)('%s: matches expected.json and leaves nothing behind', async (branch) => {
    const want = expected.branches[branch];
    const outDir = path.join(root, 'out', branch.replaceAll('/', '-'));
    const started = performance.now();

    const run = await bdiff(branch, outDir);

    const wallSeconds = (performance.now() - started) / 1000;
    expect(run.exitCode, run.stdout + run.stderr).toBe(EXIT_CODES.success);
    const [runId = ''] = await nodeFileSystem.readdir(path.join(outDir, 'runs'));
    const paths = createArtifactPaths(outDir, runId);
    const record: RunRecord = RunRecordSchema.parse(
      JSON.parse(await readFile(paths.runJson, 'utf8')),
    );
    logWallTime(branch, wallSeconds, record);

    // Status and findings, against the ground truth.
    if (want.impact.skip === undefined) {
      expect(record.status, JSON.stringify(record, null, 2)).toBe('success');
    } else {
      expect(record).toMatchObject({ status: 'skipped', skip: want.impact.skip });
    }
    expect(run.findings.map(placeKey).sort(), JSON.stringify(run.findings, null, 2)).toEqual(
      want.findings.map(placeKey).sort(),
    );
    for (const wanted of want.findings) {
      if (wanted.severity !== undefined) {
        const found = run.findings.find((finding) => placeKey(finding) === placeKey(wanted));
        expect(found?.severity, placeKey(wanted)).toBe(wanted.severity);
      }
    }
    // The noisy page never produces a finding, also when it is probed.
    for (const finding of run.findings) {
      expect(expected.noisyRoutes).not.toContain(finding.location.route);
    }
    for (const route of want.impact.routes) {
      expect(await nodeFileSystem.exists(paths.uiScreenshot('head', route)), route).toBe(true);
    }
    expect(record.counts.findings).toBe(want.findings.length);
    // The LLM interprets findings; a run without findings never calls it.
    expect(run.llm.calls.map((call) => call.purpose)).toEqual(
      want.findings.length > 0 ? [INTERPRET_PURPOSE] : [],
    );
    // A breaking finding sends the interpretation to the smart tier.
    const tier = want.findings.some((finding) => finding.severity === 'breaking')
      ? 'smart'
      : 'fast';
    for (const call of run.llm.calls) {
      expect(call.request.tier).toBe(tier);
    }
    expect(record.totals.llmCalls).toBe(run.llm.calls.length);

    // The CSV row, the summary and the report.
    const csv = (await readFile(path.join(outDir, 'results.csv'), 'utf8')).trimEnd().split('\n');
    expect(csv).toHaveLength(2);
    expect(csv[1]).toContain(runId);
    expect(run.stdout.split('\n')[0]).toBe(OUTCOME_LINES[branch]);
    expect(run.stdout).toContain(`  report: ${paths.reportHtml}\n`);
    expect(run.stdout).toContain(`  record: ${paths.runJson}\n`);
    const report = await readFile(paths.reportHtml, 'utf8');
    if (want.impact.skip !== undefined) {
      expect(report).toContain(`<h2>Skipped: ${want.impact.skip.reason}</h2>`);
    } else if (want.findings.length === 0) {
      expect(report).toContain('No behavior changes observed in the probed surface.');
    }
    for (const finding of run.findings) {
      const html = findingHtml(report, finding.id);
      expect(html, finding.id).toMatch(
        new RegExp(
          `badge ${finding.severity}">${finding.severity}</span>\\s*<strong>${finding.kind}</strong>`,
        ),
      );
      expect(html, finding.id).toContain(finding.location.jsonPath ?? '');
    }
    // The scripted interpretation flags breaking findings; the report must show them as such.
    const breaking = run.findings.filter((finding) => finding.severity === 'breaking');
    for (const finding of breaking) {
      expect(unexpectedHtml(report), finding.id).toContain(`href="#finding-${finding.id}"`);
    }
    if (run.findings.length > 0) {
      const risk = breaking.length > 0 ? 'high' : 'low';
      expect(report).toMatch(new RegExp(`badge ${risk}"\\s*>risk: ${risk}<`));
    }

    // Nothing left behind: containers, networks, volumes, worktrees.
    expect(await composeLeftovers(exec, `bdiff-${runId}`, signal)).toEqual([]);
    expect(await nodeFileSystem.exists(path.join(paths.runDir, 'worktrees'))).toBe(false);
    expect(await worktreeLeftovers(exec, cacheDir, signal)).toEqual([]);
  });
});

/** One line per branch in the test log, to track the e2e's speed over time. */
function logWallTime(branch: PrBranch, wallSeconds: number, record: RunRecord): void {
  const stages = record.stageTimings
    .map((timing) => `${timing.stage} ${(timing.durationMs / 1000).toFixed(1)}s`)
    .join(', ');
  console.log(`e2e wall time ${branch}: ${wallSeconds.toFixed(1)}s (${stages})`);
}
