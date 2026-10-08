import path from 'node:path';

import type { ChangedFile } from '../domain/workspace.js';

/** What kind of file a change touches, for deciding whether a PR can change behavior. */
export type ChangeKind = 'docs' | 'tests' | 'ci' | 'lockfile' | 'runtime';

const LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'bun.lock',
  'bun.lockb',
]);
const DOC_NAMES =
  /^(readme|changelog|contributing|license|licence|code_of_conduct|security|authors)(\.[a-z]+)?$/i;
/** Directories whose `.md`/`.mdx` files are routes, not documentation. */
const ROUTE_DIRS = /(^|\/)(app|pages)\//;

/**
 * Classifies a changed path. Documentation is Markdown outside route directories, anything under
 * `docs/`, and well-known repo meta files (README, LICENSE, …). Pure.
 */
export function classifyChange(file: string): ChangeKind {
  const name = path.posix.basename(file);
  const segments = file.split('/');
  if (LOCKFILES.has(name)) {
    return 'lockfile';
  }
  if (
    segments[0] === '.github' ||
    ['.gitlab-ci.yml', '.travis.yml', 'azure-pipelines.yml'].includes(file) ||
    segments[0] === '.circleci'
  ) {
    return segments[0] === '.github' && /\.(md|mdx)$/i.test(name) ? 'docs' : 'ci';
  }
  const testDir = segments.some((segment) =>
    ['__tests__', '__mocks__', 'e2e', 'cypress', 'playwright', 'test', 'tests'].includes(segment),
  );
  // Inside app/ or pages/ a folder named `test` is a route, so only test file names count there.
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name) || (testDir && !ROUTE_DIRS.test(file))) {
    return 'tests';
  }
  if (
    segments[0] === 'docs' ||
    DOC_NAMES.test(name) ||
    (/\.(md|mdx|markdown|txt)$/i.test(name) && !ROUTE_DIRS.test(file))
  ) {
    return 'docs';
  }
  return 'runtime';
}

/**
 * The reason to skip a run when no changed file can affect behavior, or undefined. A single kind
 * gives `<kind>-only` (`docs-only`, `tests-only`, `ci-only`, `lockfile-only`); a mix gives
 * `non-runtime-only`. Deleted and renamed files count by their paths on both sides. Pure.
 */
export function skipReason(changedFiles: readonly ChangedFile[]): string | undefined {
  if (changedFiles.length === 0) {
    return 'no-changes';
  }
  const kinds = new Set(
    changedFiles
      .flatMap((file) => [file.path, ...(file.status === 'renamed' ? [file.oldPath] : [])])
      .map(classifyChange),
  );
  if (kinds.has('runtime')) {
    return undefined;
  }
  const [only] = kinds;
  return kinds.size === 1 && only !== undefined ? `${only}-only` : 'non-runtime-only';
}
