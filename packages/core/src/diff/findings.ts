import { createHash } from 'node:crypto';

import type { Finding, FindingKind, FindingLocation, Severity } from '../domain/finding.js';
import type { JsonValue } from '../domain/json.js';

/** A finding before it gets its id. */
export interface FindingDraft {
  readonly kind: FindingKind;
  readonly severity: Severity;
  readonly location: FindingLocation;
  readonly before?: JsonValue;
  readonly after?: JsonValue;
  readonly evidence: readonly (string | undefined)[];
  /** The API request it came from, so two requests to one endpoint get distinct ids. */
  readonly requestKey?: string;
}

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = { breaking: 0, warning: 1, info: 2 };

/**
 * A {@link Finding} with a stable id: the SHA-256 of its kind, location, values and request, in
 * canonical JSON. Evidence paths contain the run id, so they are left out: the same difference
 * gets the same id in every run. Missing evidence is dropped. Pure.
 */
export function toFinding(draft: FindingDraft): Finding {
  const identity = canonicalJson({
    kind: draft.kind,
    location: draft.location,
    before: draft.before ?? null,
    after: draft.after ?? null,
    request: draft.requestKey ?? null,
  });
  return {
    id: createHash('sha256').update(identity).digest('hex').slice(0, 16),
    kind: draft.kind,
    severity: draft.severity,
    location: draft.location,
    ...(draft.before === undefined ? {} : { before: draft.before }),
    ...(draft.after === undefined ? {} : { after: draft.after }),
    evidence: draft.evidence.filter((file): file is string => file !== undefined),
  };
}

/** Breaking first, then by place (route or endpoint, JSON path), kind and id. Pure. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  const place = (finding: Finding): string =>
    `${finding.location.route ?? ''}\u0000${finding.location.endpoint ?? ''}\u0000${finding.location.jsonPath ?? ''}`;
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      compareStrings(place(a), place(b)) ||
      compareStrings(a.kind, b.kind) ||
      compareStrings(a.id, b.id),
  );
}

/** Code-unit order: the same on every machine, unlike `localeCompare`. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** JSON with object keys sorted at every level, so equal values serialize equally. Pure. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'object' && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => compareStrings(a, b)))
      : inner,
  );
}
