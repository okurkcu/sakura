import type { GitHubClient } from '../adapters/github.js';
import { parseGitHubRepo } from '../adapters/github.js';
import type { Logger } from '../adapters/logger.js';
import type { Target } from '../domain/target.js';
import type { Workspace } from '../domain/workspace.js';
import { BdiffError } from '../errors/bdiff-error.js';
import type { Git } from '../workspace/git.js';

/** What the pull request says it does. */
export interface PrIntent {
  /** Where it came from: the target itself, GitHub, the head commits, or nowhere. */
  readonly source: 'target' | 'github' | 'commits' | 'none';
  readonly title: string;
  readonly body: string;
  /** Sources that were tried and failed, e.g. `GitHub answered 404 …`. */
  readonly notes: string[];
}

/** Dependencies of {@link resolveIntent}. */
export interface IntentDeps {
  readonly github: GitHubClient;
  /** Git bound to the run's abort signal. */
  readonly git: Git;
}

const GITHUB_TIMEOUT_MS = 15_000;
const MAX_COMMITS = 20;
const COMMIT_SEPARATOR = '\u001e';

/**
 * The pull request's stated intent, from the first source that has it: the target's own title
 * and body (a dataset entry); GitHub, when the target has a PR number and a github.com URL; the
 * messages of the commits from base to head. A failing source is noted and the next one tried.
 */
export async function resolveIntent(
  target: Target,
  workspace: Workspace,
  deps: IntentDeps,
  ctx: { readonly signal: AbortSignal; readonly logger: Logger },
): Promise<PrIntent> {
  const notes: string[] = [];
  if (target.prTitle !== undefined) {
    return { source: 'target', title: target.prTitle, body: target.prBody ?? '', notes };
  }
  const repo = parseGitHubRepo(target.repoUrl);
  if (target.prNumber !== undefined && repo !== undefined) {
    try {
      const pr = await deps.github.getPullRequest(repo, target.prNumber, {
        timeoutMs: GITHUB_TIMEOUT_MS,
        signal: ctx.signal,
      });
      return { source: 'github', title: pr.title, body: pr.body, notes };
    } catch (error) {
      if (!(error instanceof BdiffError) || error.code !== 'HTTP_FAILED') {
        throw error;
      }
      ctx.logger.warn('could not read the pull request from GitHub', { message: error.message });
      notes.push(error.message);
    }
  }
  try {
    const log = await deps.git.ok(
      [
        'log',
        '--no-merges',
        `--max-count=${String(MAX_COMMITS)}`,
        `--format=%s%n%n%b${COMMIT_SEPARATOR}`,
        `${workspace.baseSha}..${workspace.headSha}`,
      ],
      { cwd: workspace.headPath },
    );
    const messages = log
      .split(COMMIT_SEPARATOR)
      .map((message) => message.trim())
      .filter((message) => message !== '');
    const [first] = messages;
    if (first === undefined) {
      return { source: 'none', title: '', body: '', notes };
    }
    if (messages.length === 1) {
      const [subject = '', ...rest] = first.split('\n');
      return { source: 'commits', title: subject, body: rest.join('\n').trim(), notes };
    }
    return {
      source: 'commits',
      title: `${String(messages.length)} commits`,
      body: messages.map((message) => `- ${message.replaceAll('\n', '\n  ')}`).join('\n'),
      notes,
    };
  } catch (error) {
    if (!(error instanceof BdiffError) || error.code !== 'GIT_FAILED') {
      throw error;
    }
    ctx.logger.warn('could not read the head commits', { message: error.message });
    return { source: 'none', title: '', body: '', notes: [...notes, error.message] };
  }
}
