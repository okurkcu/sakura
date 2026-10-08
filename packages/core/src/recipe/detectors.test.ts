import { describe, expect, it } from 'vitest';

import { detectAppRoot } from './detect-app-root.js';
import { detectCommands } from './detect-commands.js';
import { detectComposeServices } from './detect-compose-services.js';
import { detectDatabase } from './detect-database.js';
import { detectEnv, placeholderFor } from './detect-env.js';
import { detectHealthPath } from './detect-health.js';
import { detectNodeVersion, resolveMajor } from './detect-node-version.js';
import { detectPackageManager } from './detect-package-manager.js';
import { parseDotenv } from './parse-dotenv.js';
import { createRepoFiles } from './repo-files.js';

const pkg = (value: Record<string, unknown>) => JSON.stringify(value);
const nextApp = (extra: Record<string, unknown> = {}) =>
  pkg({ dependencies: { next: '15.0.0' }, ...extra });

describe('detectPackageManager', () => {
  it.each([
    {
      name: 'pnpm lockfile',
      files: { 'pnpm-lock.yaml': '' },
      expected: { name: 'pnpm', installCmd: ['pnpm', 'install', '--frozen-lockfile'] },
    },
    {
      name: 'npm lockfile',
      files: { 'package-lock.json': '{}' },
      expected: { name: 'npm', installCmd: ['npm', 'ci'] },
    },
    {
      name: 'npm shrinkwrap',
      files: { 'npm-shrinkwrap.json': '{}' },
      expected: { name: 'npm', installCmd: ['npm', 'ci'] },
    },
    {
      name: 'yarn classic lockfile',
      files: { 'yarn.lock': '' },
      expected: { name: 'yarn', installCmd: ['yarn', 'install', '--frozen-lockfile'] },
    },
    {
      name: 'yarn berry (.yarnrc.yml)',
      files: { 'yarn.lock': '', '.yarnrc.yml': '' },
      expected: { name: 'yarn', installCmd: ['yarn', 'install', '--immutable'] },
    },
    {
      name: 'bun lockfile',
      files: { 'bun.lock': '' },
      expected: { name: 'bun', installCmd: ['bun', 'install', '--frozen-lockfile'] },
    },
    {
      name: 'packageManager field with hash',
      files: {
        'package.json': pkg({ packageManager: 'pnpm@9.12.3+sha512.abc' }),
        'pnpm-lock.yaml': '',
      },
      expected: { name: 'pnpm', version: '9.12.3', lockfile: 'pnpm-lock.yaml' },
    },
    {
      name: 'yarn 4 from packageManager',
      files: { 'package.json': pkg({ packageManager: 'yarn@4.5.0' }), 'yarn.lock': '' },
      expected: { name: 'yarn', version: '4.5.0', installCmd: ['yarn', 'install', '--immutable'] },
    },
    {
      name: 'no lockfile',
      files: { 'package.json': pkg({}) },
      expected: { name: 'npm', installCmd: ['npm', 'install'] },
    },
  ])('detects $name', ({ files, expected }) => {
    expect(detectPackageManager(createRepoFiles(files), '.')).toMatchObject(expected);
  });

  it('notes a missing lockfile', () => {
    expect(
      detectPackageManager(createRepoFiles({ 'package.json': '{}' }), '.').notes.join(),
    ).toContain('no lockfile');
  });

  it('prefers pnpm and notes several lockfiles', () => {
    const detection = detectPackageManager(
      createRepoFiles({ 'pnpm-lock.yaml': '', 'package-lock.json': '{}' }),
      '.',
    );

    expect(detection.name).toBe('pnpm');
    expect(detection.notes.join()).toContain('several lockfiles');
  });

  it('looks in the install root', () => {
    expect(detectPackageManager(createRepoFiles({ 'web/yarn.lock': '' }), 'web').name).toBe('yarn');
  });
});

describe('resolveMajor / detectNodeVersion', () => {
  it.each([
    ['22', 22],
    ['v20.11.1', 20],
    ['18.19', 18],
    ['lts/iron', 20],
    ['lts/*', 24],
    ['node', 24],
    ['>=18', 22],
    ['>=23', 24],
    ['>=18 <21', 20],
    ['^20.9.0', 20],
    ['20.x', 20],
    ['>=18.17.0 || >=20', 22],
    ['^16', undefined],
    ['banana', undefined],
  ])('resolves %j to %j', (declared, expected) => {
    expect(resolveMajor(declared)).toBe(expected);
  });

  it('prefers .nvmrc over engines, and the app directory over the root', () => {
    const files = createRepoFiles({
      '.nvmrc': '18\n',
      'apps/web/.nvmrc': '20\n',
      'apps/web/package.json': nextApp({ engines: { node: '>=22' } }),
    });

    expect(detectNodeVersion(files, 'apps/web')).toMatchObject({ version: '20', certain: true });
  });

  it('reads engines.node', () => {
    expect(
      detectNodeVersion(
        createRepoFiles({ 'package.json': nextApp({ engines: { node: '>=18 <21' } }) }),
        '.',
      ).version,
    ).toBe('20');
  });

  it('defaults to 22, uncertain, when nothing is declared or it cannot be read', () => {
    expect(detectNodeVersion(createRepoFiles({ 'package.json': nextApp() }), '.')).toMatchObject({
      version: '22',
      certain: false,
    });
    expect(detectNodeVersion(createRepoFiles({ '.nvmrc': 'stable-ish' }), '.')).toMatchObject({
      version: '22',
      certain: false,
    });
  });
});

describe('detectAppRoot', () => {
  it('finds a root app', () => {
    expect(
      detectAppRoot(createRepoFiles({ 'package.json': nextApp(), 'app/page.tsx': '' })),
    ).toMatchObject({ appRoot: '.', ambiguous: false });
  });

  it('finds the main app of a monorepo', () => {
    const files = createRepoFiles({
      'package.json': pkg({ workspaces: ['apps/*', 'packages/*'] }),
      'apps/docs/package.json': nextApp(),
      'apps/docs/app/page.tsx': '',
      'apps/web/package.json': nextApp(),
      'apps/web/app/page.tsx': '',
      'packages/ui/package.json': pkg({ dependencies: { react: '19' } }),
      'examples/blog/package.json': nextApp(),
    });

    const detection = detectAppRoot(files);

    expect(detection).toMatchObject({
      appRoot: 'apps/web',
      ambiguous: false,
      candidates: ['apps/web', 'apps/docs'],
    });
    expect(detection.notes.join()).toContain('several Next.js apps');
  });

  it('flags equally ranked apps as ambiguous', () => {
    const files = createRepoFiles({
      'apps/admin/package.json': nextApp(),
      'apps/admin/app/page.tsx': '',
      'apps/shop/package.json': nextApp(),
      'apps/shop/app/page.tsx': '',
    });

    expect(detectAppRoot(files)).toMatchObject({ appRoot: 'apps/admin', ambiguous: true });
  });

  it('prefers an app with routes', () => {
    const files = createRepoFiles({
      'apps/a/package.json': nextApp(),
      'apps/b/package.json': nextApp(),
      'apps/b/src/pages/index.tsx': '',
    });

    expect(detectAppRoot(files).appRoot).toBe('apps/b');
  });

  it('ignores apps deeper than three levels and in example folders', () => {
    const files = createRepoFiles({
      'a/b/c/d/package.json': nextApp(),
      'examples/demo/package.json': nextApp(),
    });

    expect(() => detectAppRoot(files)).toThrow(
      expect.objectContaining({ code: 'SETUP_UNSUPPORTED' }),
    );
  });

  it('throws SETUP_UNSUPPORTED without a Next.js app', () => {
    expect(() =>
      detectAppRoot(createRepoFiles({ 'package.json': pkg({ dependencies: { vite: '6' } }) })),
    ).toThrow(expect.objectContaining({ code: 'SETUP_UNSUPPORTED' }));
  });
});

describe('detectCommands', () => {
  it('runs a build script that runs next build, and next start on all interfaces', () => {
    const commands = detectCommands(
      'pnpm',
      { scripts: { build: 'prisma generate && next build', start: 'next start' } },
      3000,
    );

    expect(commands).toEqual({
      buildCmd: ['pnpm', 'run', 'build'],
      startCmd: ['pnpm', 'exec', 'next', 'start', '-p', '3000', '-H', '0.0.0.0'],
      notes: [],
    });
  });

  it.each([
    ['npm', ['npm', 'exec', '--', 'next', 'build']],
    ['yarn', ['yarn', 'next', 'build']],
    ['bun', ['bun', 'x', 'next', 'build']],
  ] as const)('runs next build directly with %s when there is no build script', (pm, expected) => {
    expect(detectCommands(pm, {}, 3000).buildCmd).toEqual(expected);
  });

  it('never uses dev, and notes unusual scripts', () => {
    const commands = detectCommands(
      'npm',
      { scripts: { build: 'echo hi', start: 'next dev' } },
      4000,
    );

    expect(commands.buildCmd).toEqual(['npm', 'exec', '--', 'next', 'build']);
    expect(commands.startCmd).toEqual([
      'npm',
      'exec',
      '--',
      'next',
      'start',
      '-p',
      '4000',
      '-H',
      '0.0.0.0',
    ]);
    expect(commands.notes).toHaveLength(2);
  });
});

describe('parseDotenv', () => {
  it('parses keys, quotes, export and comments', () => {
    const parsed = parseDotenv(
      [
        '# comment',
        '',
        'PLAIN=value',
        'EMPTY=',
        'export EXPORTED=yes',
        'DOUBLE="a b # not a comment"',
        "SINGLE='x=y'",
        'INLINE=value # comment',
        'MULTI="line1\\nline2"',
        'not a pair',
        '1BAD=x',
        'PLAIN=last wins',
      ].join('\n'),
    );

    expect(Object.fromEntries(parsed)).toEqual({
      PLAIN: 'last wins',
      EMPTY: '',
      EXPORTED: 'yes',
      DOUBLE: 'a b # not a comment',
      SINGLE: 'x=y',
      INLINE: 'value',
      MULTI: 'line1\nline2',
    });
  });
});

describe('detectEnv', () => {
  it('uses example values, fills safe placeholders and reports missing keys', () => {
    const files = createRepoFiles({
      '.env.example': [
        'NEXT_PUBLIC_SITE_NAME=Shop',
        'NEXTAUTH_URL=',
        'NEXTAUTH_SECRET=',
        'STRIPE_SECRET_KEY=',
        'DATABASE_URL=postgres://localhost/dev',
        'FEATURE_FLAG=',
        'SENTRY_DSN=',
      ].join('\n'),
    });

    const detection = detectEnv(files, '.', 3000, new Set(['DATABASE_URL']));

    expect(detection.env).toMatchObject({
      NEXT_PUBLIC_SITE_NAME: { value: 'Shop', source: 'example' },
      NEXTAUTH_URL: { value: 'http://localhost:3000', source: 'generated' },
      NEXTAUTH_SECRET: { source: 'generated' },
      STRIPE_SECRET_KEY: { source: 'generated' },
      FEATURE_FLAG: { value: '', source: 'example' },
    });
    expect(detection.env).not.toHaveProperty('DATABASE_URL');
    expect(detection.missing).toEqual(['FEATURE_FLAG', 'SENTRY_DSN']);
    expect(detection.notes.join()).toContain('FEATURE_FLAG, SENTRY_DSN');
  });

  it('lets the app directory override the root example', () => {
    const files = createRepoFiles({
      '.env.example': 'A=root\nB=root',
      'apps/web/.env.example': 'A=app',
    });

    expect(detectEnv(files, 'apps/web', 3000, new Set()).env).toMatchObject({
      A: { value: 'app' },
      B: { value: 'root' },
    });
  });

  it('never reads real .env files', () => {
    const files = createRepoFiles({ '.env': 'SECRET=real', '.env.local': 'TOKEN=real' });

    expect(detectEnv(files, '.', 3000, new Set())).toEqual({ env: {}, missing: [], notes: [] });
  });

  it('generates stable, key-specific secrets', () => {
    expect(placeholderFor('NEXTAUTH_SECRET', 3000)).toBe(placeholderFor('NEXTAUTH_SECRET', 3000));
    expect(placeholderFor('NEXTAUTH_SECRET', 3000)).not.toBe(placeholderFor('JWT_SECRET', 3000));
    expect(placeholderFor('SOME_FLAG', 3000)).toBeUndefined();
  });
});

describe('detectDatabase', () => {
  const prismaSchema = (provider: string, envVar = 'DATABASE_URL') =>
    `generator client {\n  provider = "prisma-client-js"\n}\n\ndatasource db {\n  provider = "${provider}"\n  url      = env("${envVar}")\n}\n`;

  it('detects Prisma with postgres and migrations', () => {
    const files = createRepoFiles({
      'package.json': nextApp({ prisma: { seed: 'tsx prisma/seed.ts' } }),
      'prisma/schema.prisma': prismaSchema('postgresql', 'POSTGRES_PRISMA_URL'),
      'prisma/migrations/0001_init/migration.sql': 'create table x();',
    });

    expect(detectDatabase(files, '.', 'pnpm', '15')).toEqual({
      services: [{ kind: 'postgres', version: '15', envVar: 'POSTGRES_PRISMA_URL' }],
      env: {},
      setupCmds: [
        ['pnpm', 'exec', 'prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'],
        ['pnpm', 'exec', 'prisma', 'db', 'seed', '--schema', 'prisma/schema.prisma'],
      ],
      notes: [],
    });
  });

  it('pushes the Prisma schema when there are no migrations, in a monorepo app', () => {
    const files = createRepoFiles({ 'apps/web/prisma/schema.prisma': prismaSchema('postgresql') });

    expect(detectDatabase(files, 'apps/web', 'npm', undefined)).toMatchObject({
      services: [{ kind: 'postgres', version: '16', envVar: 'DATABASE_URL' }],
      setupCmds: [
        [
          'npm',
          'exec',
          '--',
          'prisma',
          'db',
          'push',
          '--skip-generate',
          '--schema',
          'prisma/schema.prisma',
        ],
      ],
    });
  });

  it('uses a SQLite file for Prisma sqlite', () => {
    const files = createRepoFiles({ 'prisma/schema.prisma': prismaSchema('sqlite') });

    expect(detectDatabase(files, '.', 'pnpm', undefined)).toMatchObject({
      services: [],
      env: { DATABASE_URL: 'file:./bdiff.db' },
    });
  });

  it.each(['mysql', 'mongodb', 'sqlserver'])('rejects Prisma %s', (provider) => {
    const files = createRepoFiles({ 'prisma/schema.prisma': prismaSchema(provider) });

    expect(() => detectDatabase(files, '.', 'pnpm', undefined)).toThrow(
      expect.objectContaining({ code: 'SETUP_UNSUPPORTED' }),
    );
  });

  it('detects Drizzle with postgres and migrations', () => {
    const files = createRepoFiles({
      'drizzle.config.ts': `export default defineConfig({ dialect: 'postgresql', out: './drizzle', dbCredentials: { url: process.env.POSTGRES_URL! } });`,
      'drizzle/0000_init.sql': 'create table x();',
    });

    expect(detectDatabase(files, '.', 'pnpm', undefined)).toMatchObject({
      services: [{ kind: 'postgres', envVar: 'POSTGRES_URL' }],
      setupCmds: [['pnpm', 'exec', 'drizzle-kit', 'migrate']],
    });
  });

  it('pushes the Drizzle schema without migrations, and supports the legacy pg driver', () => {
    const files = createRepoFiles({
      'drizzle.config.js': `module.exports = { driver: 'pg', schema: './db/schema.ts' };`,
    });

    expect(detectDatabase(files, '.', 'yarn', undefined)).toMatchObject({
      services: [{ kind: 'postgres', envVar: 'DATABASE_URL' }],
      setupCmds: [['yarn', 'drizzle-kit', 'push']],
    });
  });

  it('rejects Drizzle mysql', () => {
    const files = createRepoFiles({ 'drizzle.config.ts': `export default { dialect: 'mysql' };` });

    expect(() => detectDatabase(files, '.', 'pnpm', undefined)).toThrow(
      expect.objectContaining({ code: 'SETUP_UNSUPPORTED' }),
    );
  });

  it('finds nothing without Prisma or Drizzle', () => {
    expect(
      detectDatabase(createRepoFiles({ 'package.json': nextApp() }), '.', 'npm', undefined),
    ).toEqual({
      services: [],
      env: {},
      setupCmds: [],
      notes: [],
    });
  });
});

describe('detectComposeServices', () => {
  it('reads postgres and redis image tags', () => {
    const files = createRepoFiles({
      'docker-compose.yml':
        'services:\n  db:\n    image: postgres:15-alpine\n  cache:\n    image: redis\n  app:\n    build: .\n',
    });

    expect(detectComposeServices(files, '.')).toEqual({
      postgres: '15-alpine',
      redis: 'latest',
      notes: [],
    });
  });

  it('ignores a broken compose file with a note', () => {
    expect(
      detectComposeServices(createRepoFiles({ 'compose.yaml': 'services: [unclosed' }), '.').notes,
    ).toHaveLength(1);
  });

  it('ignores other images and missing files', () => {
    expect(
      detectComposeServices(
        createRepoFiles({ 'compose.yml': 'services:\n  s:\n    image: mysql:8\n' }),
        '.',
      ),
    ).toEqual({ notes: [] });
    expect(detectComposeServices(createRepoFiles({}), '.')).toEqual({ notes: [] });
  });
});

describe('detectHealthPath', () => {
  it.each([
    [{ 'app/api/health/route.ts': '' }, '.', '/api/health'],
    [{ 'apps/web/src/app/api/health/route.js': '' }, 'apps/web', '/api/health'],
    [{ 'pages/api/health.ts': '' }, '.', '/api/health'],
    [{ 'app/api/healthz/route.ts': '' }, '.', '/api/healthz'],
    [{ 'app/page.tsx': '' }, '.', '/'],
  ])('finds %j in %s → %s', (files, appRoot, expected) => {
    expect(detectHealthPath(createRepoFiles(files), appRoot)).toBe(expected);
  });
});
