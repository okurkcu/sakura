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

/** Reads from the GitHub REST API. */
export interface GitHubClient {
  /**
   * @throws BdiffError `HTTP_FAILED` (with `details.status` when GitHub answered), or the abort
   *   error of `signal`.
   */
  getPullRequest(
    repo: GitHubRepo,
    number: number,
    options: { readonly timeoutMs: number; readonly signal: AbortSignal },
  ): Promise<PullRequestText>;
}

/** Options of {@link createGitHubClient}. */
export interface GitHubClientOptions {
  /** `GITHUB_TOKEN`; optional for public repositories. Sent only to `baseUrl`, never logged. */
  readonly token?: string;
  /** Default `https://api.github.com`; tests point it at a local server. */
  readonly baseUrl?: string;
}

const PullRequestSchema = z.object({ title: z.string(), body: z.string().nullable() });

/** The real {@link GitHubClient}, over `fetch`. */
export function createGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  const baseUrl = options.baseUrl ?? 'https://api.github.com';
  return {
    getPullRequest: async (repo, number, { timeoutMs, signal }) => {
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
        throw new BdiffError(
          'HTTP_FAILED',
          `GitHub request for pull request #${String(number)} failed`,
          {
            cause: error,
            details: { timedOut: timeout.aborted },
          },
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new BdiffError(
          'HTTP_FAILED',
          `GitHub answered ${String(response.status)} for pull request #${String(number)}`,
          {
            details: { status: response.status },
          },
        );
      }
      const parsed = PullRequestSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new BdiffError('HTTP_FAILED', 'Unexpected GitHub pull request response', {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      return { title: parsed.data.title, body: parsed.data.body ?? '' };
    },
  };
}

/** `{ owner, name }` of a `https://github.com/<owner>/<name>(.git)` URL, else `undefined`. Pure. */
export function parseGitHubRepo(repoUrl: string): GitHubRepo | undefined {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repoUrl);
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { owner: match[1], name: match[2] };
}
