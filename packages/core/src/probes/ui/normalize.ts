/** Space-like characters a browser may return in `innerText`, besides the ASCII space and tab. */
const UNICODE_SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/g;

/**
 * Normalizes the visible text of a page so that only real text changes compare unequal: unifies
 * line endings, turns non-breaking and other Unicode spaces into spaces, drops zero-width
 * characters, collapses runs of spaces within a line, trims every line, collapses runs of blank
 * lines into one and trims blank lines at both ends. Pure.
 */
export function normalizeVisibleText(raw: string): string {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .replace(UNICODE_SPACES, ' ')
    .replace(ZERO_WIDTH, '')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim());
  const kept: string[] = [];
  for (const line of lines) {
    if (line !== '' || (kept.length > 0 && kept.at(-1) !== '')) {
      kept.push(line);
    }
  }
  while (kept.at(-1) === '') {
    kept.pop();
  }
  return kept.join('\n');
}

/**
 * Removes the app's own origin (e.g. `http://127.0.0.1:55012`) from a string, and replaces its bare
 * host (`127.0.0.1:55012`, as in `ws://` URLs) with `<app>`. Base and head are served on different
 * ports, so this keeps messages that mention the app's URLs comparable. Pure.
 */
export function stripOrigin(text: string, origin: string): string {
  const { host } = new URL(origin);
  return text.replaceAll(new URL(origin).origin, '').replaceAll(host, '<app>');
}

/**
 * A request URL as recorded in a capture: path, query and hash for the app's own origin, the full
 * URL otherwise. Pure.
 */
export function appRelativeUrl(url: string, origin: string): string {
  const parsed = URL.parse(url);
  if (parsed?.origin !== new URL(origin).origin) {
    return url;
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** The first line of an error message, without the app's origin. Pure. */
export function errorSummary(message: string, origin: string): string {
  return stripOrigin(message.split('\n', 1)[0] ?? '', origin).trim();
}
