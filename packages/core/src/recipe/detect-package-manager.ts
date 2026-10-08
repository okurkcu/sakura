import { inDir, readPackageJson, stringField } from './repo-files.js';
import type { RepoFiles } from './repo-files.js';
import type { PackageManagerName } from '../domain/recipe.js';

/** Lockfiles in priority order: when several exist, the first one wins. */
const LOCKFILES: readonly (readonly [string, PackageManagerName])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

/** The package manager of a project and how to install its dependencies. */
export interface PackageManagerDetection {
  readonly name: PackageManagerName;
  readonly version?: string;
  readonly lockfile?: string;
  readonly installCmd: string[];
  readonly notes: string[];
}

/**
 * Detects the package manager of the project rooted at `installRoot`: the `packageManager` field
 * wins, then the lockfile; without either, npm. Installs are frozen whenever there is a lockfile.
 */
export function detectPackageManager(
  files: RepoFiles,
  installRoot: string,
): PackageManagerDetection {
  const notes: string[] = [];
  const declared = /^(npm|pnpm|yarn|bun)@(\d[^+\s]*)/.exec(
    stringField(readPackageJson(files, installRoot), 'packageManager') ?? '',
  );
  const present = LOCKFILES.filter(([file]) => files.has(inDir(installRoot, file)));
  if (new Set(present.map(([, name]) => name)).size > 1) {
    notes.push(`several lockfiles found (${present.map(([file]) => file).join(', ')})`);
  }

  const name = (declared?.[1] as PackageManagerName | undefined) ?? present[0]?.[1] ?? 'npm';
  const version = declared?.[2];
  const lockfile = present.find(([, candidate]) => candidate === name)?.[0];
  if (lockfile === undefined) {
    notes.push('no lockfile: dependency versions may differ between base and head');
  }
  const isYarnBerry =
    name === 'yarn' &&
    (files.has(inDir(installRoot, '.yarnrc.yml')) || Number(version?.split('.')[0] ?? '1') >= 2);

  return {
    name,
    ...(version === undefined ? {} : { version }),
    ...(lockfile === undefined ? {} : { lockfile }),
    installCmd: installCommand(name, lockfile !== undefined, isYarnBerry),
    notes,
  };
}

function installCommand(name: PackageManagerName, frozen: boolean, yarnBerry: boolean): string[] {
  switch (name) {
    case 'pnpm':
      return frozen ? ['pnpm', 'install', '--frozen-lockfile'] : ['pnpm', 'install'];
    case 'yarn':
      if (!frozen) {
        return ['yarn', 'install'];
      }
      return yarnBerry
        ? ['yarn', 'install', '--immutable']
        : ['yarn', 'install', '--frozen-lockfile'];
    case 'bun':
      return frozen ? ['bun', 'install', '--frozen-lockfile'] : ['bun', 'install'];
    case 'npm':
      return frozen ? ['npm', 'ci'] : ['npm', 'install'];
  }
}

/** argv prefix that runs a package binary (e.g. `next`) with the given package manager. */
export function execPrefix(name: PackageManagerName): string[] {
  switch (name) {
    case 'pnpm':
      return ['pnpm', 'exec'];
    case 'yarn':
      return ['yarn'];
    case 'bun':
      return ['bun', 'x'];
    case 'npm':
      return ['npm', 'exec', '--'];
  }
}

/** argv that runs a package.json script with the given package manager. */
export function runScript(name: PackageManagerName, script: string): string[] {
  return [name, 'run', script];
}
