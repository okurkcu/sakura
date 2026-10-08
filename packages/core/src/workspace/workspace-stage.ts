import path from 'node:path';

import { createGit } from './git.js';
import type { Git } from './git.js';
import { parseNameStatusZ } from './name-status.js';
import { ensureRepoCache, resolveRepoSource } from './repo-cache.js';
import type { Exec } from '../adapters/exec.js';
import type { FileSystem } from '../adapters/file-system.js';
import type { Side } from '../domain/stage.js';
import type { Target } from '../domain/target.js';
import type { Workspace } from '../domain/workspace.js';
import { BdiffError } from '../errors/bdiff-error.js';
import type { Stage, StageContext } from '../pipeline/stage.js';

const FETCH_PR_TIMEOUT_MS = 5 * 60_000;

/** Dependencies of the workspace stage. */
export interface WorkspaceStageDeps {
  readonly exec: Exec;
  readonly fs: FileSystem;
  /** Root of bdiff's cache (`~/.cache/bdiff`); clones live in `repos/` under it. */
  readonly cacheDir: string;
  /** Base for relative local repository paths. */
  readonly cwd: string;
}

/**
 * The workspace stage: puts the base and head source trees on disk and lists what changed.
 *
 * - Clones the repository once into the cache (bare) and only fetches on later runs.
 * - Resolves base to the merge-base of base and head, like a pull request diff.
 * - Falls back to GitHub's `refs/pull/<n>/head` when the head ref is not in the repository (fork PRs).
 * - Checks both sides out as detached worktrees under the run directory and registers their removal
 *   as cleanup hooks.
 * - Lists changed files between merge-base and head, with rename detection.
 */
export function createWorkspaceStage(deps: WorkspaceStageDeps): Stage<Target, Workspace> {
  return {
    name: 'workspace',
    run: async (target, ctx) => {
      const git = createGit(deps.exec, ctx.signal);
      const source = resolveRepoSource(target.repoUrl, deps.cwd);
      const cache = await ensureRepoCache({
        git,
        fs: deps.fs,
        cacheDir: deps.cacheDir,
        source,
        logger: ctx.logger,
      });
      ctx.logger.info(cache.hit ? 'repo cache hit' : 'repo cloned', { cache: cache.path });

      const headSha = await resolveHead(git, cache.path, target);
      const tipSha = await resolveCommit(git, cache.path, target.baseRef);
      if (tipSha === undefined) {
        throw refNotFound(target.baseRef, 'base');
      }
      const mergeBase = await git.run(['merge-base', tipSha, headSha], { cwd: cache.path });
      if (mergeBase.exitCode !== 0) {
        throw new BdiffError(
          'NO_MERGE_BASE',
          `${target.baseRef} and ${target.headRef} share no history`,
          {
            details: { baseSha: tipSha, headSha },
          },
        );
      }
      const baseSha = mergeBase.stdout.trim();

      const basePath = await addWorktree(deps, git, cache.path, ctx, 'base', baseSha);
      const headPath = await addWorktree(deps, git, cache.path, ctx, 'head', headSha);

      const diff = await git.ok(['diff', '--name-status', '-M', '-z', baseSha, headSha], {
        cwd: cache.path,
      });
      const changedFiles = parseNameStatusZ(diff);
      ctx.logger.info('workspace ready', { baseSha, headSha, changedFiles: changedFiles.length });
      return { basePath, headPath, baseSha, headSha, changedFiles };
    },
  };
}

async function resolveHead(git: Git, repo: string, target: Target): Promise<string> {
  const direct = await resolveCommit(git, repo, target.headRef);
  if (direct !== undefined) {
    return direct;
  }
  if (target.prNumber !== undefined) {
    const prRef = `refs/bdiff/pull/${String(target.prNumber)}`;
    const fetched = await git.run(
      ['fetch', '--quiet', 'origin', `+refs/pull/${String(target.prNumber)}/head:${prRef}`],
      { cwd: repo, timeoutMs: FETCH_PR_TIMEOUT_MS },
    );
    if (fetched.exitCode === 0) {
      const sha = await resolveCommit(git, repo, prRef);
      if (sha !== undefined) {
        return sha;
      }
    }
  }
  throw refNotFound(target.headRef, 'head');
}

/** SHA of the commit `ref` points to, or undefined if it doesn't resolve to a commit. */
async function resolveCommit(git: Git, repo: string, ref: string): Promise<string | undefined> {
  const result = await git.run(
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
    {
      cwd: repo,
    },
  );
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

/**
 * Checks `sha` out as a detached worktree for `side` and registers its removal. The hook is
 * registered before `worktree add`, so a half-created worktree is removed too. It gets a git bound
 * to the cleanup signal, because the run's own signal may already be aborted.
 */
async function addWorktree(
  deps: WorkspaceStageDeps,
  git: Git,
  repo: string,
  ctx: StageContext,
  side: Side,
  sha: string,
): Promise<string> {
  const worktree = ctx.paths.worktree(side);
  await deps.fs.mkdir(path.dirname(worktree));
  ctx.onCleanup(`worktree ${side}`, async (signal) => {
    const cleanupGit = createGit(deps.exec, signal);
    await cleanupGit.run(['worktree', 'remove', '--force', worktree], { cwd: repo });
    await deps.fs.rm(worktree);
    const parent = path.dirname(worktree);
    if ((await deps.fs.exists(parent)) && (await deps.fs.readdir(parent)).length === 0) {
      await deps.fs.rm(parent);
    }
    await cleanupGit.ok(['worktree', 'prune'], { cwd: repo });
  });
  await git.ok(['worktree', 'add', '--detach', '--quiet', worktree, sha], { cwd: repo });
  return worktree;
}

function refNotFound(ref: string, side: Side): BdiffError {
  return new BdiffError('REF_NOT_FOUND', `${side} ref not found: ${ref}`, {
    details: { ref, side },
  });
}
