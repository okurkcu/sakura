import { describe, expect, it } from 'vitest';

import { detectRecipe } from './detect-recipe.js';
import { createRepoFiles } from './repo-files.js';
import { RecipeSchema } from '../domain/recipe.js';

const pkg = (value: Record<string, unknown>) => JSON.stringify(value);

describe('detectRecipe', () => {
  it('produces a high-confidence recipe for a simple pnpm app', () => {
    const recipe = detectRecipe(
      createRepoFiles({
        'package.json': pkg({
          packageManager: 'pnpm@9.0.0',
          engines: { node: '>=20' },
          scripts: { build: 'next build', start: 'next start' },
          dependencies: { next: '15.0.0' },
        }),
        'pnpm-lock.yaml': '',
        'app/page.tsx': '',
      }),
    );

    expect(RecipeSchema.parse(recipe)).toEqual({
      installRoot: '.',
      appRoot: '.',
      nodeVersion: '22',
      packageManager: { name: 'pnpm', version: '9.0.0' },
      installCmd: ['pnpm', 'install', '--frozen-lockfile'],
      buildCmd: ['pnpm', 'run', 'build'],
      startCmd: ['pnpm', 'exec', 'next', 'start', '-p', '3000', '-H', '0.0.0.0'],
      port: 3000,
      healthPath: '/',
      env: {},
      missingEnv: [],
      services: [],
      dbSetupCmds: [],
      confidence: 'high',
      notes: [],
    });
  });

  it('handles a monorepo with Prisma, compose and env: medium confidence with reasons', () => {
    const recipe = detectRecipe(
      createRepoFiles({
        'package.json': pkg({ workspaces: ['apps/*'], packageManager: 'yarn@4.1.0' }),
        'yarn.lock': '',
        '.nvmrc': '20',
        'docker-compose.yml':
          'services:\n  db:\n    image: postgres:15\n  redis:\n    image: redis:7\n',
        'apps/web/package.json': pkg({
          scripts: { build: 'prisma generate && next build' },
          dependencies: { next: '14.2.0' },
        }),
        'apps/web/app/page.tsx': '',
        'apps/web/prisma/schema.prisma':
          'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
        'apps/web/.env.example': 'DATABASE_URL=\nREDIS_URL=\nAUTH_SECRET=\nANALYTICS_ID=\n',
      }),
    );

    expect(recipe).toMatchObject({
      installRoot: '.',
      appRoot: 'apps/web',
      nodeVersion: '20',
      packageManager: { name: 'yarn', version: '4.1.0' },
      installCmd: ['yarn', 'install', '--immutable'],
      buildCmd: ['yarn', 'run', 'build'],
      services: [
        { kind: 'postgres', version: '15', envVar: 'DATABASE_URL' },
        { kind: 'redis', version: '7', envVar: 'REDIS_URL' },
      ],
      dbSetupCmds: [
        ['yarn', 'prisma', 'db', 'push', '--skip-generate', '--schema', 'prisma/schema.prisma'],
      ],
      missingEnv: ['ANALYTICS_ID'],
      confidence: 'medium',
    });
    expect(recipe.env).not.toHaveProperty('DATABASE_URL');
    expect(recipe.env).not.toHaveProperty('REDIS_URL');
    expect(recipe.env.AUTH_SECRET?.source).toBe('generated');
  });

  it('installs in the app directory when the repository root has no package.json', () => {
    const recipe = detectRecipe(
      createRepoFiles({
        'site/package.json': pkg({ dependencies: { next: '15' } }),
        'site/package-lock.json': '{}',
      }),
    );

    expect(recipe).toMatchObject({
      installRoot: 'site',
      appRoot: 'site',
      installCmd: ['npm', 'ci'],
    });
  });

  it('is low confidence when several apps rank equally', () => {
    const recipe = detectRecipe(
      createRepoFiles({
        'pnpm-lock.yaml': '',
        'package.json': pkg({}),
        'apps/a/package.json': pkg({ dependencies: { next: '15' } }),
        'apps/b/package.json': pkg({ dependencies: { next: '15' } }),
      }),
    );

    expect(recipe.confidence).toBe('low');
  });

  it('throws SETUP_UNSUPPORTED for a repository that is not a Next.js app', () => {
    expect(() =>
      detectRecipe(createRepoFiles({ 'package.json': pkg({ dependencies: { express: '5' } }) })),
    ).toThrow(expect.objectContaining({ code: 'SETUP_UNSUPPORTED' }));
  });
});
