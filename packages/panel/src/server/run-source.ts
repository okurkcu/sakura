import path from 'node:path';

import { RunIdSchema } from '@bdiff/core';
import type { FileSystem } from '@bdiff/core';

import { resolveRunFile } from './artifacts.js';

/** Where the panel reads runs from: a real workspace, or the demo. */
export interface RunSource {
  /** The workspace directory (holding `runs/<runId>/`), as shown in the sidebar. */
  readonly root: string;
  /** Ids of the run directories, unsorted. */
  listRunIds(): Promise<string[]>;
  /** A text file of a run, by path relative to its directory; `undefined` when absent. */
  readText(runId: string, file: string): Promise<string | undefined>;
  /** A binary file of a run, by path relative to its directory; `undefined` when absent. */
  readBytes(runId: string, file: string): Promise<Uint8Array | undefined>;
  /** Every file of a run, relative to its directory, sorted. */
  listFiles(runId: string): Promise<string[]>;
  /** Whether the process with this id still runs (a run in progress, or one that was killed). */
  isAlive(pid: number): boolean;
}

/** Inputs of {@link createWorkspaceRunSource}. */
export interface WorkspaceRunSourceOptions {
  readonly fs: FileSystem;
  /** The workspace (`.bdiff`). */
  readonly root: string;
  readonly isAlive: (pid: number) => boolean;
}

/** Directories of a run never served: git worktrees hold repository code and are removed anyway. */
const UNLISTED_DIRS = ['worktrees', 'node_modules'];

/**
 * Reads runs from a workspace on disk, read-only. Only run directories named by a run id are
 * listed, and every file path goes through {@link resolveRunFile}, so nothing outside a run
 * directory is ever read.
 */
export function createWorkspaceRunSource(options: WorkspaceRunSourceOptions): RunSource {
  const { fs, root } = options;
  const runsDir = path.join(root, 'runs');
  const fileOf = (runId: string, file: string): string | undefined =>
    RunIdSchema.safeParse(runId).success ? resolveRunFile(runsDir, runId, file) : undefined;
  return {
    root,
    listRunIds: async () => {
      if (!(await fs.exists(runsDir))) {
        return [];
      }
      return (await fs.readdir(runsDir)).filter((name) => RunIdSchema.safeParse(name).success);
    },
    readText: async (runId, file) => {
      const resolved = fileOf(runId, file);
      return resolved !== undefined && (await fs.exists(resolved))
        ? fs.readFile(resolved)
        : undefined;
    },
    readBytes: async (runId, file) => {
      const resolved = fileOf(runId, file);
      return resolved !== undefined && (await fs.exists(resolved))
        ? fs.readFileBytes(resolved)
        : undefined;
    },
    listFiles: async (runId) => {
      const dir = fileOf(runId, '.');
      if (dir === undefined || !(await fs.exists(dir))) {
        return [];
      }
      return fs.listFiles(dir, { ignoreDirs: UNLISTED_DIRS });
    },
    isAlive: options.isAlive,
  };
}
