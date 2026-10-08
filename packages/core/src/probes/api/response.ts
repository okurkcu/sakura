import { createHash } from 'node:crypto';

import type { HttpExchangeResponse } from '../../adapters/http.js';
import type { ApiResponse, ApiResponseBody } from '../../domain/api-probe.js';
import type { JsonValue } from '../../domain/json.js';
import { appRelativeUrl, stripOrigin } from '../ui/normalize.js';

/** Response headers kept in a capture: they describe behavior, unlike dates, ids or cookies. */
export const RESPONSE_HEADERS: readonly string[] = [
  'allow',
  'cache-control',
  'content-disposition',
  'content-language',
  'content-type',
  'location',
  'vary',
  'www-authenticate',
];

const TEXTUAL_TYPE = /^text\/|json|xml|javascript|x-www-form-urlencoded|graphql/i;
const JSON_TYPE = /[/+]json\b/i;

/**
 * Turns a raw response into an {@link ApiResponse}: keeps the whitelisted headers, decodes the body
 * (JSON when it parses, else UTF-8 text, else binary) and removes the app's origin from headers and
 * text, since base and head run on different ports. Pure.
 */
export function toApiResponse(raw: HttpExchangeResponse, origin: string): ApiResponse {
  const contentType = raw.headers['content-type'] ?? null;
  const headers: Record<string, string> = {};
  for (const name of RESPONSE_HEADERS) {
    const value = raw.headers[name];
    if (value !== undefined) {
      headers[name] =
        name === 'location' ? appRelativeUrl(value, origin) : stripOrigin(value, origin);
    }
  }
  return {
    status: raw.status,
    contentType,
    headers,
    authRequired: raw.status === 401 || raw.status === 403,
    body: toBody(raw, contentType, origin),
  };
}

function toBody(
  raw: HttpExchangeResponse,
  contentType: string | null,
  origin: string,
): ApiResponseBody {
  if (raw.body.byteLength === 0) {
    return { kind: 'empty' };
  }
  const decoded =
    contentType === null || TEXTUAL_TYPE.test(contentType) ? decode(raw.body) : undefined;
  if (decoded === undefined) {
    return {
      kind: 'binary',
      bytes: raw.body.byteLength,
      sha256: sha256(raw.body),
      truncated: raw.truncated,
    };
  }
  const text = stripOrigin(decoded, origin);
  if (
    !raw.truncated &&
    ((contentType !== null && JSON_TYPE.test(contentType)) || /^\s*[[{]/.test(text))
  ) {
    const json = parseJson(text);
    if (json !== undefined) {
      return { kind: 'json', json, sha256: sha256(text) };
    }
  }
  return { kind: 'text', text, sha256: sha256(text), truncated: raw.truncated };
}

/** UTF-8 text, or `undefined` for bytes that are not valid UTF-8. */
function decode(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
