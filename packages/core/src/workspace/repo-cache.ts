import { randomBytes } from 'node:crypto';
import path from 'node:path';

import type { Git } from './git.js';
import type { FileSystem } from '../adapters/file-system.js';
import type { Logger } from '../adapters/logger.js';
import { BdiffError } from '../errors/bdiff-error.js';
import { artifactFileStem } from '../metrics/artifact-paths.js';

const CLONE_TIMEOUT_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 5 * 60_000;

/** Where a repository comes from and where its cache lives. */
export interface RepoSource {
  /** Normalized identity: the same repository always has the same key. */
  readonly key: string;
  /** What to pass to `git clone`. */
  readonly location: string;
  readonly kind: 'https' | 'local';
  /** Cache directory name: readable slug plus hash of the key. */
  readonly dirName: string;
}

/**
 * Normalizes a repository URL or path. `https` URLs lose case in the host and a trailing `/` or
 * `.git`; local paths become absolute. Other transports (ssh, `git@…`, `file://`, `ext::`) are
 * rejected. Pure.
 *
 * @throws BdiffError `REPO_UNSUPPORTED` for anything but an https URL or a local path.
 */
export function resolveRepoSource(repoUrl: string, cwd: string): RepoSource {
  if (/^https:\/\//i.test(repoUrl)) {
    const url = new URL(repoUrl);
    if (url.username !== '' || url.password !== '') {
      throw new BdiffError('REPO_UNSUPPORTED', 'Repository URLs must not contain credentials');
    }
    const repoPath = url.pathname.replace(/\/+$/, '').replace(/\.git$/i, '');
    const key = `https://${url.host.toLowerCase()}${repoPath}`;
    return { key, location: repoUrl, kind: 'https', dirName: artifactFileStem(key) };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(repoUrl) || /^[^/\\]+@[^/\\]+:/.test(repoUrl)) {
    throw new BdiffError(
      'REPO_UNSUPPORTED',
      `Only https URLs and local paths are supported: ${repoUrl}`,
    );
  }
  const absolute = path.resolve(cwd, repoUrl);
  return { key: absolute, location: absolute, kind: 'local', dirName: artifactFileStem(absolute) };
}

/** Inputs for {@link ensureRepoCache}. */
export interface RepoCacheOptions {
  readonly git: Git;
  readonly fs: FileSystem;
  /** Root of bdiff's cache (`~/.cache/bdiff`). */
  readonly cacheDir: string;
  readonly source: RepoSource;
  readonly logger: Logger;
}

/** A ready, up-to-date bare clone. */
export interface RepoCache {
  readonly path: string;
  /** True when an existing clone was reused (fetched) instead of cloned. */
  readonly hit: boolean;
}

/** Serializes cache work per repository within this process. */
const repoLocks = new Map<string, Promise<unknown>>();

/**
 * Returns a bare clone of the repository under `<cacheDir>/repos/`, fetching all branches and tags
 * if it already exists. A new clone is made in a temp directory and renamed into place, so an
 * interrupted clone never leaves a broken cache; a broken cache is detected, removed and recloned.
 *
 * @throws BdiffError `REPO_UNSUPPORTED` if a local path does not exist, `GIT_FAILED` if git fails.
 */
export function ensureRepoCache(options: RepoCacheOptions): Promise<RepoCache> {
  const dir = path.join(options.cacheDir, 'repos', options.source.dirName);
  const previous = repoLocks.get(dir) ?? Promise.resolve();
  const current = previous.then(
    () => prepare(dir, options),
    () => prepare(dir, options),
  );
  repoLocks.set(
    dir,
    // Later callers only wait for this one to settle; its outcome reaches its own caller.
    current.catch(() => undefined),
  );
  return current;
}

async function prepare(dir: string, options: RepoCacheOptions): Promise<RepoCache> {
  const { git, fs, source, logger } = options;
  if (source.kind === 'local' && !(await fs.exists(source.location))) {
    throw new BdiffError('REPO_UNSUPPORTED', `Local repository not found: ${source.location}`);
  }

  if (await fs.exists(dir)) {
    const check = await git.run(['rev-parse', '--is-bare-repository'], { cwd: dir });
    if (check.exitCode === 0 && check.stdout.trim() === 'true') {
      await git.ok(
        [
          'fetch',
          '--prune',
          '--quiet',
          'origin',
          '+refs/heads/*:refs/heads/*',
          '+refs/tags/*:refs/tags/*',
        ],
        { cwd: dir, timeoutMs: FETCH_TIMEOUT_MS },
      );
      return { path: dir, hit: true };
    }
    logger.warn('repo cache is broken; recloning', { cache: dir });
    await fs.rm(dir);
  }

  const temp = `${dir}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.mkdir(path.dirname(dir));
  try {
    await git.ok(['clone', '--bare', '--quiet', '--', source.location, temp], {
      timeoutMs: CLONE_TIMEOUT_MS,
    });
    await fs.rename(temp, dir);
  } finally {
    await fs.rm(temp);
  }
  return { path: dir, hit: false };
}
