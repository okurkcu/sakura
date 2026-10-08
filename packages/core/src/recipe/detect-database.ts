import path from 'node:path';

import { execPrefix } from './detect-package-manager.js';
import { inDir, readPackageJson, stringField } from './repo-files.js';
import type { RepoFiles } from './repo-files.js';
import type { PackageManagerName, RecipeService } from '../domain/recipe.js';
import { BdiffError } from '../errors/bdiff-error.js';

const DEFAULT_POSTGRES_VERSION = '16';
const DEFAULT_DB_ENV = 'DATABASE_URL';

/** What the app's database needs. */
export interface DatabaseDetection {
  readonly services: RecipeService[];
  /** Env values the database needs that are not service URLs (e.g. a SQLite file). */
  readonly env: Record<string, string>;
  readonly setupCmds: string[][];
  readonly notes: string[];
}

/**
 * Detects Prisma (`schema.prisma`) or Drizzle (`drizzle.config.*`) and what they need: a postgres
 * service, or a SQLite file; migrate (or push) and seed commands to run before the build.
 *
 * @throws BdiffError `SETUP_UNSUPPORTED` for databases bdiff can't provide (MySQL, SQL Server,
 *   MongoDB, …).
 */
export function detectDatabase(
  files: RepoFiles,
  appRoot: string,
  pm: PackageManagerName,
  postgresVersion: string | undefined,
): DatabaseDetection {
  const exec = execPrefix(pm);
  const prismaSchema = findPrismaSchema(files, appRoot);
  if (prismaSchema !== undefined) {
    return detectPrisma(files, appRoot, prismaSchema, exec, postgresVersion);
  }
  const drizzleConfig = ['ts', 'js', 'mjs', 'cjs', 'mts', 'cts', 'json']
    .map((ext) => inDir(appRoot, `drizzle.config.${ext}`))
    .find((file) => files.read(file) !== undefined);
  if (drizzleConfig !== undefined) {
    return detectDrizzle(files, appRoot, drizzleConfig, exec, postgresVersion);
  }
  return { services: [], env: {}, setupCmds: [], notes: [] };
}

function findPrismaSchema(files: RepoFiles, appRoot: string): string | undefined {
  const configured = stringField(readPackageJson(files, appRoot)?.prisma, 'schema');
  const candidates = [
    ...(configured === undefined ? [] : [path.posix.normalize(inDir(appRoot, configured))]),
    inDir(appRoot, 'prisma/schema.prisma'),
    inDir(appRoot, 'schema.prisma'),
  ];
  return (
    candidates.find((file) => files.read(file) !== undefined) ??
    files.list.find(
      (file) => file.startsWith(inDir(appRoot, 'prisma/')) && file.endsWith('.prisma'),
    )
  );
}

function detectPrisma(
  files: RepoFiles,
  appRoot: string,
  schemaFile: string,
  exec: string[],
  postgresVersion: string | undefined,
): DatabaseDetection {
  const schemaDir = path.posix.dirname(schemaFile);
  const schemaText = files.list
    .filter((file) => file.endsWith('.prisma') && path.posix.dirname(file).startsWith(schemaDir))
    .map((file) => files.read(file) ?? '')
    .join('\n');
  const datasource = /datasource\s+\w+\s*\{([\s\S]*?)\}/.exec(schemaText)?.[1] ?? '';
  const provider = /provider\s*=\s*"([^"]+)"/.exec(datasource)?.[1];
  const envVar = /url\s*=\s*env\(\s*"([^"]+)"\s*\)/.exec(datasource)?.[1] ?? DEFAULT_DB_ENV;
  const prisma = [...exec, 'prisma'];
  const relativeSchema = path.posix.relative(appRoot === '.' ? '' : appRoot, schemaFile);
  const schemaArgs = ['--schema', relativeSchema];
  const hasMigrations = files.list.some(
    (file) => file.startsWith(`${schemaDir}/migrations/`) && file.endsWith('.sql'),
  );
  const setupCmds = [
    hasMigrations
      ? [...prisma, 'migrate', 'deploy', ...schemaArgs]
      : [...prisma, 'db', 'push', '--skip-generate', ...schemaArgs],
  ];
  const appPackage = readPackageJson(files, appRoot);
  if (stringField(appPackage?.prisma, 'seed') !== undefined) {
    setupCmds.push([...prisma, 'db', 'seed', ...schemaArgs]);
  }

  switch (provider) {
    case 'postgresql':
    case 'postgres':
      return {
        services: [
          { kind: 'postgres', version: postgresVersion ?? DEFAULT_POSTGRES_VERSION, envVar },
        ],
        env: {},
        setupCmds,
        notes: [],
      };
    case 'sqlite':
      return { services: [], env: { [envVar]: 'file:./bdiff.db' }, setupCmds, notes: [] };
    default:
      throw new BdiffError(
        'SETUP_UNSUPPORTED',
        `Prisma provider "${provider ?? 'unknown'}" is not supported`,
        {
          details: { schema: schemaFile, provider: provider ?? null },
        },
      );
  }
}

function detectDrizzle(
  files: RepoFiles,
  appRoot: string,
  configFile: string,
  exec: string[],
  postgresVersion: string | undefined,
): DatabaseDetection {
  const text = files.read(configFile) ?? '';
  const dialect =
    /dialect\s*:\s*['"](\w+)['"]/.exec(text)?.[1] ??
    (/driver\s*:\s*['"]pg['"]/.test(text) ? 'postgresql' : undefined);
  const envVar = /process\.env\.([A-Z0-9_]+)/.exec(text)?.[1] ?? DEFAULT_DB_ENV;
  const out = /out\s*:\s*['"]([^'"]+)['"]/.exec(text)?.[1] ?? 'drizzle';
  const outDir = path.posix.normalize(inDir(appRoot, out.replace(/^\.\//, '')));
  const hasMigrations = files.list.some(
    (file) => file.startsWith(`${outDir}/`) && file.endsWith('.sql'),
  );
  const setupCmds = [[...exec, 'drizzle-kit', hasMigrations ? 'migrate' : 'push']];

  switch (dialect) {
    case 'postgresql':
    case 'postgres':
      return {
        services: [
          { kind: 'postgres', version: postgresVersion ?? DEFAULT_POSTGRES_VERSION, envVar },
        ],
        env: {},
        setupCmds,
        notes: [],
      };
    case 'sqlite':
      return { services: [], env: { [envVar]: 'file:./bdiff.db' }, setupCmds, notes: [] };
    default:
      throw new BdiffError(
        'SETUP_UNSUPPORTED',
        `Drizzle dialect "${dialect ?? 'unknown'}" is not supported`,
        {
          details: { config: configFile, dialect: dialect ?? null },
        },
      );
  }
}
