import { detectRecipe } from './detect-recipe.js';
import {
  readRecipeCache,
  recipeCacheFile,
  recipeFingerprint,
  writeRecipeCache,
} from './recipe-cache.js';
import { loadRepoFiles } from './repo-files.js';
import type { FileSystem } from '../adapters/file-system.js';
import type { Recipe } from '../domain/recipe.js';
import type { Workspace } from '../domain/workspace.js';
import type { Stage } from '../pipeline/stage.js';

/** Added to the recipe's notes when base and head differ in what the recipe depends on. */
export const BASE_HEAD_DIFFER_NOTE =
  'base and head differ in package manifests, lockfiles or Node version';

/** Dependencies of the recipe stage. */
export interface RecipeStageDeps {
  readonly fs: FileSystem;
  /** Root of bdiff's cache; recipes live in `recipes/` under it. */
  readonly cacheDir: string;
  /** Base for relative local repository paths (to name the cache entry). */
  readonly cwd: string;
}

/**
 * The recipe stage: how to install, build and start the head checkout. Reuses the cached recipe of
 * the repository while its manifests, lockfiles and Node version files are unchanged (including a
 * recipe the repair loop produced); otherwise detects and caches a new one. If the base checkout's
 * manifests differ from head's, the recipe says so and its confidence drops to `medium`.
 */
export function createRecipeStage(deps: RecipeStageDeps): Stage<{ workspace: Workspace }, Recipe> {
  return {
    name: 'recipe',
    run: async ({ workspace }, ctx) => {
      const head = await loadRepoFiles(deps.fs, workspace.headPath);
      const fingerprint = recipeFingerprint(head);
      const cacheFile = recipeCacheFile(deps.cacheDir, ctx.target.repoUrl, deps.cwd);

      const cached = await readRecipeCache(deps.fs, cacheFile, ctx.logger);
      let recipe: Recipe;
      if (cached?.fingerprint === fingerprint) {
        ctx.logger.info('recipe cache hit', { source: cached.source });
        recipe = cached.recipe;
      } else {
        recipe = detectRecipe(head);
        await writeRecipeCache(deps.fs, cacheFile, {
          version: 1,
          fingerprint,
          source: 'detected',
          savedAt: ctx.clock.now().toISOString(),
          recipe,
        });
      }

      const base = await loadRepoFiles(deps.fs, workspace.basePath);
      if (recipeFingerprint(base) !== fingerprint) {
        recipe = {
          ...recipe,
          confidence: recipe.confidence === 'high' ? 'medium' : recipe.confidence,
          notes: [...recipe.notes, BASE_HEAD_DIFFER_NOTE],
        };
      }
      ctx.logger.info('recipe ready', {
        appRoot: recipe.appRoot,
        packageManager: recipe.packageManager.name,
        nodeVersion: recipe.nodeVersion,
        confidence: recipe.confidence,
      });
      return recipe;
    },
  };
}
