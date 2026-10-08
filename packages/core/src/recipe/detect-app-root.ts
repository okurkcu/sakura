import path from 'node:path';

import { dependsOn, readPackageJson } from './repo-files.js';
import type { RepoFiles } from './repo-files.js';
import { BdiffError } from '../errors/bdiff-error.js';

const MAX_DEPTH = 3;
/** Directories whose Next.js apps are samples, not the product. */
const NON_PRODUCT_DIRS = new Set([
  'examples',
  'example',
  'fixtures',
  'test',
  'tests',
  '__tests__',
  'templates',
  'e2e',
]);
/** Conventional names of a monorepo's main web app. */
const MAIN_APP_NAMES = new Set(['web', 'app', 'site', 'www', 'frontend', 'client', 'dashboard']);

/** The Next.js app of a repository. */
export interface AppRootDetection {
  readonly appRoot: string;
  /** Every directory with a Next.js app, best first. */
  readonly candidates: string[];
  /** True when more than one app ranked equally and the choice was a tie-break. */
  readonly ambiguous: boolean;
  readonly notes: string[];
}

/**
 * Finds the directory of the Next.js app: a `package.json` depending on `next`, at most three
 * levels deep, outside example and test folders. Ranks the root first, then conventionally named
 * monorepo apps (`apps/web`, …), then other `apps/*`, then anything else; apps with an `app/` or
 * `pages/` directory beat those without.
 *
 * @throws BdiffError `SETUP_UNSUPPORTED` when there is no Next.js app.
 */
export function detectAppRoot(files: RepoFiles): AppRootDetection {
  const candidates = files.list
    .filter((file) => path.posix.basename(file) === 'package.json')
    .map((file) => path.posix.dirname(file))
    .filter((dir) => dir === '.' || dir.split('/').length <= MAX_DEPTH)
    .filter((dir) => !dir.split('/').some((segment) => NON_PRODUCT_DIRS.has(segment)))
    .filter((dir) => {
      const pkg = readPackageJson(files, dir);
      return pkg !== undefined && dependsOn(pkg, 'next');
    });
  if (candidates.length === 0) {
    throw new BdiffError(
      'SETUP_UNSUPPORTED',
      'No Next.js app found (no package.json depends on "next")',
    );
  }
  const ranked = [...candidates].sort(
    (a, b) => rank(files, a) - rank(files, b) || a.localeCompare(b),
  );
  const [best = '.', second] = ranked;
  const ambiguous = second !== undefined && rank(files, best) === rank(files, second);
  const notes =
    ranked.length > 1 ? [`several Next.js apps (${ranked.join(', ')}); using ${best}`] : [];
  return { appRoot: best, candidates: ranked, ambiguous, notes };
}

function rank(files: RepoFiles, dir: string): number {
  const segments = dir.split('/');
  const location =
    dir === '.'
      ? 0
      : segments[0] === 'apps' && segments.length === 2
        ? MAIN_APP_NAMES.has(segments[1] ?? '')
          ? 1
          : 2
        : 3;
  const prefix = dir === '.' ? '' : `${dir}/`;
  const hasRoutes = files.list.some((file) =>
    ['app/', 'pages/', 'src/app/', 'src/pages/'].some((routes) => file.startsWith(prefix + routes)),
  );
  return location * 2 + (hasRoutes ? 0 : 1);
}
