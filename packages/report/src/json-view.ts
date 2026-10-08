import { isJsonPathAtOrBelow, jsonChildPath } from '@bdiff/core';
import type { JsonValue } from '@bdiff/core';

import { html } from './html.js';
import type { Html } from './html.js';

/** One line of pretty-printed JSON and the JSON path it belongs to. */
export interface JsonLine {
  readonly text: string;
  readonly path: string;
}

/**
 * JSON pretty-printed with two-space indents and sorted keys, one line per member, each tagged
 * with its path in the diff engine's syntax (`$.items[0].price`). Pure.
 */
export function jsonLines(value: JsonValue): JsonLine[] {
  const lines: JsonLine[] = [];
  write(value, '$', '', '', lines);
  return lines;
}

function write(
  value: JsonValue,
  path: string,
  indent: string,
  label: string,
  lines: JsonLine[],
): void {
  if (typeof value !== 'object' || value === null) {
    lines.push({ text: `${indent}${label}${JSON.stringify(value)}`, path });
    return;
  }
  const members = Array.isArray(value)
    ? value.map((item, i) => ({ label: '', path: `${path}[${String(i)}]`, value: item }))
    : Object.keys(value)
        .sort()
        .map((key) => ({
          label: `${JSON.stringify(key)}: `,
          path: jsonChildPath(path, key),
          value: value[key] ?? null,
        }));
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  if (members.length === 0) {
    lines.push({ text: `${indent}${label}${open}${close}`, path });
    return;
  }
  lines.push({ text: `${indent}${label}${open}`, path });
  members.forEach((member, i) => {
    write(member.value, member.path, `${indent}  `, member.label, lines);
    const last = lines.at(-1);
    if (last !== undefined && i < members.length - 1) {
      lines[lines.length - 1] = { ...last, text: `${last.text},` };
    }
  });
  lines.push({ text: `${indent}${close}`, path });
}

/**
 * A `<pre>` of the JSON, lines at or below one of `changedPaths` highlighted. Values are escaped
 * like any other text.
 */
export function jsonView(value: JsonValue, changedPaths: readonly string[]): Html {
  const lines = jsonLines(value).map((line) => {
    const changed = changedPaths.some((changedPath) => isJsonPathAtOrBelow(line.path, changedPath));
    return html`<span class="${changed ? 'line changed' : 'line'}">${line.text}</span>`;
  });
  return html`<pre class="json">${lines}</pre>`;
}
