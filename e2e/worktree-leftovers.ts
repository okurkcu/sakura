import path from 'node:path';

import { nodeFileSystem } from '@bdiff/core';
import type { Exec } from '@bdiff/core';

/** Every worktree still registered in the bare clones of a bdiff cache, as paths. */
export async function worktreeLeftovers(
  exec: Exec,
  cacheDir: string,
  signal: AbortSignal,
): Promise<string[]> {
  const reposDir = path.join(cacheDir, 'repos');
  const found: string[] = [];
  for (const repo of await nodeFileSystem.readdir(reposDir)) {
    const result = await exec.run('git', ['worktree', 'list', '--porcelain'], {
      cwd: path.join(reposDir, repo),
      timeoutMs: 30_000,
      signal,
    });
    found.push(
      ...result.stdout
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length))
        // The first entry is the bare clone itself.
        .slice(1),
    );
  }
  return found;
}
