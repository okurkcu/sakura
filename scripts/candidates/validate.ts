import {
  BdiffError,
  createArtifactPaths,
  createCleanupRegistry,
  createRecipeStage,
  createRunId,
  createWorkspaceStage,
  isBdiffError,
} from '@bdiff/core';
import type { Clock, Exec, FileSystem, Logger, Recipe, StageContext, Target } from '@bdiff/core';

import type { Candidate, Validation } from './schema.js';

/** Prepares a target as far as a recipe: what `--validate` checks. */
export type SetupCheck = (target: Target) => Promise<Recipe>;

/**
 * Adds a `validation` to each candidate: `ok` with the recipe's confidence when bdiff could check
 * out base and head and detect a recipe, else the error code. One failing candidate never stops
 * the others; an interrupt does.
 */
export async function validateCandidates(
  candidates: readonly Candidate[],
  check: SetupCheck,
  logger: Logger,
): Promise<Candidate[]> {
  const validated: Candidate[] = [];
  for (const [index, candidate] of candidates.entries()) {
    let validation: Validation;
    try {
      const recipe = await check({
        repoUrl: candidate.repoUrl,
        baseRef: candidate.baseRef,
        headRef: candidate.headRef,
        ...(candidate.prNumber === undefined ? {} : { prNumber: candidate.prNumber }),
      });
      validation = { status: 'ok', confidence: recipe.confidence };
    } catch (error) {
      if (isBdiffError(error) && error.code === 'ABORTED') {
        throw error;
      }
      validation = {
        status: 'failed',
        code: isBdiffError(error) ? error.code : 'INTERNAL',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    logger.info('candidate validated', {
      index: index + 1,
      of: candidates.length,
      id: candidate.id,
      status: validation.status,
    });
    validated.push({ ...candidate, validation });
  }
  return validated;
}

/** Dependencies of {@link createSetupCheck}. */
export interface SetupCheckDeps {
  readonly exec: Exec;
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly logger: Logger;
  /** bdiff's cache: repository clones and recipes are shared with `bdiff run`. */
  readonly cacheDir: string;
  /** Scratch output root for the checks' worktrees. */
  readonly workDir: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
}

const CHECK_TIMEOUT_MS = 10 * 60_000;
const CLEANUP_TIMEOUT_MS = 60_000;

/**
 * A {@link SetupCheck} with bdiff's real workspace and recipe stages, outside the pipeline: no
 * container is built and no LLM is called. Worktrees are released after every check.
 */
export function createSetupCheck(deps: SetupCheckDeps): SetupCheck {
  const workspaceStage = createWorkspaceStage({
    exec: deps.exec,
    fs: deps.fs,
    cacheDir: deps.cacheDir,
    cwd: deps.cwd,
  });
  const recipeStage = createRecipeStage({ fs: deps.fs, cacheDir: deps.cacheDir, cwd: deps.cwd });
  return async (target) => {
    const runId = createRunId(deps.clock);
    const logger = deps.logger.child({ runId, repo: target.repoUrl });
    const cleanup = createCleanupRegistry(deps.clock, logger, CLEANUP_TIMEOUT_MS);
    const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]);
    const ctx: StageContext = {
      runId,
      target,
      logger,
      clock: deps.clock,
      paths: createArtifactPaths(deps.workDir, runId),
      signal,
      budget: {
        limitUsd: 0,
        spentUsd: () => 0,
        assertAvailable: () => {
          throw new BdiffError('BUDGET_EXCEEDED', 'Setup checks make no LLM calls');
        },
      },
      onCleanup: (name, hook) => {
        cleanup.register(name, hook);
      },
      recordLlmUsage: () => {
        throw new BdiffError('INTERNAL', 'Setup checks make no LLM calls');
      },
      addCounts: () => undefined,
      setComputeSeconds: () => undefined,
    };
    try {
      const workspace = await workspaceStage.run(target, ctx);
      return await recipeStage.run({ workspace }, ctx);
    } finally {
      const failures = await cleanup.runAll();
      if (failures.length > 0) {
        logger.warn('setup check cleanup failed', { hooks: failures.map((f) => f.name) });
      }
    }
  };
}
