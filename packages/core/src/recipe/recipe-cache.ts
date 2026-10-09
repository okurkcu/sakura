import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

import { z } from 'zod';

import type { RepoFiles } from './repo-files.js';
import type { FileSystem } from '../adapters/file-system.js';
import type { Logger } from '../adapters/logger.js';
import { RecipeSchema } from '../domain/recipe.js';
import { resolveRepoSource } from '../workspace/repo-cache.js';

/** File names whose content decides whether a cached recipe still applies. */
const FINGERPRINT_NAMES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'bun.lock',
  '.nvmrc',
  '.node-version',
]);
const MAX_FINGERPRINT_DEPTH = 3;

/** A cached recipe. `llm` recipes come from the setup repair loop and are reused just the same. */
export const RecipeCacheEntrySchema = z.strictObject({
  version: z.literal(1),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  source: z.enum(['detected', 'llm']),
  savedAt: z.iso.datetime(),
  recipe: RecipeSchema,
});
export type RecipeCacheEntry = z.infer<typeof RecipeCacheEntrySchema>;

/**
 * SHA-256 over the paths and contents of every manifest, lockfile and Node version file (at most
 * three levels deep). Any change to them invalidates the cached recipe. Pure.
 */
export function recipeFingerprint(files: RepoFiles): string {
  const hash = createHash('sha256');
  for (const file of files.list) {
    if (
      FINGERPRINT_NAMES.has(path.posix.basename(file)) &&
      file.split('/').length <= MAX_FINGERPRINT_DEPTH + 1
    ) {
      hash
        .update(file)
        .update('\0')
        .update(files.read(file) ?? '')
        .update('\0');
    }
  }
  return hash.digest('hex');
}

/** The cache file of a repository's recipe: `<cacheDir>/recipes/<repo dir name>.json`. */
export function recipeCacheFile(cacheDir: string, repoUrl: string, cwd: string): string {
  return path.join(cacheDir, 'recipes', `${resolveRepoSource(repoUrl, cwd).dirName}.json`);
}

/** Reads a cache entry; a missing, unreadable or invalid entry counts as no entry (logged). */
export async function readRecipeCache(
  fs: FileSystem,
  file: string,
  logger: Logger,
): Promise<RecipeCacheEntry | undefined> {
  if (!(await fs.exists(file))) {
    return undefined;
  }
  try {
    return RecipeCacheEntrySchema.parse(JSON.parse(await fs.readFile(file)));
  } catch (error) {
    logger.warn('ignoring invalid recipe cache entry', { file, err: error });
    return undefined;
  }
}

/** Writes a cache entry atomically (temp file, then rename). */
export async function writeRecipeCache(
  fs: FileSystem,
  file: string,
  entry: RecipeCacheEntry,
): Promise<void> {
  const valid = RecipeCacheEntrySchema.parse(entry);
  await fs.mkdir(path.dirname(file));
  const temp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(valid, null, 2)}\n`);
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp);
  }
}
