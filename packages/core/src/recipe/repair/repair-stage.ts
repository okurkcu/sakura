import { fallbackRecipe } from './fallback-recipe.js';
import { applyRecipePatch } from './recipe-patch.js';
import { isRepairContextFile, repairRepoContext } from './repair-context.js';
import type { FileSystem } from '../../adapters/file-system.js';
import { repairTier } from '../../domain/setup-repair.js';
import { tailLines } from '../../environment/setup-failure.js';
import { BdiffError } from '../../errors/bdiff-error.js';
import type { LlmCallContext, LlmClient } from '../../llm/llm-client.js';
import { recipeRepairPrompt } from '../../llm/prompts/recipe-repair.js';
import type { PipelineStages } from '../../pipeline/pipeline-stages.js';
import type { StageContext } from '../../pipeline/stage.js';
import { recipeCacheFile, recipeFingerprint, writeRecipeCache } from '../recipe-cache.js';
import { BASE_HEAD_DIFFER_NOTE } from '../recipe-stage.js';
import { loadFilesWhere, loadRepoFiles } from '../repo-files.js';

/** Most the repair loop may spend on LLM calls in one run, in USD. */
export const REPAIR_BUDGET_USD = 0.5;
/** Log lines of the failing container shown to the LLM. */
export const REPAIR_LOG_LINES = 150;

/** Dependencies of the repair stage. */
export interface RepairStageDeps {
  readonly fs: FileSystem;
  readonly llm: LlmClient;
  /** Root of bdiff's cache; recipes live in `recipes/` under it. */
  readonly cacheDir: string;
  /** Base for relative local repository paths (to name the cache entry). */
  readonly cwd: string;
  /** Overrides {@link REPAIR_BUDGET_USD}. */
  readonly budgetUsd?: number;
}

/** The two steps of setup repair; the orchestrator runs the loop between them. */
export type RepairStages = PipelineStages['repair'];

/**
 * The setup repair stage. `propose` shows the LLM the failure (error code, last
 * {@link REPAIR_LOG_LINES} log lines of the failing side), the recipe (or a fallback when detection
 * found none), earlier attempts and parts of the head checkout, and gets back a `RecipePatch`.
 * The `fast` tier answers, the `smart` tier on the last attempt. The patch is applied only if it
 * passes `applyRecipePatch` (command allowlist, paths, Node version); otherwise it comes back
 * `rejected`. LLM spend across a run's attempts is capped at {@link REPAIR_BUDGET_USD}, within the
 * run's own budget.
 *
 * @throws BdiffError from the LLM client: `BUDGET_EXCEEDED` (run or repair budget),
 *   `LLM_UNAVAILABLE`, `LLM_REFUSED`, `LLM_INVALID_OUTPUT`, `LLM_REQUEST_FAILED`.
 */
export function createRepairStages(deps: RepairStageDeps): RepairStages {
  const limitUsd = deps.budgetUsd ?? REPAIR_BUDGET_USD;
  return {
    propose: {
      name: 'repair',
      run: async (request, ctx) => {
        const files = await loadFilesWhere(
          deps.fs,
          request.workspace.headPath,
          isRepairContextFile,
        );
        const recipe = request.recipe ?? fallbackRecipe(files, request.failure.message);
        const repo = repairRepoContext(files, recipe.appRoot);
        const side = request.failure.side;
        const log =
          side !== undefined && (await deps.fs.exists(ctx.paths.log(side)))
            ? await deps.fs.readFile(ctx.paths.log(side))
            : '';
        const tier = repairTier(request.attempt, request.maxAttempts);
        const spentBefore = request.previousAttempts.reduce((sum, a) => sum + a.costUsd, 0);

        const { data: patch } = await deps.llm.complete(
          recipeRepairPrompt({
            failure: request.failure,
            attempt: request.attempt,
            maxAttempts: request.maxAttempts,
            recipe,
            previousAttempts: request.previousAttempts.map(
              ({ attempt, patch: earlier, outcome, errorCode, problem }) => ({
                attempt,
                patch: earlier,
                outcome,
                ...(errorCode === undefined ? {} : { errorCode }),
                ...(problem === undefined ? {} : { problem }),
              }),
            ),
            ...repo,
            logTail: tailLines(log, REPAIR_LOG_LINES),
            tier,
          }),
          repairCallContext(ctx, spentBefore, limitUsd),
        );

        const result = applyRecipePatch(recipe, patch, files, request.attempt);
        if (!result.ok) {
          ctx.logger.warn('recipe patch rejected', {
            attempt: request.attempt,
            problems: [...result.problems],
          });
          return { kind: 'rejected', patch, problems: result.problems, tier };
        }
        ctx.logger.info('recipe patched', { attempt: request.attempt, reason: patch.reason });
        return { kind: 'patched', recipe: result.recipe, patch, tier };
      },
    },
    keep: {
      name: 'repair',
      run: async ({ workspace, recipe }, ctx) => {
        const head = await loadRepoFiles(deps.fs, workspace.headPath);
        await writeRecipeCache(
          deps.fs,
          recipeCacheFile(deps.cacheDir, ctx.target.repoUrl, deps.cwd),
          {
            version: 1,
            fingerprint: recipeFingerprint(head),
            source: 'llm',
            savedAt: ctx.clock.now().toISOString(),
            // The recipe stage adds this note per run; keep it out of the cached recipe.
            recipe: { ...recipe, notes: recipe.notes.filter((n) => n !== BASE_HEAD_DIFFER_NOTE) },
          },
        );
        ctx.logger.info('repaired recipe cached');
      },
    },
  };
}

/**
 * The stage context with the repair budget on top of the run's: `assertAvailable` also fails once
 * this run's repair calls (earlier attempts' `spentBefore` plus this one's) reach `limitUsd`.
 */
function repairCallContext(
  ctx: StageContext,
  spentBefore: number,
  limitUsd: number,
): LlmCallContext {
  let spent = spentBefore;
  return {
    signal: ctx.signal,
    logger: ctx.logger,
    recordLlmUsage: (purpose, usage) => {
      const entry = ctx.recordLlmUsage(purpose, usage);
      spent += entry.costUsd;
      return entry;
    },
    budget: {
      limitUsd: Math.min(ctx.budget.limitUsd, limitUsd),
      spentUsd: () => spent,
      assertAvailable: () => {
        ctx.budget.assertAvailable();
        if (spent >= limitUsd) {
          throw new BdiffError(
            'BUDGET_EXCEEDED',
            `Setup repair budget of $${String(limitUsd)} spent`,
            { details: { limitUsd, spentUsd: spent } },
          );
        }
      },
    },
  };
}
