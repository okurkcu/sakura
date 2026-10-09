import path from 'node:path';

import type { DatasetTags } from '@bdiff/cli';
import { classifyChange, skipReason } from '@bdiff/core';
import type { ChangedFile } from '@bdiff/core';

import type { RepoSignals } from './schema.js';

/** A page, layout or other UI file of either router, a component, or a stylesheet. */
const UI_PATH =
  /(^|\/)(src\/)?(app|pages)\/.+\.(tsx|jsx|ts|js|mdx|md)$|(^|\/)components?\/|(^|\/)(styles?)\/|\.(css|scss|sass|less)$/;
/** An App Router route handler or a Pages Router API route. */
const API_PATH = /(^|\/)(src\/)?app\/(.+\/)?route\.[cm]?[jt]sx?$|(^|\/)(src\/)?pages\/api\//;
/** Files a dependency-update PR touches. */
const DEPENDENCY_FILES =
  /(^|\/)(package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|bun\.lockb?)$/;
const ENV_EXAMPLE = /(^|\/)\.env\.(example|sample|template|local\.example|dist)$/;
const ENV_SCHEMA = /(^|\/)(src\/)?env\.(m?js|ts)$/;
const COMPOSE = /(^|\/)(docker-)?compose\.ya?ml$/;

/**
 * The PR type from the changed paths: `api` for route handlers and `pages/api`, `ui` for pages,
 * layouts, components and styles, `mixed` for both, `refactor` when no changed path is either
 * (runtime code a route may or may not reach). Pure.
 */
export function classifyPrType(paths: readonly string[]): DatasetTags['prType'] {
  const runtime = paths.filter((file) => classifyChange(file) === 'runtime');
  const api = runtime.some((file) => API_PATH.test(file));
  const ui = runtime.some((file) => !API_PATH.test(file) && UI_PATH.test(file));
  return api && ui ? 'mixed' : api ? 'api' : ui ? 'ui' : 'refactor';
}

/**
 * `agent` when the login is a bot (`…[bot]`) or one of the known coding-agent accounts
 * (`scripts/agent-authors.json`, compared without case), else `human`. Pure.
 */
export function classifyAuthor(
  login: string,
  agentAccounts: readonly string[],
): DatasetTags['author'] {
  const lower = login.toLowerCase();
  return lower.endsWith('[bot]') || agentAccounts.some((agent) => agent.toLowerCase() === lower)
    ? 'agent'
    : 'human';
}

/**
 * `easy` when the app needs no database and either documents its environment (an example env
 * file) or does not seem to need one (no env schema file); otherwise `realistic`. Pure.
 */
export function guessDifficulty(signals: RepoSignals): DatasetTags['difficulty'] {
  return signals.database === 'none' && (signals.envExample || !signals.envSchema)
    ? 'easy'
    : 'realistic';
}

/**
 * Why a PR is no candidate, or undefined: bdiff would skip it (only docs, tests, CI or lockfiles;
 * see the impact stage's skip rules), or it only updates dependencies. Pure.
 */
export function excludeReason(files: readonly ChangedFile[]): string | undefined {
  const skip = skipReason(files);
  if (skip !== undefined) {
    return skip;
  }
  return files.every((file) => DEPENDENCY_FILES.test(file.path)) ? 'dependencies-only' : undefined;
}

/**
 * Setup signals from a repository's file paths and the directory of its Next.js app. Pure.
 */
export function repoSignals(
  paths: readonly string[],
  appRoot: string,
  rootPackageHasWorkspaces: boolean,
): RepoSignals {
  const inApp = (file: string) => appRoot === '.' || file.startsWith(`${appRoot}/`);
  const relative = (file: string) => (appRoot === '.' ? file : file.slice(appRoot.length + 1));
  const appFiles = paths.filter(inApp).map(relative);
  const hasApp = appFiles.some((file) => /^(src\/)?app\//.test(file));
  const hasPages = appFiles.some((file) => /^(src\/)?pages\//.test(file));
  const prisma = paths.some((file) => path.posix.basename(file) === 'schema.prisma');
  const drizzle = paths.some((file) =>
    /^drizzle\.config\.[cm]?[jt]s(on)?$/.test(path.posix.basename(file)),
  );
  return {
    appRoot,
    router: hasApp && hasPages ? 'both' : hasApp ? 'app' : hasPages ? 'pages' : 'unknown',
    database: prisma ? 'prisma' : drizzle ? 'drizzle' : 'none',
    dockerCompose: paths.some((file) => COMPOSE.test(file) && file.split('/').length <= 2),
    envExample: paths.some((file) => ENV_EXAMPLE.test(file)),
    envSchema: appFiles.some((file) => ENV_SCHEMA.test(file)),
    monorepo:
      appRoot !== '.' ||
      rootPackageHasWorkspaces ||
      paths.some(
        (file) => file === 'pnpm-workspace.yaml' || file === 'turbo.json' || file === 'nx.json',
      ),
  };
}
