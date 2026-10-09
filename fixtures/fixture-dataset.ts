import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createExecaExec, nodeFileSystem } from '@bdiff/core';

import { BASE_BRANCH } from './branches.js';
import type { PrBranch } from './branches.js';
import { buildFixtureRepo } from './build-fixture-repo.js';

/** A `bdiff batch` dataset entry for one fixture PR branch (the shape `dataset.json` expects). */
export interface FixtureDatasetEntry {
  readonly id: string;
  readonly repoUrl: string;
  readonly baseRef: string;
  readonly headRef: PrBranch;
  readonly tags: {
    readonly difficulty: 'easy';
    readonly prType: 'ui' | 'api' | 'refactor';
    readonly author: 'human';
  };
}

/** Every PR branch, tagged by what it changes. `docs-only` changes no behavior, like a refactor. */
const FIXTURE_ENTRIES: readonly (readonly [PrBranch, FixtureDatasetEntry['tags']['prType']])[] = [
  ['pr/ui-change', 'ui'],
  ['pr/api-breaking', 'api'],
  ['pr/refactor-no-change', 'refactor'],
  ['pr/docs-only', 'refactor'],
];

/** The dataset of every fixture PR branch of the fixture repository at `repoPath`. Pure. */
export function fixtureDatasetEntries(repoPath: string): FixtureDatasetEntry[] {
  return FIXTURE_ENTRIES.map(([branch, prType]) => ({
    id: branch.replace(/^pr\//, ''),
    repoUrl: repoPath,
    baseRef: BASE_BRANCH,
    headRef: branch,
    tags: { difficulty: 'easy', prType, author: 'human' },
  }));
}

/**
 * CLI: `pnpm fixture:dataset [dir]`. Builds the fixture repository in `<dir>/repo` (a new temp dir
 * by default) and writes `<dir>/dataset.json` for it; prints the dataset's path.
 */
async function main(): Promise<void> {
  const controller = new AbortController();
  process.once('SIGINT', () => {
    controller.abort();
  });
  const dir = path.resolve(
    process.argv[2] ?? (await mkdtemp(path.join(tmpdir(), 'bdiff-fixture-dataset-'))),
  );
  const repo = await buildFixtureRepo({
    targetDir: path.join(dir, 'repo'),
    exec: createExecaExec(),
    fs: nodeFileSystem,
    signal: controller.signal,
  });
  const file = path.join(dir, 'dataset.json');
  await nodeFileSystem.writeFile(
    file,
    `${JSON.stringify({ entries: fixtureDatasetEntries(repo.path) }, null, 2)}\n`,
  );
  process.stdout.write(`${file}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
