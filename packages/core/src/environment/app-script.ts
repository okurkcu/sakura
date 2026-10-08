import path from 'node:path';

import type { Recipe } from '../domain/recipe.js';

/** Directory the source tree is copied to inside each app container. */
export const CONTAINER_SOURCE_DIR = '/app';

/** Exit codes of the app script, one per setup phase, so a failure maps to its phase. */
export const SETUP_EXIT_CODES = {
  toolchain: 100,
  install: 101,
  db: 102,
  build: 103,
} as const;

/** Prefix of the marker line the script prints when it enters a phase. */
export const PHASE_MARKER = '@@bdiff phase ';

/**
 * Quotes one argument for POSIX `sh`: wrapped in single quotes, embedded single quotes escaped.
 * Nothing inside is expanded or interpreted. Pure.
 */
export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'"'"'`)}'`;
}

function command(argv: readonly string[]): string {
  return argv.map(shellQuote).join(' ');
}

/**
 * The shell script each app container runs: prepare the package manager, install, set up the
 * database, build, then `exec` the start command. Every recipe argument is quoted, so recipe
 * values are never interpreted by the shell. A failing phase exits with its {@link SETUP_EXIT_CODES}
 * code; once started, the container lives as long as the app. Runs only inside the container. Pure.
 */
export function buildAppScript(recipe: Recipe): string {
  const installDir = path.posix.join(CONTAINER_SOURCE_DIR, recipe.installRoot);
  const appDir = path.posix.join(CONTAINER_SOURCE_DIR, recipe.appRoot);
  const phase = (name: string) => `echo ${shellQuote(`${PHASE_MARKER}${name}`)}`;
  const lines = [
    'set -u',
    `cd ${shellQuote(installDir)} || exit ${String(SETUP_EXIT_CODES.toolchain)}`,
    phase('toolchain'),
    `corepack --version >/dev/null 2>&1 || npm install --global corepack >/dev/null 2>&1 || exit ${String(SETUP_EXIT_CODES.toolchain)}`,
    `corepack enable || exit ${String(SETUP_EXIT_CODES.toolchain)}`,
  ];
  if (recipe.packageManager.name === 'pnpm') {
    // pnpm 10+ skips dependency build scripts (prisma, esbuild, sharp) unless approved. The
    // container is disposable and isolated, so allow them all, as the repo's developers do.
    lines.push(
      'pnpm config set --location=global dangerously-allow-all-builds true >/dev/null 2>&1 || true',
    );
  }
  lines.push(
    phase('install'),
    `${command(recipe.installCmd)} || exit ${String(SETUP_EXIT_CODES.install)}`,
    `cd ${shellQuote(appDir)} || exit ${String(SETUP_EXIT_CODES.install)}`,
  );
  if (recipe.dbSetupCmds.length > 0) {
    lines.push(
      phase('db'),
      ...recipe.dbSetupCmds.map((cmd) => `${command(cmd)} || exit ${String(SETUP_EXIT_CODES.db)}`),
    );
  }
  lines.push(
    phase('build'),
    `${command(recipe.buildCmd)} || exit ${String(SETUP_EXIT_CODES.build)}`,
    phase('start'),
    `exec ${command(recipe.startCmd)}`,
  );
  return `${lines.join('\n')}\n`;
}
