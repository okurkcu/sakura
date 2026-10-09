import { z } from 'zod';

import { abortError } from '../errors/abort.js';
import { BdiffError } from '../errors/bdiff-error.js';

/** A GitHub repository, from its URL. */
export interface GitHubRepo {
  readonly owner: string;
  readonly name: string;
}

/** The text a pull request author wrote. */
export interface PullRequestText {
  readonly title: string;
  readonly body: string;
}

/** A pull request as `bdiff run <pr-url>` needs it: where its base and head are. */
export interface PullRequest extends PullRequestText {
  readonly state: 'open' | 'closed';
  readonly merged: boolean;
  /** The base branch, the commit the PR was last compared with, and the base repository. */
  readonly base: { readonly ref: string; readonly sha: string; readonly repo: string };
  /** The head branch and commit, and its repository (`null` when a fork was deleted). */
  readonly head: { readonly ref: string; readonly sha: string; readonly repo: string | null };
}

/** Options of every GitHub read. */
export interface GitHubReadOptions {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/** Reads from the GitHub REST API. */
export interface GitHubClient {
  /**
   * The title and body of a pull request.
   *
   * @throws BdiffError `PR_NOT_FOUND` (missing or private), `HTTP_FAILED` (with `details.status`
   *   when GitHub answered, `details.rateLimited` when rate limited), or the abort error of
   *   `signal`.
   */
  getPullRequest(
    repo: GitHubRepo,
    number: number,
    options: GitHubReadOptions,
  ): Promise<PullRequestText>;
}

/** Resolves a pull request's base and head, for running it by URL. */
export interface PullRequestSource {
  /** @throws BdiffError as {@link GitHubClient.getPullRequest}. */
  resolvePullRequest(
    repo: GitHubRepo,
    number: number,
    options: GitHubReadOptions,
  ): Promise<PullRequest>;
}

/** Options of {@link createGitHubClient}. */
export interface GitHubClientOptions {
  /** `GITHUB_TOKEN`; optional for public repositories. Sent only to `baseUrl`, never logged. */
  readonly token?: string;
  /** Default `https://api.github.com`; tests point it at a local server. */
  readonly baseUrl?: string;
}

const PullRequestSchema = z.object({
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  merged_at: z.string().nullable(),
  base: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ full_name: z.string() }) }),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
});

/** The real {@link GitHubClient} and {@link PullRequestSource}, over `fetch`. */
export function createGitHubClient(
  options: GitHubClientOptions = {},
): GitHubClient & PullRequestSource {
  const baseUrl = options.baseUrl ?? 'https://api.github.com';
  const resolvePullRequest = async (
    repo: GitHubRepo,
    number: number,
    { timeoutMs, signal }: GitHubReadOptions,
  ): Promise<PullRequest> => {
    const what = `pull request ${repo.owner}/${repo.name}#${String(number)}`;
    const url = `${baseUrl}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/pulls/${String(number)}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'bdiff',
          'x-github-api-version': '2022-11-28',
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
        },
        redirect: 'error',
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch (error) {
      if (signal.aborted) {
        throw abortError(signal);
      }
      throw new BdiffError('HTTP_FAILED', `GitHub request for ${what} failed`, {
        cause: error,
        details: { timedOut: timeout.aborted },
      });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw responseError(response, what);
    }
    const parsed = PullRequestSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new BdiffError('HTTP_FAILED', `Unexpected GitHub response for ${what}`, {
        details: { issues: parsed.error.issues.map((issue) => issue.message) },
      });
    }
    const pr = parsed.data;
    return {
      title: pr.title,
      body: pr.body ?? '',
      state: pr.state,
      merged: pr.merged_at !== null,
      base: { ref: pr.base.ref, sha: pr.base.sha, repo: pr.base.repo.full_name },
      head: { ref: pr.head.ref, sha: pr.head.sha, repo: pr.head.repo?.full_name ?? null },
    };
  };
  return {
    resolvePullRequest,
    getPullRequest: async (repo, number, readOptions) => {
      const { title, body } = await resolvePullRequest(repo, number, readOptions);
      return { title, body };
    },
  };
}

/**
 * The error for a non-2xx answer: `PR_NOT_FOUND` for 404 (GitHub also answers 404 for a private
 * repository), a rate limit (429, or 403 with no requests left) as `HTTP_FAILED` that suggests
 * `GITHUB_TOKEN`, any other status as `HTTP_FAILED`. Pure.
 */
function responseError(response: Response, what: string): BdiffError {
  const { status } = response;
  if (status === 404) {
    return new BdiffError('PR_NOT_FOUND', `GitHub has no ${what}, or it is private`, {
      details: { status },
    });
  }
  if (status === 429 || (status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
    return new BdiffError(
      'HTTP_FAILED',
      `GitHub rate limit reached while reading ${what}; set GITHUB_TOKEN to raise the limit`,
      { details: { status, rateLimited: true } },
    );
  }
  return new BdiffError('HTTP_FAILED', `GitHub answered ${String(status)} for ${what}`, {
    details: { status },
  });
}

/** `{ owner, name }` of a `https://github.com/<owner>/<name>(.git)` URL, else `undefined`. Pure. */
export function parseGitHubRepo(repoUrl: string): GitHubRepo | undefined {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repoUrl);
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { owner: match[1], name: match[2] };
}
