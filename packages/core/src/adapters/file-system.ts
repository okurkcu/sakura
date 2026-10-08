import {
  access,
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';

import { BdiffError } from '../errors/bdiff-error.js';

/** The file operations bdiff needs. Failures throw `BdiffError` `FS_FAILED`. */
export interface FileSystem {
  /** Reads a UTF-8 text file. */
  readFile(path: string): Promise<string>;
  /** Reads a binary file (e.g. a screenshot). */
  readFileBytes(path: string): Promise<Uint8Array>;
  /** Creates or replaces a file. The parent directory must exist. */
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  /** Appends UTF-8 text, creating the file if needed. */
  appendFile(path: string, data: string): Promise<void>;
  /** Creates a directory and any missing parents; no-op if it exists. */
  mkdir(path: string): Promise<void>;
  /** Removes a file or directory tree; no-op if it doesn't exist. */
  rm(path: string): Promise<void>;
  /** Renames atomically within one file system. */
  rename(from: string, to: string): Promise<void>;
  /** Whether anything exists at `path`. */
  exists(path: string): Promise<boolean>;
  /** Entry names in a directory, sorted for determinism. */
  readdir(path: string): Promise<string[]>;
}

/** The real file system, over `node:fs/promises`. */
export const nodeFileSystem: FileSystem = {
  readFile: (path) => attempt('readFile', path, () => readFile(path, 'utf8')),
  readFileBytes: (path) =>
    attempt('readFileBytes', path, async () => new Uint8Array(await readFile(path))),
  writeFile: (path, data) => attempt('writeFile', path, () => writeFile(path, data)),
  appendFile: (path, data) => attempt('appendFile', path, () => appendFile(path, data, 'utf8')),
  mkdir: (path) =>
    attempt('mkdir', path, async () => {
      await mkdir(path, { recursive: true });
    }),
  rm: (path) => attempt('rm', path, () => rm(path, { recursive: true, force: true })),
  rename: (from, to) => attempt('rename', from, () => rename(from, to), { to }),
  exists: (path) =>
    attempt('exists', path, async () => {
      try {
        await access(path);
        return true;
      } catch (error) {
        if (hasCode(error, 'ENOENT')) {
          return false;
        }
        throw error;
      }
    }),
  readdir: (path) => attempt('readdir', path, async () => (await readdir(path)).sort()),
};

async function attempt<T>(
  operation: string,
  path: string,
  action: () => Promise<T>,
  extra: Readonly<Record<string, string>> = {},
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw new BdiffError('FS_FAILED', `File system ${operation} failed: ${path}`, {
      cause: error,
      details: { operation, path, ...extra },
    });
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
