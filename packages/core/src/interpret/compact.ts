import type { Finding } from '../domain/finding.js';
import type { JsonValue } from '../domain/json.js';

/** A finding as the model sees it: no evidence paths, short values. */
export interface CompactFinding {
  readonly id: string;
  readonly kind: Finding['kind'];
  readonly severity: Finding['severity'];
  /** `/login`, `GET /api/orders/latest $.total`, … */
  readonly where: string;
  readonly before?: JsonValue;
  readonly after?: JsonValue;
}

/** Longest serialized value kept as is; longer values become a cut string. */
const MAX_VALUE_CHARS = 300;

/**
 * The findings in the compact form the interpret prompt uses: evidence paths (which mean nothing
 * to the model) dropped, the bounding box left out, and long values cut. Pure.
 */
export function compactFindings(findings: readonly Finding[]): CompactFinding[] {
  return findings.map((finding) => {
    const { route, endpoint, jsonPath } = finding.location;
    const where = [route ?? endpoint, jsonPath].filter((part) => part !== undefined).join(' ');
    return {
      id: finding.id,
      kind: finding.kind,
      severity: finding.severity,
      where,
      ...(finding.before === undefined ? {} : { before: shorten(finding.before) }),
      ...(finding.after === undefined ? {} : { after: shorten(finding.after) }),
    };
  });
}

function shorten(value: JsonValue): JsonValue {
  const text = JSON.stringify(value);
  return text.length <= MAX_VALUE_CHARS ? value : `${text.slice(0, MAX_VALUE_CHARS)}… (cut)`;
}
