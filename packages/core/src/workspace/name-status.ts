import type { ChangedFile } from '../domain/workspace.js';
import { BdiffError } from '../errors/bdiff-error.js';

/**
 * Parses `git diff --name-status -M -z` output. Renames (`R<score>`) keep both paths; a type change
 * (`T`) counts as modified; copies (`C<score>`) count as an added file. NUL separation keeps paths
 * with spaces, quotes or non-ASCII characters intact. Pure.
 *
 * @throws BdiffError `INTERNAL` on output git would not produce.
 */
export function parseNameStatusZ(output: string): ChangedFile[] {
  const tokens = output.split('\0');
  if (tokens.at(-1) === '') {
    tokens.pop();
  }
  const files: ChangedFile[] = [];
  let index = 0;
  const next = (): string => {
    const token = tokens[index];
    index += 1;
    if (token === undefined || token === '') {
      throw new BdiffError('INTERNAL', 'Truncated git name-status output', { details: { output } });
    }
    return token;
  };
  while (index < tokens.length) {
    const status = next();
    const kind = status.charAt(0);
    if (kind === 'R') {
      const oldPath = next();
      files.push({ status: 'renamed', path: next(), oldPath });
    } else if (kind === 'C') {
      next();
      files.push({ status: 'added', path: next() });
    } else if (kind === 'A') {
      files.push({ status: 'added', path: next() });
    } else if (kind === 'M' || kind === 'T') {
      files.push({ status: 'modified', path: next() });
    } else if (kind === 'D') {
      files.push({ status: 'deleted', path: next() });
    } else {
      throw new BdiffError('INTERNAL', `Unexpected git name-status "${status}"`, {
        details: { output },
      });
    }
  }
  return files;
}
