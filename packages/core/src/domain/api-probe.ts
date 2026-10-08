import { z } from 'zod';

import { HttpMethodSchema } from './impact.js';
import { JsonValueSchema } from './json.js';
import { ProbeErrorSchema } from './probe-error.js';
import { ProbeRunSchema } from './stage.js';

/**
 * Where a request of the API probe comes from: `explicit` (a `bdiff.requests.json` file), `route`
 * (a static GET-like endpoint of the impact plan, sent without a body) or `generated` (proposed by
 * the LLM from the handler's source).
 */
export const ApiRequestSourceSchema = z.enum(['explicit', 'route', 'generated']);
export type ApiRequestSource = z.infer<typeof ApiRequestSourceSchema>;

/**
 * A path on the app itself, with its query. It starts with one `/` and never `//` or `/\`, which
 * URL parsers read as another host.
 */
export const AppPathSchema = z
  .string()
  .regex(/^\/(?![/\\])/, 'expected a path on the app, such as /api/orders?page=2');

/** A request body, as sent. */
export const ApiRequestBodySchema = z.strictObject({
  contentType: z.string().min(1),
  text: z.string(),
});
export type ApiRequestBody = z.infer<typeof ApiRequestBodySchema>;

/** One request of the API probe, sent identically to base and head. */
export const ApiRequestSchema = z.strictObject({
  /** Unique within a run, e.g. `POST /api/feedback` or `POST /api/feedback #2`; names artifacts. */
  key: z.string().min(1),
  source: ApiRequestSourceSchema,
  method: HttpMethodSchema,
  /** Path and query on the app, e.g. `/api/orders?page=2`. */
  path: AppPathSchema,
  /** Headers besides the fixed ones bdiff always sends; lower-case names. */
  headers: z.record(z.string(), z.string()),
  body: ApiRequestBodySchema.exactOptional(),
  /** What the request exercises, from the explicit file or the LLM. */
  description: z.string().min(1).exactOptional(),
  /** The impact endpoint the request exercises, e.g. `POST /api/feedback`. */
  endpoint: z.string().min(1).exactOptional(),
});
export type ApiRequest = z.infer<typeof ApiRequestSchema>;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'expected a hex SHA-256');

/**
 * A response body: parsed JSON when possible, else text, else the size of a binary body. Text and
 * JSON strings have the app's origin removed; `sha256` is over the stored text (raw bytes for
 * binary). `truncated` bodies were cut at the probe's size limit.
 */
export const ApiResponseBodySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('empty') }),
  z.strictObject({ kind: z.literal('json'), json: JsonValueSchema, sha256 }),
  z.strictObject({ kind: z.literal('text'), text: z.string(), sha256, truncated: z.boolean() }),
  z.strictObject({
    kind: z.literal('binary'),
    bytes: z.number().int().nonnegative(),
    sha256,
    truncated: z.boolean(),
  }),
]);
export type ApiResponseBody = z.infer<typeof ApiResponseBodySchema>;

/** What the app answered. */
export const ApiResponseSchema = z.strictObject({
  status: z.number().int(),
  contentType: z.string().nullable(),
  /** A fixed whitelist of headers that describe behavior (e.g. `location`), lower-case names. */
  headers: z.record(z.string(), z.string()),
  /** The answer was 401 or 403: the endpoint needs credentials bdiff does not have. */
  authRequired: z.boolean(),
  body: ApiResponseBodySchema,
});
export type ApiResponse = z.infer<typeof ApiResponseSchema>;

/** One request sent in one probe run: a response, or an error when none arrived. */
export const ApiCaptureSchema = z.strictObject({
  probeRun: ProbeRunSchema,
  /** `key` of the {@link ApiRequest}. */
  requestKey: z.string().min(1),
  durationMs: z.number().nonnegative(),
  /** JSON file with the request and what came back, from `ArtifactPaths.apiResponse`. */
  artifact: z.string().min(1),
  response: ApiResponseSchema.exactOptional(),
  error: ProbeErrorSchema.exactOptional(),
});
export type ApiCapture = z.infer<typeof ApiCaptureSchema>;

/** An endpoint of the impact plan the API probe could not build a request for. */
export const ApiNotProbedSchema = z.strictObject({
  /** e.g. `POST /api/feedback`. */
  endpoint: z.string().min(1),
  reason: z.literal('generation-failed'),
  /** The error code and message of the failed LLM call. */
  detail: z.string(),
});
export type ApiNotProbed = z.infer<typeof ApiNotProbedSchema>;

/** Output of the API probe: the request set, its captures on every probe run, and the gaps. */
export const ApiProbeSchema = z.strictObject({
  /** In the order they were sent in each probe run. */
  requests: z.array(ApiRequestSchema),
  captures: z.array(ApiCaptureSchema),
  notProbed: z.array(ApiNotProbedSchema),
});
export type ApiProbe = z.infer<typeof ApiProbeSchema>;
