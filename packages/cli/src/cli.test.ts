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
import type { Finding, PipelineStages, RunOutcome, Severity } from '@bdiff/core';
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

function harness(cwd: string, stages: PipelineStages = createStubStages()) {
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
