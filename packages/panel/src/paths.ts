/**
 * Where an artifact of a run lives relative to its run directory. Records store absolute paths of
 * the machine that ran (`…/runs/<runId>/ui/head/login-1a2b3c4d.png`); the panel serves files by
 * their path inside the run directory, which also works for a moved workspace (the demo). A
 * relative path is kept as it is. `undefined` for a path outside the run. Pure, browser-safe.
 */
export function runRelativePath(file: string, runId: string): string | undefined {
  const marker = `/runs/${runId}/`;
  const at = file.lastIndexOf(marker);
  if (at >= 0) {
    return file.slice(at + marker.length);
  }
  return file.startsWith('/') || file === '' ? undefined : file;
}

/** The panel URL of a run's file (see {@link runRelativePath}). Pure, browser-safe. */
export function runFileUrl(runId: string, file: string): string | undefined {
  const relative = runRelativePath(file, runId);
  return relative === undefined
    ? undefined
    : `/api/runs/${encodeURIComponent(runId)}/files/${relative.split('/').map(encodeURIComponent).join('/')}`;
}
