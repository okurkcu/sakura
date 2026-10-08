import { HttpMethodSchema } from '../../domain/impact.js';
import type { HttpMethod } from '../../domain/impact.js';

const QUOTED_METHOD = /['"`](GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)['"`]/g;
/** Reads the request method: `req.method`, or `const { method } = req`. */
const READS_METHOD = /\.method\b|\{[^}]*\bmethod\b[^}]*\}\s*=/;

/**
 * The HTTP methods a Pages Router API handler checks for. Such a handler takes every method in one
 * function and branches on `req.method` (`req.method === 'POST'`, `case 'PUT':`,
 * `['DELETE'].includes(req.method)`), so every quoted method name in a source that reads the method
 * (`req.method`, `const { method } = req`) counts. Static, so an approximation; in
 * `HttpMethodSchema` order. Pure.
 */
export function pagesApiMethods(source: string): HttpMethod[] {
  if (!READS_METHOD.test(source)) {
    return [];
  }
  const found = new Set([...source.matchAll(QUOTED_METHOD)].map((match) => match[1]));
  return HttpMethodSchema.options.filter((method) => found.has(method));
}
