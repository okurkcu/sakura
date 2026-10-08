import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RecipeCacheEntrySchema, recipeFingerprint } from './recipe-cache.js';
import { createRecipeStage } from './recipe-stage.js';
import { createRepoFiles } from './repo-files.js';
import { nodeFileSystem } from '../adapters/file-system.js';
import type { Workspace } from '../domain/workspace.js';
import { createTestStageContext } from '../testing/stage-context.js';

async function writeTree(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    await nodeFileSystem.mkdir(path.dirname(path.join(root, file)));
    await writeFile(path.join(root, file), content);
  }
}

const app = {
  'package.json': JSON.stringify({
    scripts: { build: 'next build' },
    dependencies: { next: '15' },
  }),
  'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  'app/page.tsx': '',
};

describe('createRecipeStage', () => {
  let root: string;
  let workspace: Workspace;
  let cacheDir: string;

  const run = async () => {
    const test = createTestStageContext();
    const stage = createRecipeStage({ fs: nodeFileSystem, cacheDir, cwd: root });
    return { test, recipe: await stage.run({ workspace }, test.ctx) };
  };
  const cacheFile = async () => {
    const [entry] = await nodeFileSystem.readdir(path.join(cacheDir, 'recipes'));
    return path.join(cacheDir, 'recipes', entry ?? '');
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bdiff-recipe-'));
    cacheDir = path.join(root, 'cache');
    workspace = {
      basePath: path.join(root, 'base'),
      headPath: path.join(root, 'head'),
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
      changedFiles: [],
    };
    await writeTree(workspace.basePath, app);
    await writeTree(workspace.headPath, app);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('detects a recipe from the head checkout and caches it', async () => {
    const { recipe } = await run();

    expect(recipe).toMatchObject({ packageManager: { name: 'pnpm' }, confidence: 'medium' });
    const entry = RecipeCacheEntrySchema.parse(
      JSON.parse(await readFile(await cacheFile(), 'utf8')),
    );
    expect(entry).toMatchObject({ version: 1, source: 'detected', recipe });
  });

  it('reuses the cached recipe while manifests are unchanged', async () => {
    await run();
    const file = await cacheFile();
    const entry = RecipeCacheEntrySchema.parse(JSON.parse(await readFile(file, 'utf8')));
    await writeFile(
      file,
      JSON.stringify({ ...entry, source: 'llm', recipe: { ...entry.recipe, port: 4321 } }),
    );

    const { recipe, test } = await run();

    expect(recipe.port).toBe(4321);
    expect(test.logger.entries).toContainEqual(
      expect.objectContaining({ message: 'recipe cache hit', fields: { source: 'llm' } }),
    );
  });

  it('detects again when the lockfile changes', async () => {
    await run();
    const file = await cacheFile();
    const entry = RecipeCacheEntrySchema.parse(JSON.parse(await readFile(file, 'utf8')));
    await writeFile(file, JSON.stringify({ ...entry, recipe: { ...entry.recipe, port: 4321 } }));
    await writeFile(
      path.join(workspace.headPath, 'pnpm-lock.yaml'),
      'lockfileVersion: 9.0\n# changed\n',
    );
    await writeFile(
      path.join(workspace.basePath, 'pnpm-lock.yaml'),
      'lockfileVersion: 9.0\n# changed\n',
    );

    const { recipe } = await run();

    expect(recipe.port).toBe(3000);
  });

  it('ignores an invalid cache entry', async () => {
    await run();
    await writeFile(await cacheFile(), '{"version": 1, "recipe": "nope"}');

    const { recipe, test } = await run();

    expect(recipe.port).toBe(3000);
    expect(test.logger.entries.map((entry) => entry.message)).toContain(
      'ignoring invalid recipe cache entry',
    );
  });

  it('notes when base and head manifests differ', async () => {
    await writeFile(path.join(workspace.basePath, '.nvmrc'), '18\n');

    const { recipe } = await run();

    expect(recipe.notes.join()).toContain('base and head differ');
  });

  it('propagates SETUP_UNSUPPORTED for a repository without a Next.js app', async () => {
    await writeFile(
      path.join(workspace.headPath, 'package.json'),
      JSON.stringify({ dependencies: { vite: '6' } }),
    );

    await expect(run()).rejects.toMatchObject({ code: 'SETUP_UNSUPPORTED' });
  });
});

describe('recipeFingerprint', () => {
  it('changes with manifests, lockfiles and Node version files only', () => {
    const base = { 'package.json': '{}', 'pnpm-lock.yaml': 'a', 'app/page.tsx': 'x' };
    const fingerprint = recipeFingerprint(createRepoFiles(base));

    expect(recipeFingerprint(createRepoFiles({ ...base, 'app/page.tsx': 'y' }))).toBe(fingerprint);
    expect(recipeFingerprint(createRepoFiles({ ...base, 'pnpm-lock.yaml': 'b' }))).not.toBe(
      fingerprint,
    );
    expect(recipeFingerprint(createRepoFiles({ ...base, '.nvmrc': '20' }))).not.toBe(fingerprint);
    expect(recipeFingerprint(createRepoFiles({ ...base, 'apps/web/package.json': '{}' }))).not.toBe(
      fingerprint,
    );
  });
});
