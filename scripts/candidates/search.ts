import path from 'node:path';

import type { Logger } from '@bdiff/core';

import {
  classifyAuthor,
  classifyPrType,
  excludeReason,
  guessDifficulty,
  repoSignals,
} from './classify.js';
import type { GitHubApi, GitHubRepo } from './github.js';
import { capPerRepo, MAX_CHANGED_FILES, rankCandidates, scoreCandidate } from './rank.js';
import type { Candidate, RepoSignals } from './schema.js';

/** Settings of a candidate search. */
export interface FindOptions {
  /** Repositories pushed and PRs merged on or after this day. */
  readonly since: Date;
  readonly minStars: number;
  /** Most repositories examined. */
  readonly maxRepos: number;
  /** Most merged PRs examined per repository. */
  readonly prsPerRepo: number;
  /** Most candidates kept per repository, best first. */
  readonly candidatesPerRepo: number;
  /** Known coding-agent logins (`scripts/agent-authors.json`). */
  readonly agentAccounts: readonly string[];
  readonly logger: Logger;
}

/** Repository search queries: TypeScript Next.js projects that are popular and active. */
export function searchQueries(since: Date, minStars: number): string[] {
  const day = since.toISOString().slice(0, 10);
  return ['nextjs', 'next', 'next-js'].map(
    (topic) =>
      `topic:${topic} language:TypeScript stars:>=${String(minStars)} pushed:>=${day} archived:false`,
  );
}

/** Most `package.json` files read per repository while looking for the Next.js app. */
const MAX_PACKAGE_READS = 6;
const SEARCH_PAGES = 3;
const PULL_PAGES = 2;

/**
 * Finds candidate PRs: repositories from {@link searchQueries} that are not archived, have a
 * license and a `package.json` depending on `next`, then their PRs merged since `since` that change
 * at most {@link MAX_CHANGED_FILES} files and that bdiff would not skip. Each is classified, scored,
 * and the list is ranked, keeping `candidatesPerRepo` per repository. A repository that fails to
 * load is logged and left out.
 */
export async function findCandidates(
  api: GitHubApi,
  options: FindOptions,
): Promise<{ readonly repos: number; readonly candidates: Candidate[] }> {
  const { logger } = options;
  const repos = await searchRepos(api, options);
  logger.info('repositories found', { count: repos.length });

  const candidates: Candidate[] = [];
  for (const repo of repos) {
    try {
      const signals = await nextAppSignals(api, repo);
      if (signals === undefined) {
        logger.info('no Next.js app', { repo: repo.fullName });
        continue;
      }
      const found = await repoCandidates(api, repo, signals, options);
      logger.info('repository examined', { repo: repo.fullName, candidates: found.length });
      candidates.push(...found);
    } catch (error) {
      if (isUnauthorized(error)) {
        throw error;
      }
      logger.warn('repository skipped', { repo: repo.fullName, err: error });
    }
  }

  const ranked = capPerRepo(rankCandidates(candidates), options.candidatesPerRepo);
  return { repos: new Set(ranked.map((c) => c.repo.fullName)).size, candidates: ranked };
}

async function searchRepos(api: GitHubApi, options: FindOptions): Promise<GitHubRepo[]> {
  const found = new Map<string, GitHubRepo>();
  for (const query of searchQueries(options.since, options.minStars)) {
    for (let page = 1; page <= SEARCH_PAGES && found.size < options.maxRepos; page++) {
      const results = await api.searchRepositories(query, page);
      for (const repo of results) {
        if (
          !repo.archived &&
          repo.hasLicense &&
          Date.parse(repo.pushedAt) >= options.since.getTime() &&
          found.size < options.maxRepos
        ) {
          found.set(repo.fullName, repo);
        }
      }
      if (results.length < 100) {
        break;
      }
    }
  }
  return [...found.values()];
}

/** The repository's setup signals, or undefined when no `package.json` depends on `next`. */
async function nextAppSignals(api: GitHubApi, repo: GitHubRepo): Promise<RepoSignals | undefined> {
  const { paths } = await api.repoPaths(repo, repo.defaultBranch);
  const packageJsons = paths
    .filter(
      (file) =>
        path.posix.basename(file) === 'package.json' &&
        file.split('/').length <= 3 &&
        !file.includes('node_modules/'),
    )
    .sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1))
    .slice(0, MAX_PACKAGE_READS);
  let rootWorkspaces = false;
  for (const file of packageJsons) {
    const pkg = parsePackageJson(await api.fileText(repo, file, repo.defaultBranch));
    if (file === 'package.json') {
      rootWorkspaces = pkg?.workspaces !== undefined;
    }
    if (pkg !== undefined && dependsOnNext(pkg)) {
      return repoSignals(paths, path.posix.dirname(file), rootWorkspaces);
    }
  }
  return undefined;
}

async function repoCandidates(
  api: GitHubApi,
  repo: GitHubRepo,
  signals: RepoSignals,
  options: FindOptions,
): Promise<Candidate[]> {
  const difficulty = guessDifficulty(signals);
  const candidates: Candidate[] = [];
  let examined = 0;
  for (let page = 1; page <= PULL_PAGES && examined < options.prsPerRepo; page++) {
    const pulls = await api.closedPulls(repo, page);
    for (const pull of pulls) {
      if (examined >= options.prsPerRepo) {
        break;
      }
      if (pull.mergedAt === null || Date.parse(pull.mergedAt) < options.since.getTime()) {
        continue;
      }
      examined += 1;
      const files = await api.pullFiles(repo, pull.number, MAX_CHANGED_FILES);
      if (files === undefined || excludeReason(files) !== undefined) {
        continue;
      }
      const paths = files.map((file) => file.path);
      const tags = {
        difficulty,
        prType: classifyPrType(paths),
        author: classifyAuthor(pull.author, options.agentAccounts),
      };
      candidates.push({
        id: candidateId(repo, pull.number),
        repoUrl: repo.cloneUrl,
        prNumber: pull.number,
        baseRef: pull.baseSha,
        headRef: pull.headSha,
        tags,
        title: pull.title,
        url: pull.url,
        author: pull.author,
        mergedAt: pull.mergedAt,
        changedFiles: paths,
        repo: { fullName: repo.fullName, stars: repo.stars, signals },
        score: scoreCandidate(tags, paths.length),
      });
    }
    if (pulls.length < 100) {
      break;
    }
  }
  return candidates;
}

/** A dataset id for a PR: `<owner>-<repo>-<number>`, made of the characters ids allow. Pure. */
export function candidateId(repo: Pick<GitHubRepo, 'owner' | 'name'>, pull: number): string {
  const slug = `${repo.owner}-${repo.name}`.replace(/[^\w.-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '');
  return `${slug.slice(0, 90)}-${String(pull)}`;
}

interface PackageJson {
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
  readonly workspaces?: unknown;
}

function parsePackageJson(text: string | undefined): PackageJson | undefined {
  if (text === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    // A package.json that does not parse cannot declare the Next.js app.
    return undefined;
  }
}

function dependsOnNext(pkg: PackageJson): boolean {
  return [pkg.dependencies, pkg.devDependencies].some(
    (deps) => typeof deps === 'object' && deps !== null && 'next' in deps,
  );
}

function isUnauthorized(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 401;
}
