import path from 'node:path';

import type { PackageManagerName, Recipe } from '../../domain/recipe.js';
import { inDir, readPackageJson } from '../repo-files.js';
import type { RepoFiles } from '../repo-files.js';

/** Package binaries a command may run through the package manager's exec form or `npx`. */
export const ALLOWED_BINARIES: ReadonlySet<string> = new Set(['next', 'prisma', 'drizzle-kit']);

/** Install subcommands of each package manager. */
const INSTALL_SUBCOMMANDS: Readonly<Record<PackageManagerName, readonly string[]>> = {
  npm: ['install', 'i', 'ci'],
  pnpm: ['install', 'i'],
  yarn: ['install'],
  bun: ['install', 'i'],
};

/** Subcommand that runs a package binary, when the package manager has one. */
const EXEC_SUBCOMMANDS: Readonly<Record<PackageManagerName, readonly string[]>> = {
  npm: ['exec'],
  pnpm: ['exec'],
  yarn: ['exec'],
  bun: ['x'],
};

/** Where and with what a command runs. */
export interface CommandContext {
  /** The recipe's package manager: the only one a command may call. */
  readonly packageManager: PackageManagerName;
  /** Directory the command runs in, relative to the repository root (`.` is the root). */
  readonly cwd: string;
  readonly files: RepoFiles;
}

/**
 * Checks one command against the repair loop's allowlist and returns why it is not allowed, or
 * `undefined` when it is. Allowed:
 * - the recipe's package manager installing (`pnpm install`, `npm ci`, plain `yarn`),
 * - running a script defined in the `package.json` of `cwd` (`npm run build`, `yarn build`),
 * - running `next`, `prisma` or `drizzle-kit` through it (`pnpm exec next start`, `npm exec --
 *   prisma …`, `yarn next build`, `bun x drizzle-kit …`) or `npx`,
 * - `node <file>` for a file of the repository, relative to `cwd`.
 *
 * Commands are argv arrays run without a shell, inside the app container. Pure.
 */
export function commandProblem(
  argv: readonly string[],
  context: CommandContext,
): string | undefined {
  const [command, ...args] = argv;
  const shown = `"${argv.join(' ')}"`;
  if (command === 'node') {
    return nodeProblem(args[0], context, shown);
  }
  if (command === 'npx') {
    return args[0] !== undefined && ALLOWED_BINARIES.has(args[0])
      ? undefined
      : `${shown}: npx may only run ${[...ALLOWED_BINARIES].join(', ')}`;
  }
  const pm = context.packageManager;
  if (command !== pm) {
    return `${shown}: only ${pm} (the recipe's package manager), npx and node <file> may run`;
  }
  const [sub, ...rest] = args;
  if (sub === undefined) {
    return pm === 'yarn' ? undefined : `${shown}: a subcommand is required`;
  }
  if (INSTALL_SUBCOMMANDS[pm].includes(sub)) {
    return undefined;
  }
  const scripts = scriptNames(context);
  if (sub === 'run' || (pm === 'npm' && sub === 'run-script')) {
    const script = rest[0];
    return script !== undefined && scripts.has(script)
      ? undefined
      : `${shown}: script "${script ?? ''}" is not defined in ${inDir(context.cwd, 'package.json')}`;
  }
  if (EXEC_SUBCOMMANDS[pm].includes(sub)) {
    const binary = rest[0] === '--' ? rest[1] : rest[0];
    return binary !== undefined && ALLOWED_BINARIES.has(binary)
      ? undefined
      : `${shown}: ${pm} ${sub} may only run ${[...ALLOWED_BINARIES].join(', ')}`;
  }
  // pnpm, yarn and bun run a script (or, pnpm and yarn, a binary) named as the subcommand.
  if (pm !== 'npm' && scripts.has(sub)) {
    return undefined;
  }
  if ((pm === 'pnpm' || pm === 'yarn') && ALLOWED_BINARIES.has(sub)) {
    return undefined;
  }
  return `${shown}: "${pm} ${sub}" is not an allowed command`;
}

/** Every command of a recipe that breaks the allowlist, explained. Pure. */
export function recipeCommandProblems(recipe: Recipe, files: RepoFiles): string[] {
  const at = (cwd: string): CommandContext => ({
    packageManager: recipe.packageManager.name,
    cwd,
    files,
  });
  return [
    commandProblem(recipe.installCmd, at(recipe.installRoot)),
    ...recipe.dbSetupCmds.map((cmd) => commandProblem(cmd, at(recipe.appRoot))),
    commandProblem(recipe.buildCmd, at(recipe.appRoot)),
    commandProblem(recipe.startCmd, at(recipe.appRoot)),
  ].filter((problem) => problem !== undefined);
}

function nodeProblem(
  file: string | undefined,
  { cwd, files }: CommandContext,
  shown: string,
): string | undefined {
  if (file === undefined || file.startsWith('-') || path.posix.isAbsolute(file)) {
    return `${shown}: node may only run a file of the repository (node <file>)`;
  }
  const resolved = path.posix.normalize(path.posix.join(cwd, file));
  if (resolved === '..' || resolved.startsWith('../')) {
    return `${shown}: ${file} is outside the repository`;
  }
  return files.has(resolved) ? undefined : `${shown}: ${resolved} does not exist`;
}

function scriptNames({ cwd, files }: CommandContext): ReadonlySet<string> {
  const scripts = readPackageJson(files, cwd)?.scripts;
  return new Set(
    typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts)
      ? Object.keys(scripts)
      : [],
  );
}
