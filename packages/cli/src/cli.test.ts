import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  abortError,
  BdiffError,
  createArtifactPaths,
  nodeFileSystem,
  RunRecordSchema,
  systemClock,
} from '@bdiff/core';
import type {
  Finding,
  PipelineStages,
  PullRequest,
  PullRequestSource,
  RunOutcome,
  Severity,
} from '@bdiff/core';
import {
  createStubStages,
  createTestLogger,
  createTestRunRecorder,
  FakeExec,
  TEST_RUN_ID,
} from '@bdiff/core/testing';
import { createReportStage } from '@bdiff/report';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EXIT_CODES, runCli, summarize } from './cli.js';
import type { CliDeps, SignalSource } from './cli.js';

const pricingPath = path.resolve(import.meta.dirname, '../../../config/pricing.json');
const llmConfigPath = path.resolve(import.meta.dirname, '../../../config/llm.json');
const runArgs = [
  'run',
  '--repo',
  'https://github.com/acme/shop.git',
  '--base',
  'main',
  '--head',
  'pr/1',
];

/** A pull request source that answers from a table, or fails like GitHub would. */
function fakePullRequests(
  answers: Record<string, PullRequest | Error> = {},
): PullRequestSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolvePullRequest: (repo, number) => {
      const key = `${repo.owner}/${repo.name}#${String(number)}`;
      calls.push(key);
      const answer =
        answers[key] ??
        new BdiffError('PR_NOT_FOUND', `GitHub has no pull request ${key}, or it is private`);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
}

function harness(
  cwd: string,
  stages: PipelineStages = createStubStages(),
  pullRequests: PullRequestSource = fakePullRequests(),
) {
  let stdout = '';
  let stderr = '';
  const signals = new EventEmitter();
  const forceExit = vi.fn<(code: number) => void>();
  const io = {
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    env: { BDIFF_TOOL_VERSION: 'test-version' },
    signals: signals as SignalSource,
    forceExit,
  };
  const deps: CliDeps = {
    clock: systemClock,
    fs: nodeFileSystem,
    exec: new FakeExec(),
    createStages: () => stages,
    createLogger: () => createTestLogger(),
    pricingPath,
    llmConfigPath,
    cwd,
    pullRequests,
  };
  return {
    io,
    deps,
    signals,
    forceExit,
    output: () => ({ stdout, stderr }),
  };
}

async function readOnlyRecord(outDir: string) {
  const [runId] = await nodeFileSystem.readdir(path.join(outDir, 'runs'));
  return RunRecordSchema.parse(
    JSON.parse(await readFile(path.join(outDir, 'runs', runId ?? '', 'run.json'), 'utf8')),
  );
}

describe('runCli', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'bdiff-cli-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('runs the stub pipeline: run.json, a CSV row and exit 0', async () => {
    const h = harness(cwd);

    const code = await runCli([...runArgs, '--pr', '7'], h.io, h.deps);

    expect(code).toBe(EXIT_CODES.success);
    const record = await readOnlyRecord(path.join(cwd, '.bdiff'));
    expect(record).toMatchObject({
      status: 'success',
      toolVersion: 'test-version',
      target: { prNumber: 7 },
    });
    const csv = (await readFile(path.join(cwd, '.bdiff', 'results.csv'), 'utf8'))
      .trimEnd()
      .split('\n');
    expect(csv).toHaveLength(2);
    expect(csv[1]).toContain(record.runId);
    expect(h.output().stdout).toContain('bdiff: success, 0 findings');
    expect(h.output().stdout).toContain(path.join(cwd, '.bdiff', 'runs', record.runId, 'run.json'));
    // The stub report stage writes nothing, so there is no report to point to.
    expect(h.output().stdout).not.toContain('report:');
  });

  it('points to the report when one was written', async () => {
    const h = harness(cwd, {
      ...createStubStages(),
      report: createReportStage({ fs: nodeFileSystem }),
    });

    expect(await runCli(runArgs, h.io, h.deps)).toBe(EXIT_CODES.success);

    const record = await readOnlyRecord(path.join(cwd, '.bdiff'));
    const report = createArtifactPaths(path.join(cwd, '.bdiff'), record.runId).reportHtml;
    expect(h.output().stdout).toContain(`  report: ${report}\n`);
    expect(await nodeFileSystem.exists(report)).toBe(true);
  });

  it('records a failing stage, still cleans up, and exits 1', async () => {
    const stubs = createStubStages();
    const cleaned: string[] = [];
    const h = harness(cwd, {
      ...stubs,
      workspace: {
        name: 'workspace',
        run: (target, ctx) => {
          ctx.onCleanup('worktrees', () => {
            cleaned.push('worktrees');
            return Promise.resolve();
          });
          return stubs.workspace.run(target, ctx);
        },
      },
      recipe: {
        name: 'recipe',
        run: () => Promise.reject(new BdiffError('SETUP_UNSUPPORTED', 'no Next.js app found')),
      },
    });

    const code = await runCli(runArgs, h.io, h.deps);

    expect(code).toBe(EXIT_CODES.failed);
    expect(cleaned).toEqual(['worktrees']);
    expect(await readOnlyRecord(path.join(cwd, '.bdiff'))).toMatchObject({
      status: 'failed',
      failure: { code: 'SETUP_UNSUPPORTED', stage: 'recipe' },
    });
    expect(h.output().stdout).toContain('failed at recipe (SETUP_UNSUPPORTED)');
  });

  it('on SIGINT aborts the run, runs cleanup, records ABORTED and exits 130', async () => {
    const stubs = createStubStages();
    const cleaned: string[] = [];
    let blocked = false;
    const h = harness(cwd, {
      ...stubs,
      environment: {
        name: 'environment',
        run: (_input, ctx) =>
          new Promise((_resolve, reject) => {
            ctx.onCleanup('containers', () => {
              cleaned.push('containers');
              return Promise.resolve();
            });
            ctx.signal.addEventListener('abort', () => {
              reject(abortError(ctx.signal));
            });
            blocked = true;
          }),
      },
    });

    const running = runCli(runArgs, h.io, h.deps);
    await vi.waitFor(() => {
      expect(blocked).toBe(true);
    });
    h.signals.emit('SIGINT');
    const code = await running;

    expect(code).toBe(EXIT_CODES.interrupted);
    expect(cleaned).toEqual(['containers']);
    expect(await readOnlyRecord(path.join(cwd, '.bdiff'))).toMatchObject({
      status: 'failed',
      failure: { code: 'ABORTED', stage: 'environment', message: 'Interrupted by SIGINT' },
    });
    expect(h.output().stderr).toContain('SIGINT received; cleaning up');
    expect(h.signals.listenerCount('SIGINT')).toBe(0);
  });

  it('force-exits on a second interrupt during cleanup', async () => {
    const stubs = createStubStages();
    let cleanupStarted = false;
    const h = harness(cwd, {
      ...stubs,
      workspace: {
        name: 'workspace',
        run: (target, ctx) => {
          ctx.onCleanup('slow', () => {
            cleanupStarted = true;
            return new Promise((resolve) => setTimeout(resolve, 200));
          });
          return stubs.workspace.run(target, ctx);
        },
      },
      recipe: {
        name: 'recipe',
        run: (_input, ctx) =>
          new Promise((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => {
              reject(abortError(ctx.signal));
            });
          }),
      },
    });

    const running = runCli(runArgs, h.io, h.deps);
    await vi.waitFor(() => {
      expect(h.signals.listenerCount('SIGTERM')).toBe(1);
    });
    h.signals.emit('SIGTERM');
    await vi.waitFor(() => {
      expect(cleanupStarted).toBe(true);
    });
    h.signals.emit('SIGINT');

    expect(h.forceExit).toHaveBeenCalledWith(EXIT_CODES.interrupted);
    expect(await running).toBe(EXIT_CODES.interrupted);
  });

  it.each([
    { name: 'no command', argv: [] },
    { name: 'missing --head', argv: ['run', '--repo', 'x', '--base', 'main'] },
    { name: 'an unknown option', argv: [...runArgs, '--fast'] },
    { name: 'an invalid --pr', argv: [...runArgs, '--pr', 'abc'] },
    { name: 'an invalid --timeout', argv: [...runArgs, '--timeout', '0'] },
    { name: 'an unknown command', argv: ['explode'] },
  ])('exits 2 with a message for $name, writing nothing', async ({ argv }) => {
    const h = harness(cwd);

    const code = await runCli(argv, h.io, h.deps);

    expect(code).toBe(EXIT_CODES.usage);
    expect(h.output().stderr).not.toBe('');
    expect(await nodeFileSystem.exists(path.join(cwd, '.bdiff'))).toBe(false);
  });

  it('explains validation problems', async () => {
    const h = harness(cwd);

    await runCli([...runArgs, '--pr', '0', '--budget', 'lots'], h.io, h.deps);

    expect(h.output().stderr).toMatch(
      /--pr must be a positive integer[\s\S]*budget \(USD\) must be a non-negative number/,
    );
  });

  it('prints help and exits 0', async () => {
    const h = harness(cwd);

    expect(await runCli(['run', '--help'], h.io, h.deps)).toBe(EXIT_CODES.success);
    expect(h.output().stdout).toContain('--repo <url|path>');
  });

  it('exits 1 without running when the pricing table cannot be read', async () => {
    const h = harness(cwd);

    const code = await runCli(runArgs, h.io, {
      ...h.deps,
      pricingPath: path.join(cwd, 'missing.json'),
    });

    expect(code).toBe(EXIT_CODES.failed);
    expect(h.output().stderr).toContain('could not be recorded');
    expect(await nodeFileSystem.exists(path.join(cwd, '.bdiff'))).toBe(false);
  });

  it('exits 1 without running when the LLM config is invalid', async () => {
    const h = harness(cwd);
    const llmConfigPath = path.join(cwd, 'llm.json');
    await nodeFileSystem.writeFile(
      llmConfigPath,
      JSON.stringify({
        tiers: {
          fast: { model: 'unpriced-model', effort: 'medium' },
          smart: { model: 'unpriced-model', effort: 'medium' },
        },
        requestTimeoutMs: 1_000,
        maxRetries: 0,
      }),
    );

    const code = await runCli(runArgs, h.io, { ...h.deps, llmConfigPath });

    expect(code).toBe(EXIT_CODES.failed);
    expect(h.output().stderr).toMatch(/could not be recorded.*unpriced-model/);
    expect(await nodeFileSystem.exists(path.join(cwd, '.bdiff'))).toBe(false);
  });
});

describe('runCli with a pull request URL', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'bdiff-cli-pr-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const openPr: PullRequest = {
    title: 'Format the latest order total',
    body: 'Clients asked for a currency.',
    state: 'open',
    merged: false,
    base: { ref: 'main', sha: 'a'.repeat(40), repo: 'acme/shop' },
    head: { ref: 'format-total', sha: 'b'.repeat(40), repo: 'acme/shop' },
  };

  it('resolves the pull request and records it as the target', async () => {
    const source = fakePullRequests({ 'acme/shop#7': openPr });
    const h = harness(cwd, createStubStages(), source);

    const code = await runCli(
      ['run', 'https://github.com/acme/shop/pull/7/files?diff=split'],
      h.io,
      h.deps,
    );

    expect(code).toBe(EXIT_CODES.success);
    expect(source.calls).toEqual(['acme/shop#7']);
    expect((await readOnlyRecord(path.join(cwd, '.bdiff'))).target).toEqual({
      repoUrl: 'https://github.com/acme/shop',
      baseRef: 'main',
      headRef: 'format-total',
      prNumber: 7,
      prTitle: 'Format the latest order total',
      prBody: 'Clients asked for a currency.',
    });
  });

  it.each([
    [
      'not found',
      undefined,
      'PR_NOT_FOUND',
      'GitHub has no pull request acme/shop#404, or it is private',
    ],
    [
      'rate limited',
      new BdiffError(
        'HTTP_FAILED',
        'GitHub rate limit reached while reading pull request acme/shop#404; set GITHUB_TOKEN to raise the limit',
        { details: { status: 403, rateLimited: true } },
      ),
      'HTTP_FAILED',
      'set GITHUB_TOKEN',
    ],
  ])(
    'records a pull request GitHub cannot resolve (%s) and exits 1',
    async (_name, failure, code, message) => {
      const source = fakePullRequests(failure === undefined ? {} : { 'acme/shop#404': failure });
      const h = harness(cwd, createStubStages(), source);

      expect(await runCli(['run', 'https://github.com/acme/shop/pull/404'], h.io, h.deps)).toBe(
        EXIT_CODES.failed,
      );

      const record = await readOnlyRecord(path.join(cwd, '.bdiff'));
      expect(record).toMatchObject({
        status: 'failed',
        failure: { code, stage: 'workspace' },
        target: {
          repoUrl: 'https://github.com/acme/shop',
          headRef: 'refs/pull/404/head',
          prNumber: 404,
        },
      });
      expect(h.output().stdout).toContain(message);
    },
  );

  it.each([
    {
      name: 'a URL plus --repo and --pr',
      argv: ['run', 'https://github.com/acme/shop/pull/7', '--repo', 'x', '--pr', '7'],
      message: /cannot be combined with --repo, --pr/,
    },
    {
      name: 'an issue URL',
      argv: ['run', 'https://github.com/acme/shop/issues/7'],
      message: /is not a GitHub pull request URL/,
    },
    {
      name: 'a GitLab merge request',
      argv: ['run', 'https://gitlab.com/acme/shop/-/merge_requests/7'],
      message: /is not a GitHub pull request URL/,
    },
    {
      name: 'neither a URL nor --repo',
      argv: ['run', '--base', 'main', '--head', 'pr/1'],
      message: /--repo is required/,
    },
  ])('exits 2 for $name, writing nothing', async ({ argv, message }) => {
    const source = fakePullRequests();
    const h = harness(cwd, createStubStages(), source);

    expect(await runCli(argv, h.io, h.deps)).toBe(EXIT_CODES.usage);
    expect(h.output().stderr).toMatch(message);
    expect(source.calls).toEqual([]);
    expect(await nodeFileSystem.exists(path.join(cwd, '.bdiff'))).toBe(false);
  });
});

describe('runCli batch and stats', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'bdiff-cli-batch-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const writeDataset = async (ids: readonly string[]) => {
    const file = path.join(cwd, 'dataset.json');
    await nodeFileSystem.writeFile(
      file,
      JSON.stringify({
        entries: ids.map((id, i) => ({
          id,
          repoUrl: 'https://github.com/acme/shop.git',
          baseRef: 'main',
          headRef: `pr/${id}`,
          tags: {
            difficulty: i % 2 === 0 ? 'easy' : 'realistic',
            prType: 'ui',
            author: 'human',
          },
        })),
      }),
    );
    return file;
  };
  /**
   * `<entry>:<status or failure code>` of every record, sorted: stub runs finish within the same
   * millisecond, so run ids do not tell their order (the progress lines do).
   */
  const recordedIds = async () => {
    const out = path.join(cwd, '.bdiff', 'runs');
    const ids: string[] = [];
    for (const runId of await nodeFileSystem.readdir(out)) {
      const record = RunRecordSchema.parse(
        JSON.parse(await readFile(path.join(out, runId, 'run.json'), 'utf8')),
      );
      ids.push(
        `${record.dataset?.id ?? '-'}:${record.status === 'failed' ? record.failure.code : record.status}`,
      );
    }
    return ids.sort();
  };

  it('runs every entry, writes the index, and refuses to run them again unless asked', async () => {
    const dataset = await writeDataset(['a', 'b', 'c']);
    const h = harness(cwd);

    expect(await runCli(['batch', dataset], h.io, h.deps)).toBe(EXIT_CODES.success);

    expect(await recordedIds()).toEqual(['a:success', 'b:success', 'c:success']);
    expect(h.output().stdout).toContain('bdiff batch: 3 entries, 3 to run');
    expect(h.output().stdout).toContain('[2/3] b: success, 0 findings');
    expect(h.output().stdout).toContain('bdiff batch: 3 recorded, 0 not recorded');
    const index = await readFile(path.join(cwd, '.bdiff', 'report', 'batch-index.html'), 'utf8');
    expect(index).toContain('pr/c');

    const again = harness(cwd);
    expect(await runCli(['batch', dataset], again.io, again.deps)).toBe(EXIT_CODES.usage);
    expect(again.output().stderr).toContain(
      '3 of these entries already have a record from this bdiff version (test-version)',
    );

    const resumed = harness(cwd);
    expect(await runCli(['batch', dataset, '--resume'], resumed.io, resumed.deps)).toBe(
      EXIT_CODES.success,
    );
    expect(resumed.output().stdout).toContain('3 entries, 0 to run, 3 already recorded');

    const forced = harness(cwd);
    expect(
      await runCli(
        ['batch', dataset, '--force', '--only', 'difficulty=easy'],
        forced.io,
        forced.deps,
      ),
    ).toBe(EXIT_CODES.success);
    expect(await recordedIds()).toEqual([
      'a:success',
      'a:success',
      'b:success',
      'c:success',
      'c:success',
    ]);
  });

  it('continues an interrupted batch where it stopped with --resume', async () => {
    const dataset = await writeDataset(['a', 'b', 'c']);
    const stubs = createStubStages();
    let blocked = false;
    const h = harness(cwd, {
      ...stubs,
      environment: {
        name: 'environment',
        run: (input, ctx) =>
          ctx.target.headRef === 'pr/b'
            ? new Promise((_resolve, reject) => {
                ctx.signal.addEventListener('abort', () => {
                  reject(abortError(ctx.signal));
                });
                blocked = true;
              })
            : stubs.environment.run(input, ctx),
      },
    });

    const running = runCli(['batch', dataset], h.io, h.deps);
    await vi.waitFor(() => {
      expect(blocked).toBe(true);
    });
    h.signals.emit('SIGINT');

    expect(await running).toBe(EXIT_CODES.interrupted);
    expect(await recordedIds()).toEqual(['a:success', 'b:ABORTED']);
    expect(h.output().stdout).toContain('interrupted (run again with --resume)');

    const resumed = harness(cwd);
    expect(await runCli(['batch', dataset, '--resume'], resumed.io, resumed.deps)).toBe(
      EXIT_CODES.success,
    );

    expect(resumed.output().stdout).toContain('3 entries, 2 to run, 1 already recorded');
    expect(await recordedIds()).toEqual(['a:success', 'b:ABORTED', 'b:success', 'c:success']);
  });

  it('runs only its shard, and stats combines the shards into one index and Markdown', async () => {
    const dataset = await writeDataset(['a', 'b', 'c', 'd', 'e']);
    for (const shard of ['1/2', '2/2']) {
      const h = harness(cwd);
      expect(await runCli(['batch', dataset, '--shard', shard], h.io, h.deps)).toBe(
        EXIT_CODES.success,
      );
      expect(h.output().stdout).toContain(`bdiff batch: ${shard === '1/2' ? '3' : '2'} entries`);
    }
    expect(await recordedIds()).toEqual([
      'a:success',
      'b:success',
      'c:success',
      'd:success',
      'e:success',
    ]);

    const s = harness(cwd);
    expect(await runCli(['stats', '--markdown', 'summary.md'], s.io, s.deps)).toBe(
      EXIT_CODES.success,
    );

    const index = await readFile(path.join(cwd, '.bdiff', 'report', 'batch-index.html'), 'utf8');
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      expect(index).toContain(`pr/${id}`);
    }
    const markdown = await readFile(path.join(cwd, 'summary.md'), 'utf8');
    expect(markdown).toContain('5 runs: 5 success, 0 failed, 0 skipped.');
    expect(markdown).toContain(
      '| Setup works automatically in ≥ 50% of repositories | 100% (5/5) | ✅ PASS |',
    );
  });

  it('aggregates the recorded runs with stats and writes stats.json', async () => {
    const dataset = await writeDataset(['a', 'b', 'c']);
    const h = harness(cwd);
    await runCli(['batch', dataset], h.io, h.deps);

    const s = harness(cwd);
    expect(await runCli(['stats', '--by', 'difficulty'], s.io, s.deps)).toBe(EXIT_CODES.success);

    expect(s.output().stdout).toContain('bdiff stats: 3 runs (3 success, 0 failed, 0 skipped)');
    expect(s.output().stdout).toMatch(
      /PASS {2}Setup works automatically in ≥ 50% of repositories: 100% \(3\/3\)/,
    );
    expect(s.output().stdout).toContain('By difficulty');
    const stats = JSON.parse(await readFile(path.join(cwd, '.bdiff', 'stats.json'), 'utf8')) as {
      records: number;
      groups: { values: Record<string, { runs: number }> };
    };
    expect(stats.records).toBe(3);
    expect(stats.groups.values.easy?.runs).toBe(2);
  });

  it.each([
    { name: 'a missing dataset', argv: ['batch', 'missing.json'], message: /Dataset not found/ },
    {
      name: '--resume with --force',
      argv: ['batch', 'missing.json', '--resume', '--force'],
      message: /--resume and --force cannot be combined/,
    },
    {
      name: 'a third concurrent run',
      argv: ['batch', 'missing.json', '--concurrency', '3'],
      message: /--concurrency must be at most 2/,
    },
    { name: 'an unknown --by', argv: ['stats', '--by', 'size'], message: /--by must be one of/ },
  ])('exits 2 for $name', async ({ argv, message }) => {
    const h = harness(cwd);

    expect(await runCli(argv, h.io, h.deps)).toBe(EXIT_CODES.usage);
    expect(h.output().stderr).toMatch(message);
  });

  it('exits 1 from stats when nothing was recorded', async () => {
    const h = harness(cwd);

    expect(await runCli(['stats'], h.io, h.deps)).toBe(EXIT_CODES.failed);
    expect(h.output().stderr).toContain('no run records');
  });
});

describe('summarize', () => {
  const files = { runJsonPath: '/out/run.json', reportPath: '/out/report/index.html' };
  const findings = (...severities: Severity[]): Finding[] =>
    severities.map((severity, i) => ({
      id: `finding-${String(i)}`,
      kind: 'text',
      severity,
      location: { route: '/' },
      evidence: [],
    }));
  const finished = (outcome: RunOutcome) => {
    const { recorder, clock } = createTestRunRecorder();
    recorder.recordLlmUsage('interpret', {
      model: 'test-model',
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    });
    clock.advance(12_345);
    return recorder.finish(outcome);
  };

  it('gives the outcome, findings by severity, duration, cost, report and record', () => {
    const record = finished({ status: 'success' });

    expect(
      summarize({ record, findings: findings('info', 'breaking', 'info', 'warning') }, files),
    ).toBe(
      'bdiff: success, 4 findings (1 breaking, 1 warning, 2 info)\n' +
        `  12.3s · LLM $0.0014 · run ${TEST_RUN_ID}\n` +
        '  report: /out/report/index.html\n' +
        '  record: /out/run.json\n',
    );
  });

  it.each([
    {
      name: 'a success without findings',
      outcome: { status: 'success' } as const,
      found: [],
      lines: ['bdiff: success, 0 findings'],
    },
    {
      name: 'a single finding',
      outcome: { status: 'success' } as const,
      found: findings('warning'),
      lines: ['bdiff: success, 1 finding (1 warning)'],
    },
    {
      name: 'a skipped run',
      outcome: { status: 'skipped', reason: 'docs-only' } as const,
      found: undefined,
      lines: ['bdiff: skipped: docs-only'],
    },
    {
      name: 'a run that failed after finding something',
      outcome: {
        status: 'failed',
        error: new BdiffError('LLM_UNAVAILABLE', 'No Claude credentials'),
        stage: 'interpret',
      } as const,
      found: findings('info', 'breaking'),
      lines: [
        'bdiff: failed at interpret (LLM_UNAVAILABLE): No Claude credentials',
        '  2 findings (1 breaking, 1 info) before the failure',
      ],
    },
    {
      name: 'a run that failed before finding anything',
      outcome: {
        status: 'failed',
        error: new BdiffError('SETUP_UNSUPPORTED', 'No Next.js app found'),
        stage: 'recipe',
      } as const,
      found: undefined,
      lines: ['bdiff: failed at recipe (SETUP_UNSUPPORTED): No Next.js app found'],
    },
  ])('starts with the outcome for $name', ({ outcome, found, lines }) => {
    const record = finished(outcome);

    const summary = summarize(
      { record, ...(found === undefined ? {} : { findings: found }) },
      files,
    );

    expect(summary.split('\n').slice(0, lines.length + 1)).toEqual([
      ...lines,
      `  12.3s · LLM $0.0014 · run ${TEST_RUN_ID}`,
    ]);
  });

  it('leaves out the report line when no report was written', () => {
    const summary = summarize(
      { record: finished({ status: 'success' }), findings: [] },
      { runJsonPath: '/out/run.json' },
    );

    expect(summary).not.toContain('report:');
    expect(summary).toContain('  record: /out/run.json\n');
  });
});
