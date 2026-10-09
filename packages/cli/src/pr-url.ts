import type { PullRequest, PullRequestSource, Target } from '@bdiff/core';

/** A pull request named by its GitHub URL. */
export interface PullRequestRef {
  readonly owner: string;
  readonly name: string;
  readonly number: number;
}

const PR_URL =
  /^https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([\w.-]{1,100})\/pull\/([1-9]\d{0,9})(?:\/(?:files|commits|checks))?\/?(?:[?#].*)?$/;

/**
 * Parses `https://github.com/<owner>/<repo>/pull/<n>`, also with `/files`, `/commits` or
 * `/checks`, a trailing slash, a query string or a fragment. Undefined for anything else. Pure.
 */
export function parsePullRequestUrl(url: string): PullRequestRef | undefined {
  const match = PR_URL.exec(url.trim());
  if (match === null) {
    return undefined;
  }
  const [, owner = '', name = '', number = ''] = match;
  return name === '.' || name === '..' ? undefined : { owner, name, number: Number(number) };
}

/**
 * The run target of a resolved pull request. The repository is the PR's base repository (also for
 * a fork PR), and the PR's title and body come along for the interpretation. Refs:
 * - base: the base branch while the PR is open; once it is closed or merged, the commit it was last
 *   compared with, because the branch may already contain the PR's changes (an empty diff);
 * - head: the head branch for an open PR from the base repository; otherwise the head commit, since
 *   a fork's branch name can match another branch of the base repository, and a closed PR's branch
 *   may be gone. The workspace stage fetches a commit missing from the base repository through
 *   `refs/pull/<n>/head`.
 *
 * Pure.
 */
export function pullRequestTarget(ref: PullRequestRef, pr: PullRequest): Target {
  const open = pr.state === 'open';
  const fromBaseRepo = pr.head.repo?.toLowerCase() === pr.base.repo.toLowerCase();
  return {
    repoUrl: `https://github.com/${pr.base.repo}`,
    baseRef: open ? pr.base.ref : pr.base.sha,
    headRef: open && fromBaseRepo ? pr.head.ref : pr.head.sha,
    prNumber: ref.number,
    prTitle: pr.title,
    prBody: pr.body,
  };
}

/** Time GitHub has to describe a pull request. */
export const PULL_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Resolves a pull request on GitHub into a run target (see {@link pullRequestTarget}).
 *
 * @throws BdiffError `PR_NOT_FOUND`, `HTTP_FAILED` (a rate limit suggests `GITHUB_TOKEN`), or the
 *   abort error of `signal`.
 */
export async function resolvePullRequestTarget(
  ref: PullRequestRef,
  source: PullRequestSource,
  signal: AbortSignal,
): Promise<Target> {
  const pr = await source.resolvePullRequest(ref, ref.number, {
    timeoutMs: PULL_REQUEST_TIMEOUT_MS,
    signal,
  });
  return pullRequestTarget(ref, pr);
}

/**
 * The target recorded for a pull request GitHub could not resolve: its repository and number, with
 * the refs GitHub would have given (`HEAD`, `refs/pull/<n>/head`). Pure.
 */
export function unresolvedPullRequestTarget(ref: PullRequestRef): Target {
  return {
    repoUrl: `https://github.com/${ref.owner}/${ref.name}`,
    baseRef: 'HEAD',
    headRef: `refs/pull/${String(ref.number)}/head`,
    prNumber: ref.number,
  };
}
