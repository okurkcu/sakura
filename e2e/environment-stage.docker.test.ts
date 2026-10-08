import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  BdiffError,
  createEnvironmentStage,
  createExecaExec,
  createFetchHttpClient,
  createRecipeStage,
  createStubStages,
  createWorkspaceStage,
  nodeFileSystem,
  runPipeline,
  systemClock,
} from '@bdiff/core';
import type { Exec, Target } from '@bdiff/core';
import {
  createMemoryMetricsStore,
  createTestCostCalculator,
  createTestLogger,
  createTestStageContext,
} from '@bdiff/core/testing';
import { buildFixtureRepo } from '@bdiff/fixtures';
import type { FixtureRepo } from '@bdiff/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { composeLeftovers } from './compose-leftovers.js';

const exec = createExecaExec();
const http = createFetchHttpClient();
const signal = new AbortController().signal;
const repoRoot = path.resolve(import.meta.dirname, '..');

/** Records every host command, to prove the target repo's commands never run on the host. */
function recordingExec(): Exec & { readonly commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    run: (cmd, args, options) => {
      commands.push(cmd);
      return exec.run(cmd, args, options);
    },
  };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await exec.run('git', args, {
    cwd,
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
    timeoutMs: 30_000,
    signal,
  });
  if (result.exitCode !== 0) {
    throw new BdiffError('GIT_FAILED', result.stderr);
  }
}

/** Every container, network and volume of a compose project still present. */
const leftovers = (project: string): Promise<string[]> => composeLeftovers(exec, project, signal);

describe('environment stage on the fixture (@docker)', () => {
  let root: string;
  let cacheDir: string;
  let fixture: FixtureRepo;

  const target = (headRef: string): Target => ({ repoUrl: fixture.path, baseRef: 'main', headRef });

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-e2e-env-'));
    cacheDir = path.join(root, 'cache');
    fixture = await buildFixtureRepo({
      targetDir: path.join(root, 'fixture'),
      exec,
      fs: nodeFileSystem,
      signal,
    });
    // A head whose build fails: a syntax error on top of pr/ui-change.
    await git(fixture.path, 'checkout', '--quiet', '-b', 'test/broken-build', 'pr/ui-change');
    await writeFile(
      path.join(fixture.path, 'app/login/page.tsx'),
      'export default function LoginPage( {\n',
    );
    await git(fixture.path, 'commit', '--quiet', '-am', 'Break the build');
    await git(fixture.path, 'checkout', '--quiet', 'main');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('starts base and head, reachable from the host, running nothing but docker and git on the host', async () => {
    const recorded = recordingExec();
    const test = createTestStageContext({ outDir: path.join(root, 'out-ok'), clock: systemClock });
    const project = `bdiff-${test.ctx.runId}`;
    try {
      const workspace = await createWorkspaceStage({
        exec: recorded,
        fs: nodeFileSystem,
        cacheDir,
        cwd: root,
      }).run(target('pr/ui-change'), test.ctx);
      const recipe = await createRecipeStage({ fs: nodeFileSystem, cacheDir, cwd: root }).run(
        { workspace },
        test.ctx,
      );
      const environment = await createEnvironmentStage({
        exec: recorded,
        fs: nodeFileSystem,
        http,
      }).run({ workspace, recipe }, test.ctx);

      expect(environment.project).toBe(project);
      for (const side of ['base', 'head'] as const) {
        expect(environment.sides[side].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect((await fetch(`${environment.sides[side].url}/api/health`)).status).toBe(200);
      }
      const login = async (side: 'base' | 'head') =>
        (await fetch(`${environment.sides[side].url}/login`)).text();
      expect(await login('base')).not.toContain('Continue with Google');
      expect(await login('head')).toContain('Continue with Google');
      expect(new Set(recorded.commands)).toEqual(new Set(['git', 'docker']));
      expect(await nodeFileSystem.readFile(test.ctx.paths.log('head'))).toContain(
        '@@bdiff phase start',
      );
    } finally {
      await test.runCleanups();
    }

    expect(await leftovers(project)).toEqual([]);
  });

  it('records SETUP_BUILD_FAILED with the last 100 log lines when the head build breaks', async () => {
    const store = createMemoryMetricsStore();
    const { result } = await runPipeline(
      target('test/broken-build'),
      {
        ...createStubStages(),
        workspace: createWorkspaceStage({ exec, fs: nodeFileSystem, cacheDir, cwd: root }),
        recipe: createRecipeStage({ fs: nodeFileSystem, cacheDir, cwd: root }),
        environment: createEnvironmentStage({ exec, fs: nodeFileSystem, http }),
      },
      {
        clock: systemClock,
        fs: nodeFileSystem,
        logger: createTestLogger(),
        costs: createTestCostCalculator(),
        outDir: path.join(root, 'out-broken'),
        toolVersion: 'test',
        timeoutMs: 15 * 60_000,
        budgetUsd: 1,
        signal,
        store,
      },
    );
    const record = store.written[0];

    expect(result.record.status).toBe('failed');
    expect(record?.status === 'failed' && record.failure).toMatchObject({
      code: 'SETUP_BUILD_FAILED',
      stage: 'environment',
      details: { side: 'head', exitCode: 103 },
    });
    const logTail = record?.status === 'failed' ? record.failure.details.logTail : undefined;
    expect(Array.isArray(logTail) && logTail.length > 0 && logTail.length <= 100).toBe(true);
    expect(JSON.stringify(logTail)).toMatch(/login\/page\.tsx|Syntax|Expected/i);
    expect(record?.computeSeconds.head).toBeGreaterThan(0);
    expect(await leftovers(`bdiff-${result.record.runId}`)).toEqual([]);
  });

  // A branch without findings: every real stage runs, but the interpret stage needs no LLM call
  // (CI has no API key, and tests never call the real API).
  it('runs bdiff end to end on the fixture: exit 0, a record, and nothing left behind', async () => {
    const out = path.join(root, 'out-cli-ok');
    const result = await exec.run(
      process.execPath,
      [
        '--conditions=bdiff-source',
        '--import',
        'tsx',
        'packages/cli/src/main.ts',
        'run',
        '--repo',
        fixture.path,
        '--base',
        'main',
        '--head',
        'pr/refactor-no-change',
        '--out',
        out,
      ],
      {
        cwd: repoRoot,
        env: { BDIFF_CACHE_DIR: path.join(root, 'cache-cli-ok'), BDIFF_TOOL_VERSION: 'test' },
        timeoutMs: 15 * 60_000,
        signal,
      },
    );
    const runId = /run ([0-9a-z]{26})/.exec(result.stdout)?.[1] ?? '';

    expect(result.exitCode, result.stderr.slice(-3_000)).toBe(0);
    expect(result.stdout).toContain('bdiff: success');
    expect(await nodeFileSystem.exists(path.join(out, 'runs', runId, 'logs', 'head.log'))).toBe(
      true,
    );
    expect(await leftovers(`bdiff-${runId}`)).toEqual([]);
  });

  it('leaves no containers, networks or volumes behind when the CLI is interrupted mid-build', async () => {
    const out = path.join(root, 'out-interrupted');
    const child = spawn(
      process.execPath,
      [
        '--conditions=bdiff-source',
        '--import',
        'tsx',
        'packages/cli/src/main.ts',
        'run',
        '--repo',
        fixture.path,
        '--base',
        'main',
        '--head',
        'pr/api-breaking',
        '--out',
        out,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          BDIFF_CACHE_DIR: path.join(root, 'cache-cli'),
          BDIFF_TOOL_VERSION: 'test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    let exitCode: number | null | undefined;
    const exited = new Promise<number | null>((resolve) =>
      child.once('exit', (code) => {
        exitCode = code;
        resolve(code);
      }),
    );

    const deadline = Date.now() + 5 * 60_000;
    while (!stderr.includes('containers started; installing and building')) {
      if (exitCode !== undefined) {
        throw new Error(
          `bdiff exited (${String(exitCode)}) before containers started: ${stderr.slice(-2_000)}`,
        );
      }
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error(`containers never started: ${stderr.slice(-2_000)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const runId = /"runId":"([0-9a-z]{26})"/.exec(stderr)?.[1] ?? '';
    expect(await leftovers(`bdiff-${runId}`)).not.toEqual([]);

    child.kill('SIGINT');

    expect(await exited, stderr.slice(-3_000)).toBe(130);
    expect(await leftovers(`bdiff-${runId}`)).toEqual([]);
  });
});
