/** `0:42`, `3:05`, `1:02:10`: wall time for tables and headers. Pure. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${String(minutes)}:${seconds}`;
}

/** `850 ms`, `4.2 s`, `3:05`: a stage's duration. Pure. */
export function shortDuration(ms: number): string {
  if (ms < 1000) {
    return `${String(Math.round(ms))} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  return clock(ms);
}

/** `$0.0123`; `$0` for nothing spent. Pure. */
export function usd(amount: number): string {
  return amount === 0 ? '$0' : `$${amount.toFixed(4)}`;
}

/** `just now`, `12 min ago`, `3 h ago`, `2 d ago`. Pure. */
export function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) {
    return 'just now';
  }
  if (seconds < 3600) {
    return `${String(Math.max(1, Math.round(seconds / 60)))} min ago`;
  }
  if (seconds < 86_400) {
    return `${String(Math.round(seconds / 3600))} h ago`;
  }
  return `${String(Math.round(seconds / 86_400))} d ago`;
}

/** `14:08:41` in local time. Pure (for a given time zone). */
export function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
}

/** First 8 characters of a run id, upper case like the design. Pure. */
export function shortRunId(runId: string): string {
  return runId.slice(0, 8).toUpperCase();
}

/** `main → pr/ui-change`, or the PR number and title when known. Pure. */
export function refs(target: { baseRef: string; headRef: string }): string {
  return `${short(target.baseRef)} → ${short(target.headRef)}`;
}

/** A 40-character SHA becomes its first 7 characters; other refs stay. */
function short(ref: string): string {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref;
}

/** The repository's name: last path segment of a URL or local path. Pure. */
export function repoName(repoUrl: string): string {
  const trimmed = repoUrl.replace(/\/+$/, '').replace(/\.git$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}
