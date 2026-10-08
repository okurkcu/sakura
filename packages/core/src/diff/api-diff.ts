import { diffJson } from './json-diff.js';
import type { ApiCapture, ApiResponse, ApiResponseBody } from '../domain/api-probe.js';
import type { FindingKind } from '../domain/finding.js';
import type { JsonValue } from '../domain/json.js';

/** One difference in how an endpoint answered. */
export interface ApiChange {
  readonly kind: FindingKind;
  readonly jsonPath?: string;
  readonly before?: JsonValue;
  readonly after?: JsonValue;
  /** The endpoint answered on base and gave no answer on head. */
  readonly noLongerAnswers?: boolean;
}

/** What changed in one request's answer, once noise is set aside. */
export interface ApiDiff {
  readonly changes: ApiChange[];
  readonly raw: number;
  readonly noise: number;
}

/** Headers compared besides the content type: they change what a client does next. */
const COMPARED_HEADERS = ['location', 'allow', 'www-authenticate', 'content-disposition'];
const TEXT_EXCERPT = 200;

/**
 * Compares head's answer to one request with baseA's; whatever already differs between baseA and
 * baseB is noise. One root cause gives one change: a request that stopped answering, a changed
 * status, or a changed content type is reported alone, without the body differences it causes.
 * Then headers, then the body (JSON by path, other bodies as a whole). Nothing is compared when
 * baseA or baseB got no answer: there is no reference or no noise baseline. Pure.
 */
export function diffApiCaptures(baseA: ApiCapture, baseB: ApiCapture, head: ApiCapture): ApiDiff {
  const a = baseA.response;
  const b = baseB.response;
  if (a === undefined || b === undefined) {
    return { changes: [], raw: 0, noise: 0 };
  }
  const h = head.response;
  if (h === undefined) {
    return one({
      kind: 'failed-request',
      before: { status: a.status },
      after: { error: head.error?.code ?? 'PROBE_FAILED' },
      noLongerAnswers: true,
    });
  }
  if (a.status !== h.status) {
    return a.status === b.status
      ? one({ kind: 'status-changed', before: a.status, after: h.status })
      : noiseOnly();
  }
  if (mediaType(a) !== mediaType(h)) {
    return mediaType(a) === mediaType(b)
      ? one({ kind: 'content-type-changed', before: mediaType(a), after: mediaType(h) })
      : noiseOnly();
  }
  const changes: ApiChange[] = [];
  let raw = 0;
  let noise = 0;
  for (const header of COMPARED_HEADERS) {
    const [av, bv, hv] = [a, b, h].map((response) => response.headers[header] ?? null);
    if (av !== hv) {
      raw += 1;
      if (av === bv) {
        changes.push({
          kind: 'value-changed',
          before: { [header]: av ?? null },
          after: { [header]: hv ?? null },
        });
      } else {
        noise += 1;
      }
    }
  }
  const body = diffBodies(a.body, b.body, h.body);
  return { changes: [...changes, ...body.changes], raw: raw + body.raw, noise: noise + body.noise };
}

function diffBodies(a: ApiResponseBody, b: ApiResponseBody, h: ApiResponseBody): ApiDiff {
  if (a.kind === 'json' && b.kind === 'json' && h.kind === 'json') {
    const json = diffJson(a.json, b.json, h.json);
    return {
      changes: json.changes.map((change) => ({
        kind: change.kind,
        jsonPath: change.path,
        ...(change.before === undefined ? {} : { before: change.before }),
        ...(change.after === undefined ? {} : { after: change.after }),
      })),
      raw: json.raw,
      noise: json.noise,
    };
  }
  if (a.kind !== h.kind) {
    return a.kind === b.kind
      ? one({ kind: 'type-changed', jsonPath: '$', before: a.kind, after: h.kind })
      : noiseOnly();
  }
  if (identity(a) === identity(h)) {
    return { changes: [], raw: 0, noise: 0 };
  }
  return identity(a) === identity(b)
    ? one({ kind: 'value-changed', jsonPath: '$', before: excerpt(a), after: excerpt(h) })
    : noiseOnly();
}

function one(change: ApiChange): ApiDiff {
  return { changes: [change], raw: 1, noise: 0 };
}

function noiseOnly(): ApiDiff {
  return { changes: [], raw: 1, noise: 1 };
}

/** `application/json` from `application/json; charset=utf-8`. */
function mediaType(response: ApiResponse): string | null {
  return response.contentType?.split(';')[0]?.trim().toLowerCase() ?? null;
}

function identity(body: ApiResponseBody): string {
  return body.kind === 'empty' ? 'empty' : `${body.kind}:${body.sha256}`;
}

function excerpt(body: ApiResponseBody): JsonValue {
  switch (body.kind) {
    case 'empty':
      return null;
    case 'json':
      return body.json;
    case 'text':
      return body.text.length > TEXT_EXCERPT ? `${body.text.slice(0, TEXT_EXCERPT)}…` : body.text;
    case 'binary':
      return { bytes: body.bytes, sha256: body.sha256 };
  }
}
