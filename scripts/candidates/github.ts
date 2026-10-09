import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

import { BdiffError } from '@bdiff/core';
import type { ChangedFile, Clock, FileSystem, Logger } from '@bdiff/core';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { Octokit } from '@octokit/rest';
import { z } from 'zod';

/** A repository as the candidate finder uses it. */
export interface GitHubRepo {
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  readonly cloneUrl: string;
  readonly stars: number;
  readonly pushedAt: string;
  readonly archived: boolean;
  readonly hasLicense: boolean;
  readonly defaultBranch: string;
}

/** A closed pull request. */
export interface GitHubPull {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: string;
  readonly mergedAt: string | null;
  readonly baseSha: string;
  readonly headSha: string;
}

/** The GitHub reads the candidate finder needs. Every response is validated. */
export interface GitHubApi {
  /** One page (100) of a repository search, most stars first. */
  searchRepositories(query: string, page: number): Promise<GitHubRepo[]>;
  /** Every file path at `ref`; `truncated` when GitHub cut the tree (huge repositories). */
  repoPaths(repo: GitHubRepo, ref: string): Promise<{ paths: string[]; truncated: boolean }>;
  /** A file's text at `ref`, or undefined when it does not exist. */
  fileText(repo: GitHubRepo, file: string, ref: string): Promise<string | undefined>;
  /** One page (100) of closed PRs, most recently updated first. */
  closedPulls(repo: GitHubRepo, page: number): Promise<GitHubPull[]>;
  /** A PR's changed files, or undefined when it changes more than `max`. */
  pullFiles(repo: GitHubRepo, pull: number, max: number): Promise<ChangedFile[] | undefined>;
}

const RepoSchema = z.object({
  full_name: z.string(),
  name: z.string(),
  owner: z.object({ login: z.string() }),
  clone_url: z.url(),
  stargazers_count: z.number().int(),
  pushed_at: z.string(),
  archived: z.boolean(),
  license: z.object({ key: z.string() }).nullable(),
  default_branch: z.string(),
});
const SearchSchema = z.object({ items: z.array(RepoSchema) });
const TreeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), type: z.string() })),
});
const PullSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  html_url: z.url(),
  user: z.object({ login: z.string() }).nullable(),
  merged_at: z.string().nullable(),
  base: z.object({ sha: z.string() }),
  head: z.object({ sha: z.string() }),
});
const FileSchema = z.object({
  filename: z.string(),
  status: z.string(),
  previous_filename: z.string().optional(),
});

/** How long a cached GitHub response is reused. */
export const GITHUB_CACHE_TTL_MS = 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** Options of {@link createGitHubApi}. */
export interface GitHubApiOptions {
  /** `GITHUB_TOKEN`; never logged or cached. */
  readonly token: string;
  /** Responses are cached here, one JSON file per request. */
  readonly cacheDir: string;
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly logger: Logger;
  /** For tests: the transport Octokit uses. */
  readonly fetch?: typeof fetch;
}

/**
 * {@link GitHubApi} over Octokit. Rate limits are respected (the throttling plugin waits and
 * retries up to 3 times, also for secondary limits; the retry plugin retries server errors), every
 * request has a 30 s timeout, and successful GET responses are cached on disk for
 * {@link GITHUB_CACHE_TTL_MS}, so running the finder again costs no requests.
 */
export function createGitHubApi(options: GitHubApiOptions): GitHubApi {
  const { fs, clock, logger } = options;
  const GitHub = Octokit.plugin(throttling, retry);
  const octokit = new GitHub({
    auth: options.token,
    userAgent: 'bdiff-candidates',
    ...(options.fetch === undefined ? {} : { request: { fetch: options.fetch } }),
    throttle: {
      onRateLimit: (
        retryAfter: number,
        request: { url: string },
        _octokit: unknown,
        retries: number,
      ) => {
        logger.warn('github rate limit; waiting', { retryAfter, url: request.url, retries });
        return retries < 3;
      },
      onSecondaryRateLimit: (
        retryAfter: number,
        request: { url: string },
        _octokit: unknown,
        retries: number,
      ) => {
        logger.warn('github secondary rate limit; waiting', {
          retryAfter,
          url: request.url,
          retries,
        });
        return retries < 3;
      },
    },
  });

  octokit.hook.wrap('request', async (request, endpoint) => {
    const { method, url, headers } = octokit.request.endpoint(endpoint);
    if (method !== 'GET') {
      return request(endpoint);
    }
    const key = createHash('sha256').update(`${url}\n${headers.accept}`).digest('hex');
    const file = path.join(options.cacheDir, `${key}.json`);
    const cached = await readCache(fs, file);
    if (cached !== undefined && clock.now().getTime() - cached.savedAt < GITHUB_CACHE_TTL_MS) {
      return { status: 200, url, headers: {}, data: cached.data };
    }
    const response = await request({
      ...endpoint,
      request: { ...endpoint.request, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    });
    await writeCache(fs, file, { savedAt: clock.now().getTime(), data: response.data });
    return response;
  });

  const parse = <T>(schema: z.ZodType<T>, data: unknown, what: string): T => {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new BdiffError('HTTP_FAILED', `Unexpected GitHub response for ${what}`, {
        details: { what, problem: parsed.error.message.slice(0, 2_000) },
      });
    }
    return parsed.data;
  };

  return {
    searchRepositories: async (query, page) => {
      const response = await octokit.rest.search.repos({
        q: query,
        sort: 'stars',
        order: 'desc',
        per_page: 100,
        page,
      });
      return parse(SearchSchema, response.data, `search ${query}`).items.map(toRepo);
    },
    repoPaths: async (repo, ref) => {
      const response = await octokit.rest.git.getTree({
        owner: repo.owner,
        repo: repo.name,
        tree_sha: ref,
        recursive: 'true',
      });
      const tree = parse(TreeSchema, response.data, `${repo.fullName} tree`);
      return {
        paths: tree.tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path),
        truncated: tree.truncated,
      };
    },
    fileText: async (repo, file, ref) => {
      try {
        const response = await octokit.rest.repos.getContent({
          owner: repo.owner,
          repo: repo.name,
          path: file,
          ref,
          mediaType: { format: 'raw' },
        });
        return parse(z.string(), response.data, `${repo.fullName}/${file}`);
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'status' in error &&
          error.status === 404
        ) {
          return undefined;
        }
        throw error;
      }
    },
    closedPulls: async (repo, page) => {
      const response = await octokit.rest.pulls.list({
        owner: repo.owner,
        repo: repo.name,
        state: 'closed',
        sort: 'updated',
        direction: 'desc',
        per_page: 100,
        page,
      });
      return parse(z.array(PullSchema), response.data, `${repo.fullName} pulls`).map((pull) => ({
        number: pull.number,
        title: pull.title,
        url: pull.html_url,
        author: pull.user?.login ?? 'ghost',
        mergedAt: pull.merged_at,
        baseSha: pull.base.sha,
        headSha: pull.head.sha,
      }));
    },
    pullFiles: async (repo, pull, max) => {
      const response = await octokit.rest.pulls.listFiles({
        owner: repo.owner,
        repo: repo.name,
        pull_number: pull,
        per_page: Math.min(100, max + 1),
      });
      const files = parse(
        z.array(FileSchema),
        response.data,
        `${repo.fullName}#${String(pull)} files`,
      );
      if (files.length > max) {
        return undefined;
      }
      return files.map((file): ChangedFile => {
        if (file.status === 'renamed' && file.previous_filename !== undefined) {
          return { status: 'renamed', path: file.filename, oldPath: file.previous_filename };
        }
        return {
          status:
            file.status === 'added' ? 'added' : file.status === 'removed' ? 'deleted' : 'modified',
          path: file.filename,
        };
      });
    },
  };
}

function toRepo(repo: z.infer<typeof RepoSchema>): GitHubRepo {
  return {
    fullName: repo.full_name,
    owner: repo.owner.login,
    name: repo.name,
    cloneUrl: repo.clone_url,
    stars: repo.stargazers_count,
    pushedAt: repo.pushed_at,
    archived: repo.archived,
    hasLicense: repo.license !== null,
    defaultBranch: repo.default_branch,
  };
}

const CacheEntrySchema = z.object({ savedAt: z.number(), data: z.unknown() });

async function readCache(
  fs: FileSystem,
  file: string,
): Promise<z.infer<typeof CacheEntrySchema> | undefined> {
  if (!(await fs.exists(file))) {
    return undefined;
  }
  try {
    const parsed = CacheEntrySchema.safeParse(JSON.parse(await fs.readFile(file)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    // A corrupt cache entry is a miss; the request runs again and replaces it.
    return undefined;
  }
}

async function writeCache(
  fs: FileSystem,
  file: string,
  entry: z.infer<typeof CacheEntrySchema>,
): Promise<void> {
  await fs.mkdir(path.dirname(file));
  const temp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    await fs.writeFile(temp, JSON.stringify(entry));
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp);
  }
}
