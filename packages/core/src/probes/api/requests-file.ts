import path from 'node:path';

import { z } from 'zod';

import type { FileSystem } from '../../adapters/file-system.js';
import { AppPathSchema } from '../../domain/api-probe.js';
import { HttpMethodSchema } from '../../domain/impact.js';
import { JsonValueSchema } from '../../domain/json.js';
import { BdiffError } from '../../errors/bdiff-error.js';

/** Name of the file that lists explicit API probe requests, in the app or repository root. */
export const REQUESTS_FILE = 'bdiff.requests.json';

/** Headers a requests file may not set: the host, cookies, and transport-level headers. */
const FORBIDDEN_HEADERS = new Set([
  'host',
  'cookie',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-connection',
]);

const headersSchema = z
  .record(z.string().regex(/^[A-Za-z0-9-]+$/, 'expected a header name'), z.string())
  .superRefine((headers, ctx) => {
    for (const name of Object.keys(headers)) {
      if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
        ctx.addIssue({ code: 'custom', message: `header "${name}" may not be set` });
      }
    }
  });

/** One request of a requests file. A body is either `json` or `text`, not both. */
export const ExplicitRequestSchema = z
  .strictObject({
    method: HttpMethodSchema,
    path: AppPathSchema,
    description: z.string().min(1).exactOptional(),
    headers: headersSchema.exactOptional(),
    json: JsonValueSchema.exactOptional(),
    text: z.string().exactOptional(),
  })
  .refine((request) => request.json === undefined || request.text === undefined, {
    message: 'a request has either a json or a text body, not both',
  });
export type ExplicitRequest = z.infer<typeof ExplicitRequestSchema>;

/** A `bdiff.requests.json` file: requests sent in order, before any other. */
export const RequestsFileSchema = z.strictObject({
  requests: z.array(ExplicitRequestSchema).max(50),
});

/**
 * Reads the explicit requests of a checkout: `bdiff.requests.json` in the app root, else in the
 * repository root. Returns no requests when neither exists.
 *
 * @throws BdiffError `CONFIG_INVALID` when the file is not valid JSON or does not match
 *   {@link RequestsFileSchema}.
 */
export async function loadExplicitRequests(
  fs: FileSystem,
  checkout: string,
  appRoot: string,
): Promise<ExplicitRequest[]> {
  // TODO(SKR-32): also take the requests of a dataset entry, ahead of the repository's file.
  const candidates = [
    ...new Set([path.join(checkout, appRoot, REQUESTS_FILE), path.join(checkout, REQUESTS_FILE)]),
  ];
  for (const file of candidates) {
    if (!(await fs.exists(file))) {
      continue;
    }
    const relative = path.relative(checkout, file);
    let json: unknown;
    try {
      json = JSON.parse(await fs.readFile(file));
    } catch (error) {
      throw new BdiffError('CONFIG_INVALID', `${relative} is not valid JSON`, {
        cause: error,
        details: { file: relative },
      });
    }
    const parsed = RequestsFileSchema.safeParse(json);
    if (!parsed.success) {
      throw new BdiffError('CONFIG_INVALID', `${relative} is invalid`, {
        details: {
          file: relative,
          issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        },
      });
    }
    return parsed.data.requests;
  }
  return [];
}
