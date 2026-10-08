/**
 * Parses dotenv text into ordered key/value pairs: `KEY=value`, optional `export `, single or double
 * quotes, and `#` comments (whole-line, or after an unquoted value). Invalid lines are skipped; a
 * repeated key keeps its last value. Never evaluates anything. Pure.
 */
export function parseDotenv(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    const key = match?.[1];
    const rawValue = match?.[2];
    if (key === undefined || rawValue === undefined) {
      continue;
    }
    entries.set(key, unquote(rawValue));
  }
  return entries;
}

function unquote(value: string): string {
  const quote = value.charAt(0);
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    if (end > 0) {
      const inner = value.slice(1, end);
      return quote === '"' ? inner.replaceAll('\\n', '\n') : inner;
    }
  }
  return value.replace(/\s+#.*$/, '').trim();
}
