import { describe, expect, it } from 'vitest';

import { MAX_SETUP_ATTEMPTS, runSetup } from './setup-loop.js';
import type { SetupLoopDeps } from './setup-loop.js';
import type { Stage } from './stage.js';
import type { RunningEnvironment } from '../domain/environment.js';
import type { Recipe } from '../domain/recipe.js';
import type {
  RecipePatch,
  RepairProposal,
  RepairRequest,
  SetupAttempt,
} from '../domain/setup-repair.js';
import type { StageName } from '../domain/stage.js';
import type { Workspace } from '../domain/workspace.js';
import { BdiffError } from '../errors/bdiff-error.js';
import { createTestStageContext } from '../testing/stage-context.js';
import { STUB_RECIPE } from '../testing/stub-stages.js';

const workspace: Workspace = {
  basePath: '/w/base',
  headPath: '/w/head',
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  changedFiles: [],
};
const environment: RunningEnvironment = {
  project: 'bdiff-test',
  sides: {
    base: { url: 'http://127.0.0.1:1', service: 'app-base' },
    head: { url: 'http://127.0.0.1:2', service: 'app-head' },
  },
};
const patch: RecipePatch = {
  reason: 'test',
  env: [],
  nodeVersion: null,
  packageManager: null,
  installCmd: null,
  buildCmd: null,
  startCmd: ['pnpm', 'run', 'start'],
  dbSetupCmds: null,
  appRoot: null,
  port: null,
  healthPath: null,
};
const buildFailed = (side: 'base' | 'head' = 'head') =>
  new BdiffError('SETUP_BUILD_FAILED', `${side}: build failed`, {
    details: { side, exitCode: 103, logTail: [] },
  });
const patched = (n: number): Extract<RepairProposal, { kind: 'patched' }> => ({
  kind: 'patched',
  recipe: { ...STUB_RECIPE, notes: [`patch ${String(n)}`] },
  patch,
  tier: 'fast',
});

type Step<O> = O | Error;

/**
 * A setup loop over scripted stages: each stage returns (or throws) its next step; the last step
 * repeats. Every repair call costs $0.01.
 */
function harness(script: {
  recipe?: Step<Recipe>;
  environment: Step<RunningEnvironment>[];
  propose?: Step<RepairProposal>[];
}) {
  const test = createTestStageContext();
  const calls: StageName[] = [];
  const requests: RepairRequest[] = [];
  const kept: Recipe[] = [];
  const tried: Recipe[] = [];
  const attemptLog: (readonly SetupAttempt[])[] = [];
  let spent = 0;
  const next = <O>(steps: Step<O>[]): Promise<O> => {
    const step = steps.length > 1 ? steps.shift() : steps[0];
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step as O);
  };
  const stage = <I, O>(name: StageName, run: (input: I) => Promise<O>): Stage<I, O> => ({
    name,
    run,
  });
  const deps: SetupLoopDeps = {
    stages: {
      recipe: stage('recipe', () => next([script.recipe ?? STUB_RECIPE])),
      environment: stage('environment', ({ recipe }: { recipe: Recipe }) => {
        tried.push(recipe);
        return next(script.environment);
      }),
      repair: {
        propose: stage('repair', (request: RepairRequest) => {
          requests.push(request);
          spent += 0.01;
          return next(script.propose ?? [patched(1)]);
        }),
        keep: stage('repair', ({ recipe }: { recipe: Recipe }) => {
          kept.push(recipe);
          return Promise.resolve();
        }),
      },
    },
    runStage: (s, input) => {
      calls.push(s.name);
      return s.run(input, test.ctx);
    },
    spentUsd: () => spent,
    onAttempts: (attempts) => {
      attemptLog.push(attempts.map((attempt) => ({ ...attempt })));
    },
  };
  return {
    run: () => runSetup(workspace, deps),
    calls,
    requests,
    kept,
    tried,
    attempts: () => attemptLog.at(-1) ?? [],
  };
}

describe('runSetup', () => {
  it('needs no repair when the environment starts', async () => {
    const h = harness({ environment: [environment] });

    expect(await h.run()).toEqual({ ok: true, recipe: STUB_RECIPE, environment });
    expect(h.calls).toEqual(['recipe', 'environment']);
    expect(h.attempts()).toEqual([]);
  });

  it('repairs a failed setup, retries it, records the attempt and keeps the recipe', async () => {
    const h = harness({ environment: [buildFailed('head'), environment] });

    const result = await h.run();

    expect(result).toEqual({ ok: true, recipe: patched(1).recipe, environment });
    expect(h.calls).toEqual(['recipe', 'environment', 'repair', 'environment', 'repair']);
    expect(h.tried).toEqual([STUB_RECIPE, patched(1).recipe]);
    expect(h.kept).toEqual([patched(1).recipe]);
    expect(h.requests[0]).toMatchObject({
      recipe: STUB_RECIPE,
      failure: {
        stage: 'environment',
        code: 'SETUP_BUILD_FAILED',
        message: 'head: build failed',
        side: 'head',
      },
      attempt: 1,
      maxAttempts: MAX_SETUP_ATTEMPTS,
      previousAttempts: [],
    });
    expect(h.attempts()).toEqual([
      {
        attempt: 1,
        trigger: { stage: 'environment', code: 'SETUP_BUILD_FAILED', side: 'head' },
        tier: 'fast',
        patch,
        outcome: 'repaired',
        costUsd: 0.01,
      },
    ]);
  });

  it(`gives up after ${String(MAX_SETUP_ATTEMPTS)} attempts with the last setup failure`, async () => {
    const lastFailure = new BdiffError('SETUP_START_FAILED', 'base: app exited', {
      details: { side: 'base' },
    });
    const h = harness({
      environment: [buildFailed(), buildFailed(), buildFailed(), lastFailure],
      propose: [patched(1), patched(2), patched(3)],
    });

    const result = await h.run();

    expect(result).toEqual({
      ok: false,
      error: lastFailure,
      stage: 'environment',
      recipe: patched(3).recipe,
    });
    expect(h.calls.filter((name) => name === 'environment')).toHaveLength(4);
    expect(h.requests.map((request) => request.attempt)).toEqual([1, 2, 3]);
    expect(h.requests[2]?.previousAttempts).toHaveLength(2);
    expect(h.kept).toEqual([]);
    expect(
      h
        .attempts()
        .map(({ attempt, tier, outcome, errorCode }) => [attempt, tier, outcome, errorCode]),
    ).toEqual([
      [1, 'fast', 'setup-failed', 'SETUP_BUILD_FAILED'],
      [2, 'fast', 'setup-failed', 'SETUP_BUILD_FAILED'],
      [3, 'smart', 'setup-failed', 'SETUP_START_FAILED'],
    ]);
  });

  it('repairs a recipe detection failure from no recipe at all', async () => {
    const h = harness({
      recipe: new BdiffError('SETUP_UNSUPPORTED', 'no Next.js app found'),
      environment: [environment],
    });

    const result = await h.run();

    expect(result.ok).toBe(true);
    expect(h.calls).toEqual(['recipe', 'repair', 'environment', 'repair']);
    expect(h.requests[0]).toMatchObject({
      recipe: null,
      failure: { stage: 'recipe', code: 'SETUP_UNSUPPORTED', message: 'no Next.js app found' },
    });
    expect(h.attempts()[0]).toMatchObject({
      trigger: { stage: 'recipe', code: 'SETUP_UNSUPPORTED' },
      outcome: 'repaired',
    });
    expect(h.attempts()[0]?.trigger).not.toHaveProperty('side');
  });

  it.each(['LLM_UNAVAILABLE', 'LLM_REFUSED', 'BUDGET_EXCEEDED'] as const)(
    'stops at %s and fails with the setup failure, not the repair error',
    async (code) => {
      const failure = buildFailed();
      const h = harness({
        environment: [failure],
        propose: [new BdiffError(code, 'no repair')],
      });

      const result = await h.run();

      expect(result).toEqual({
        ok: false,
        error: failure,
        stage: 'environment',
        recipe: STUB_RECIPE,
      });
      expect(h.requests).toHaveLength(1);
      expect(h.attempts()).toEqual([
        {
          attempt: 1,
          trigger: { stage: 'environment', code: 'SETUP_BUILD_FAILED', side: 'head' },
          tier: 'fast',
          patch: null,
          outcome: 'no-patch',
          errorCode: code,
          costUsd: 0.01,
        },
      ]);
    },
  );

  it('fails a recipe detection failure with that failure when no repair is possible', async () => {
    const detection = new BdiffError('SETUP_UNSUPPORTED', 'no Next.js app found');
    const h = harness({
      recipe: detection,
      environment: [environment],
      propose: [new BdiffError('LLM_UNAVAILABLE', 'no key')],
    });

    expect(await h.run()).toEqual({ ok: false, error: detection, stage: 'recipe', recipe: null });
    expect(h.tried).toEqual([]);
  });

  it('counts an invalid answer or a rejected patch as an attempt and goes on', async () => {
    const h = harness({
      environment: [buildFailed(), environment],
      propose: [
        new BdiffError('LLM_INVALID_OUTPUT', 'bad JSON'),
        { kind: 'rejected', patch, problems: ['"sh -c x": not allowed', 'nope'], tier: 'fast' },
        { ...patched(3), tier: 'smart' },
      ],
    });

    const result = await h.run();

    expect(result.ok).toBe(true);
    expect(
      h.attempts().map(({ outcome, errorCode, problem }) => [outcome, errorCode, problem]),
    ).toEqual([
      ['no-patch', 'LLM_INVALID_OUTPUT', undefined],
      ['rejected', undefined, '"sh -c x": not allowed; nope'],
      ['repaired', undefined, undefined],
    ]);
    // The environment was not retried for the attempts without a usable patch.
    expect(h.tried).toEqual([STUB_RECIPE, patched(3).recipe]);
  });

  it('stops after rejected patches like any other attempt', async () => {
    const failure = buildFailed();
    const h = harness({
      environment: [failure],
      propose: [{ kind: 'rejected', patch, problems: ['no'], tier: 'fast' }],
    });

    const result = await h.run();

    expect(result).toMatchObject({ ok: false, error: failure });
    expect(h.attempts()).toHaveLength(MAX_SETUP_ATTEMPTS);
    expect(h.tried).toEqual([STUB_RECIPE]);
  });

  it('throws failures it cannot repair, from the environment or the repair stage', async () => {
    const docker = new BdiffError('DOCKER_UNAVAILABLE', 'no docker');
    await expect(harness({ environment: [docker] }).run()).rejects.toBe(docker);

    const aborted = new BdiffError('ABORTED', 'Interrupted by SIGINT');
    await expect(harness({ environment: [buildFailed()], propose: [aborted] }).run()).rejects.toBe(
      aborted,
    );

    const afterRepair = harness({ environment: [buildFailed(), docker] });
    await expect(afterRepair.run()).rejects.toBe(docker);
    expect(afterRepair.attempts()).toMatchObject([
      { outcome: 'setup-failed', errorCode: 'DOCKER_UNAVAILABLE' },
    ]);
  });
});
