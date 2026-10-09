import path from 'node:path';

import { recipeCommandProblems } from './command-allowlist.js';
import type { Recipe } from '../../domain/recipe.js';
import type { RecipePatch } from '../../domain/setup-repair.js';
import { SUPPORTED_NODE_MAJORS } from '../detect-node-version.js';
import { inDir } from '../repo-files.js';
import type { RepoFiles } from '../repo-files.js';

/** A patch applied to a recipe: the new recipe, or why the patch was rejected. */
export type PatchResult =
  | { readonly ok: true; readonly recipe: Recipe }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Applies a repair patch to `recipe` and checks the result against the repository: the app root
 * must hold a `package.json`, the Node version must be one bdiff supports, every command must pass
 * the allowlist (`recipeCommandProblems`), and the patch must change something. Variables the patch
 * sets leave `missingEnv` and are marked `source: 'llm'`. Pure.
 */
export function applyRecipePatch(
  recipe: Recipe,
  patch: RecipePatch,
  files: RepoFiles,
  attempt: number,
): PatchResult {
  const problems: string[] = [];
  const appRoot = patch.appRoot === null ? recipe.appRoot : normalizeDir(patch.appRoot);
  if (appRoot === undefined) {
    problems.push(`appRoot "${patch.appRoot ?? ''}" must be a directory inside the repository`);
  } else if (!files.has(inDir(appRoot, 'package.json'))) {
    problems.push(`appRoot "${appRoot}" has no package.json`);
  }
  if (
    patch.nodeVersion !== null &&
    !SUPPORTED_NODE_MAJORS.some((major) => String(major) === patch.nodeVersion)
  ) {
    problems.push(
      `nodeVersion ${patch.nodeVersion} is not supported (use one of ${SUPPORTED_NODE_MAJORS.join(', ')})`,
    );
  }

  const env = { ...recipe.env };
  for (const { name, value } of patch.env) {
    env[name] = { value, source: 'llm' };
  }
  const setNames = new Set(patch.env.map((entry) => entry.name));
  const packageManager =
    patch.packageManager === null || patch.packageManager === recipe.packageManager.name
      ? recipe.packageManager
      : { name: patch.packageManager };
  const patched: Recipe = {
    ...recipe,
    appRoot: appRoot ?? recipe.appRoot,
    nodeVersion: patch.nodeVersion ?? recipe.nodeVersion,
    packageManager,
    installCmd: patch.installCmd ?? recipe.installCmd,
    buildCmd: patch.buildCmd ?? recipe.buildCmd,
    startCmd: patch.startCmd ?? recipe.startCmd,
    dbSetupCmds: patch.dbSetupCmds ?? recipe.dbSetupCmds,
    port: patch.port ?? recipe.port,
    healthPath: patch.healthPath ?? recipe.healthPath,
    env,
    missingEnv: recipe.missingEnv.filter((name) => !setNames.has(name)),
  };
  problems.push(...recipeCommandProblems(patched, files));
  if (problems.length === 0 && JSON.stringify(patched) === JSON.stringify(recipe)) {
    problems.push('the patch changes nothing');
  }
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    recipe: {
      ...patched,
      notes: [...recipe.notes, `repaired by the LLM (attempt ${String(attempt)}): ${patch.reason}`],
    },
  };
}

/** `dir` as a normalized repository-relative directory, or undefined if it leaves the repository. */
function normalizeDir(dir: string): string | undefined {
  if (path.posix.isAbsolute(dir)) {
    return undefined;
  }
  const normalized = path.posix.normalize(dir).replace(/\/+$/, '');
  return normalized === '..' || normalized.startsWith('../') ? undefined : normalized || '.';
}
