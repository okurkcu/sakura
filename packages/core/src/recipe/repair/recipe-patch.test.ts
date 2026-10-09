import { describe, expect, it } from 'vitest';

import { fallbackRecipe } from './fallback-recipe.js';
import { applyRecipePatch } from './recipe-patch.js';
import type { Recipe } from '../../domain/recipe.js';
import type { RecipePatch } from '../../domain/setup-repair.js';
import { RecipePatchSchema } from '../../domain/setup-repair.js';
import { STUB_RECIPE } from '../../testing/stub-stages.js';
import { createRepoFiles } from '../repo-files.js';

const files = createRepoFiles(
  {
    'package.json': JSON.stringify({ scripts: { build: 'next build', start: 'node server.mjs' } }),
    'apps/web/package.json': JSON.stringify({ scripts: { build: 'next build' } }),
  },
  ['server.mjs'],
);
const recipe: Recipe = { ...STUB_RECIPE, missingEnv: ['SESSION_SECRET', 'OTHER'] };

/** A patch that changes nothing but what `changes` sets. */
const patch = (changes: Partial<RecipePatch> = {}): RecipePatch => ({
  reason: 'test',
  env: [],
  nodeVersion: null,
  packageManager: null,
  installCmd: null,
  buildCmd: null,
  startCmd: null,
  dbSetupCmds: null,
  appRoot: null,
  port: null,
  healthPath: null,
  ...changes,
});

describe('applyRecipePatch', () => {
  it('sets env values and commands, keeps the rest, and notes the repair', () => {
    const result = applyRecipePatch(
      recipe,
      patch({
        reason: 'The build needs SESSION_SECRET; the app starts with its custom server.',
        env: [{ name: 'SESSION_SECRET', value: 'bdiff-test-secret-0123456789' }],
        startCmd: ['pnpm', 'run', 'start'],
      }),
      files,
      2,
    );

    expect(result).toEqual({
      ok: true,
      recipe: {
        ...recipe,
        env: { SESSION_SECRET: { value: 'bdiff-test-secret-0123456789', source: 'llm' } },
        missingEnv: ['OTHER'],
        startCmd: ['pnpm', 'run', 'start'],
        notes: [
          'repaired by the LLM (attempt 2): The build needs SESSION_SECRET; the app starts with its custom server.',
        ],
      },
    });
  });

  it('switches the package manager, dropping the pinned version', () => {
    const result = applyRecipePatch(
      { ...recipe, packageManager: { name: 'pnpm', version: '9.0.0' } },
      patch({
        packageManager: 'npm',
        installCmd: ['npm', 'install'],
        buildCmd: ['npm', 'run', 'build'],
        startCmd: ['npm', 'exec', '--', 'next', 'start'],
      }),
      files,
      1,
    );

    expect(result.ok && result.recipe).toMatchObject({
      packageManager: { name: 'npm' },
      installCmd: ['npm', 'install'],
    });
    expect(result.ok && result.recipe.packageManager).not.toHaveProperty('version');
  });

  it('moves the app root and normalizes it', () => {
    const result = applyRecipePatch(recipe, patch({ appRoot: './apps/web/' }), files, 1);

    expect(result.ok && result.recipe.appRoot).toBe('apps/web');
  });

  it.each<[string, Partial<RecipePatch>, RegExp]>([
    ['a disallowed start command', { startCmd: ['sh', '-c', 'next start'] }, /"sh -c next start"/],
    ['an undefined script', { buildCmd: ['pnpm', 'run', 'compile'] }, /script "compile"/],
    [
      'commands left on the old package manager',
      { packageManager: 'npm' },
      /"pnpm install --frozen-lockfile": only npm/,
    ],
    ['an app root outside the repository', { appRoot: '../elsewhere' }, /inside the repository/],
    ['an absolute app root', { appRoot: '/app' }, /inside the repository/],
    ['an app root without package.json', { appRoot: 'docs' }, /"docs" has no package\.json/],
    ['an unsupported Node version', { nodeVersion: '16' }, /nodeVersion 16 is not supported/],
    ['no change at all', {}, /changes nothing/],
  ])('rejects %s', (_name, changes, problem) => {
    const result = applyRecipePatch(recipe, patch(changes), files, 1);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.problems).toContainEqual(expect.stringMatching(problem));
  });
});

describe('RecipePatchSchema', () => {
  it.each([
    ['a lower-case-start env name with a dash', { env: [{ name: 'MY-VAR', value: 'x' }] }],
    ['a shell string as a command', { startCmd: 'pnpm start' }],
    ['an empty command', { buildCmd: [] }],
    ['a health path without a slash', { healthPath: 'health' }],
    ['an extra field', { services: [] }],
  ])('rejects %s', (_name, changes) => {
    expect(RecipePatchSchema.safeParse({ ...patch(), ...changes }).success).toBe(false);
  });
});

describe('fallbackRecipe', () => {
  it('guesses a root Next.js app from the root package.json, with low confidence', () => {
    const recipe = fallbackRecipe(
      createRepoFiles({
        'package.json': JSON.stringify({ scripts: { build: 'next build' } }),
        'package-lock.json': '{}',
        '.nvmrc': '20\n',
      }),
      'no Next.js app found',
    );

    expect(recipe).toMatchObject({
      installRoot: '.',
      appRoot: '.',
      nodeVersion: '20',
      packageManager: { name: 'npm' },
      installCmd: ['npm', 'ci'],
      buildCmd: ['npm', 'run', 'build'],
      startCmd: ['npm', 'exec', '--', 'next', 'start', '-p', '3000', '-H', '0.0.0.0'],
      port: 3000,
      healthPath: '/',
      confidence: 'low',
    });
    expect(recipe.notes[0]).toBe('recipe detection failed: no Next.js app found');
  });
});
