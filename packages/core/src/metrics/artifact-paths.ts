import { createHash } from 'node:crypto';
import path from 'node:path';

import { RunIdSchema } from './run-id.js';
import type { RunId } from './run-id.js';
import type { ProbeRun, Side } from '../domain/stage.js';
import { BdiffError } from '../errors/bdiff-error.js';

/** Longest readable part of an artifact file name, before the hash suffix. */
const MAX_SLUG_LENGTH = 60;

/**
 * Every path bdiff writes. Build artifact paths only through this helper, never by hand, so the
 * layout stays in one place:
 *
 * ```
 * <root>/results.csv
 * <root>/runs/<runId>/run.json | compose.yml | logs/ | worktrees/<side>/ | ui/<probeRun>/ | api/<probeRun>/
 *                     | diff/ | report/index.html
 * ```
 */
export interface ArtifactPaths {
  /** The output root, `.bdiff` by default. */
  readonly root: string;
  /** One row per run across all runs. */
  readonly resultsCsv: string;
  readonly runDir: string;
  readonly runJson: string;
  readonly composeFile: string;
  readonly logsDir: string;
  /** `logs/<name>.log`; `name` is a fixed identifier such as `base` or `head`. */
  log(name: string): string;
  /** Screenshot of `route` (e.g. `/login`) in one probe run. */
  uiScreenshot(probeRun: ProbeRun, route: string): string;
  /** Response for one request (e.g. `GET /api/orders/latest`) in one probe run. */
  apiResponse(probeRun: ProbeRun, requestKey: string): string;
  /** Git worktree of one side: `worktrees/<side>`. Removed when the run ends. */
  worktree(side: Side): string;
  readonly diffDir: string;
  /** Overlay of what changed on `route` between base and head: `diff/ui/<route>.png`. */
  diffOverlay(route: string): string;
  readonly reportDir: string;
  readonly reportHtml: string;
}

/**
 * Creates the {@link ArtifactPaths} of one run.
 *
 * @throws BdiffError `INVALID_INPUT` if `runId` is not a run id (it becomes a directory name).
 */
export function createArtifactPaths(root: string, runId: RunId): ArtifactPaths {
  if (!RunIdSchema.safeParse(runId).success) {
    throw new BdiffError('INVALID_INPUT', `Not a run id: ${runId}`);
  }
  const runDir = path.join(root, 'runs', runId);
  const logsDir = path.join(runDir, 'logs');
  const reportDir = path.join(runDir, 'report');
  return {
    root,
    resultsCsv: path.join(root, 'results.csv'),
    runDir,
    runJson: path.join(runDir, 'run.json'),
    composeFile: path.join(runDir, 'compose.yml'),
    logsDir,
    log: (name) => {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        throw new BdiffError('INVALID_INPUT', `Invalid log name: ${name}`);
      }
      return path.join(logsDir, `${name}.log`);
    },
    uiScreenshot: (probeRun, route) =>
      path.join(runDir, 'ui', probeRun, `${artifactFileStem(route)}.png`),
    apiResponse: (probeRun, requestKey) =>
      path.join(runDir, 'api', probeRun, `${artifactFileStem(requestKey)}.json`),
    worktree: (side) => path.join(runDir, 'worktrees', side),
    diffDir: path.join(runDir, 'diff'),
    diffOverlay: (route) => path.join(runDir, 'diff', 'ui', `${artifactFileStem(route)}.png`),
    reportDir,
    reportHtml: path.join(reportDir, 'index.html'),
  };
}

/**
 * File-name stem for an untrusted key such as a route or request: a readable slug plus 8 hex
 * characters of the key's SHA-256. The slug keeps names recognizable; the hash keeps distinct
 * keys (`/a/b` vs `/a-b`) apart. The result never contains a path separator or `..`. Pure.
 */
export function artifactFileStem(key: string): string {
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 8);
  return `${slug === '' ? 'index' : slug}-${hash}`;
}
