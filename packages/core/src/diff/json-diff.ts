import type { JsonValue } from '../domain/json.js';

/** One difference between two JSON documents, at its top-most path. */
export interface JsonChange {
  readonly kind: 'field-added' | 'field-removed' | 'type-changed' | 'value-changed';
  /** e.g. `$.total`, `$.items[0].price`, `$["content-type"]`. */
  readonly path: string;
  readonly before?: JsonValue;
  readonly after?: JsonValue;
}

/** What changed between baseA and head, once noise is set aside. */
export interface JsonDiff {
  readonly changes: JsonChange[];
  /** Changes of baseA vs head before setting noise aside. */
  readonly raw: number;
  readonly noise: number;
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Compares head's JSON with baseA's, at the top-most paths that differ (an added object is one
 * `field-added`, not one per leaf), in sorted key order. Paths where baseA and baseB already differ
 * are noise, and so is any change at or below them, unless head's value has a different shape
 * from both bases: another JSON type, or a string of another format (ISO date-time, UUID, text).
 * That way a changing timestamp is noise, but a timestamp that became a number is not. Pure.
 */
export function diffJson(baseA: JsonValue, baseB: JsonValue, head: JsonValue): JsonDiff {
  const noisy = compare(baseA, baseB, '$').map((change) => change.path);
  const changes: JsonChange[] = [];
  let noise = 0;
  const raw = compare(baseA, head, '$');
  for (const change of raw) {
    const noisyRoot = noisy.find((root) => isJsonPathAtOrBelow(change.path, root));
    if (noisyRoot === undefined) {
      changes.push(change);
      continue;
    }
    const a = valueAt(baseA, change.path);
    const b = valueAt(baseB, change.path);
    const h = valueAt(head, change.path);
    if (
      a.found &&
      b.found &&
      h.found &&
      shapeOf(h.value) !== shapeOf(a.value) &&
      shapeOf(h.value) !== shapeOf(b.value)
    ) {
      changes.push({ kind: 'type-changed', path: change.path, before: a.value, after: h.value });
    } else {
      noise += 1;
    }
  }
  return { changes, raw: raw.length, noise };
}

/** The type of a JSON value: `null`, `boolean`, `number`, `string`, `array` or `object`. */
export function jsonTypeOf(value: JsonValue): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function shapeOf(value: JsonValue): string {
  if (typeof value !== 'string') {
    return jsonTypeOf(value);
  }
  if (ISO_DATETIME.test(value)) {
    return 'string:iso-datetime';
  }
  return UUID.test(value) ? 'string:uuid' : 'string';
}

function compare(before: JsonValue, after: JsonValue, path: string): JsonChange[] {
  if (jsonTypeOf(before) !== jsonTypeOf(after)) {
    return [{ kind: 'type-changed', path, before, after }];
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const changes: JsonChange[] = [];
    for (let i = 0; i < Math.max(before.length, after.length); i += 1) {
      changes.push(...compareMember(before[i], after[i], `${path}[${String(i)}]`));
    }
    return changes;
  }
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => compareMember(before[key], after[key], jsonChildPath(path, key)));
  }
  return before === after ? [] : [{ kind: 'value-changed', path, before, after }];
}

function compareMember(
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  path: string,
): JsonChange[] {
  if (before === undefined && after === undefined) {
    return [];
  }
  if (before === undefined) {
    return [{ kind: 'field-added', path, after: after ?? null }];
  }
  if (after === undefined) {
    return [{ kind: 'field-removed', path, before }];
  }
  return compare(before, after, path);
}

function isObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The path of `key` in the object at `path`: `$.key` for identifier-like keys, `$["any key"]` otherwise. Pure. */
export function jsonChildPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/** Whether `path` is `root` or inside it (`$.a.b` is below `$.a`, `$.ab` is not). Pure. */
export function isJsonPathAtOrBelow(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}.`) || path.startsWith(`${root}[`);
}

/** Follows a path made by {@link jsonChildPath} and array indexes. */
function valueAt(
  root: JsonValue,
  path: string,
): { found: true; value: JsonValue } | { found: false } {
  let current: JsonValue = root;
  const steps = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]/g;
  for (const step of path.slice(1).matchAll(steps)) {
    const [, name, index, quoted] = step;
    const key = name ?? (quoted === undefined ? undefined : (JSON.parse(quoted) as string));
    if (index !== undefined && Array.isArray(current) && Number(index) < current.length) {
      current = current[Number(index)] ?? null;
    } else if (key !== undefined && isObject(current) && Object.hasOwn(current, key)) {
      current = current[key] ?? null;
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}
