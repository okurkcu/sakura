import path from 'node:path';

import type { FileSystem } from '../adapters/file-system.js';
import { BdiffError } from '../errors/bdiff-error.js';

/** An in-memory {@link FileSystem} plus its contents, for tests. */
export interface MemoryFileSystem extends FileSystem {
  /** Files by absolute path. Text files are strings, binary ones byte arrays. */
  readonly files: Map<string, string | Uint8Array>;
  /** Directories that exist (created by `mkdir`, or holding a file). */
  readonly dirs: Set<string>;
  /** Makes every operation whose name is in `operations` fail with `FS_FAILED`. */
  failOn(...operations: (keyof FileSystem)[]): void;
}

/**
 * Creates an empty in-memory file system with `files` already written. Paths are POSIX and
 * absolute. Writing into a directory that does not exist fails, like the real one.
 */
export function createMemoryFileSystem(
  initial: Readonly<Record<string, string | Uint8Array>> = {},
): MemoryFileSystem {
  const files = new Map<string, string | Uint8Array>();
  const dirs = new Set<string>(['/']);
  const failing = new Set<string>();
  const addDirs = (dir: string) => {
    for (let current = dir; !dirs.has(current); current = path.dirname(current)) {
      dirs.add(current);
    }
  };
  const check = (operation: keyof FileSystem, target: string) => {
    if (failing.has(operation)) {
      throw new BdiffError('FS_FAILED', `File system ${operation} failed: ${target}`, {
        details: { operation, path: target },
      });
    }
  };
  const needParent = (operation: keyof FileSystem, target: string) => {
    if (!dirs.has(path.dirname(target))) {
      throw new BdiffError('FS_FAILED', `File system ${operation} failed: ${target}`, {
        details: { operation, path: target, reason: 'ENOENT' },
      });
    }
  };
  const read = (operation: keyof FileSystem, target: string) => {
    check(operation, target);
    const content = files.get(target);
    if (content === undefined) {
      throw new BdiffError('FS_FAILED', `File system ${operation} failed: ${target}`, {
        details: { operation, path: target, reason: 'ENOENT' },
      });
    }
    return content;
  };
  const under = (root: string) => (root.endsWith('/') ? root : `${root}/`);
  for (const [file, content] of Object.entries(initial)) {
    addDirs(path.dirname(file));
    files.set(file, content);
  }

  return {
    files,
    dirs,
    failOn: (...operations) => {
      for (const operation of operations) {
        failing.add(operation);
      }
    },
    readFile: (file) =>
      Promise.resolve().then(() => {
        const content = read('readFile', file);
        return typeof content === 'string' ? content : new TextDecoder().decode(content);
      }),
    readFileBytes: (file) =>
      Promise.resolve().then(() => {
        const content = read('readFileBytes', file);
        return typeof content === 'string' ? new TextEncoder().encode(content) : content;
      }),
    writeFile: (file, data) =>
      Promise.resolve().then(() => {
        check('writeFile', file);
        needParent('writeFile', file);
        files.set(file, data);
      }),
    appendFile: (file, data) =>
      Promise.resolve().then(() => {
        check('appendFile', file);
        needParent('appendFile', file);
        const current = files.get(file) ?? '';
        files.set(
          file,
          `${typeof current === 'string' ? current : new TextDecoder().decode(current)}${data}`,
        );
      }),
    mkdir: (dir) =>
      Promise.resolve().then(() => {
        check('mkdir', dir);
        addDirs(dir);
      }),
    rm: (target) =>
      Promise.resolve().then(() => {
        check('rm', target);
        files.delete(target);
        dirs.delete(target);
        for (const key of [...files.keys()].filter((file) => file.startsWith(under(target)))) {
          files.delete(key);
        }
        for (const key of [...dirs].filter((dir) => dir.startsWith(under(target)))) {
          dirs.delete(key);
        }
      }),
    rename: (from, to) =>
      Promise.resolve().then(() => {
        const content = read('rename', from);
        needParent('rename', to);
        files.delete(from);
        files.set(to, content);
      }),
    exists: (target) =>
      Promise.resolve().then(() => {
        check('exists', target);
        return files.has(target) || dirs.has(target);
      }),
    readdir: (dir) =>
      Promise.resolve().then(() => {
        check('readdir', dir);
        if (!dirs.has(dir)) {
          throw new BdiffError('FS_FAILED', `File system readdir failed: ${dir}`, {
            details: { operation: 'readdir', path: dir, reason: 'ENOENT' },
          });
        }
        const names = new Set<string>();
        for (const entry of [...files.keys(), ...dirs]) {
          if (entry !== dir && path.dirname(entry) === dir) {
            names.add(path.basename(entry));
          }
        }
        return [...names].sort();
      }),
    listFiles: (root, options = {}) =>
      Promise.resolve().then(() => {
        check('listFiles', root);
        const ignored = new Set(options.ignoreDirs ?? []);
        return [...files.keys()]
          .filter((file) => file.startsWith(under(root)))
          .map((file) => file.slice(under(root).length))
          .filter(
            (file) =>
              !file
                .split('/')
                .slice(0, -1)
                .some((dir) => ignored.has(dir)),
          )
          .sort();
      }),
  };
}
