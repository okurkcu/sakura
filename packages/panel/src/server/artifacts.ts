import path from 'node:path';

/**
 * The absolute path of `relative` inside the run directory `<runsDir>/<runId>`, or `undefined`
 * when it could point anywhere else: absolute paths, `..` segments, backslashes, NUL bytes and
 * empty paths are refused, and the joined result must stay inside the run directory. `.` names
 * the run directory itself. Pure.
 */
export function resolveRunFile(
  runsDir: string,
  runId: string,
  relative: string,
): string | undefined {
  if (
    relative === '' ||
    relative.includes('\0') ||
    relative.includes('\\') ||
    path.posix.isAbsolute(relative) ||
    /^[A-Za-z]:/.test(relative) ||
    relative.split('/').some((segment) => segment === '..')
  ) {
    return undefined;
  }
  const runDir = path.join(runsDir, runId);
  const resolved = path.join(runDir, relative);
  return resolved === runDir || resolved.startsWith(`${runDir}${path.sep}`) ? resolved : undefined;
}

/** Media types of the files the panel serves; anything else is refused. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
};

/** The media type to serve `file` with, or `undefined` if it must not be served. Pure. */
export function contentTypeOf(file: string): string | undefined {
  return CONTENT_TYPES[path.extname(file).toLowerCase()];
}
