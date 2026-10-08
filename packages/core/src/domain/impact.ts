import { z } from 'zod';

/** HTTP methods an API route can export. */
export const HttpMethodSchema = z.enum([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

/** A page or API route of the app, discovered from its file. */
export const RouteSchema = z.strictObject({
  /** URL path, e.g. `/login` or `/api/orders/[id]`. */
  path: z.string().startsWith('/'),
  kind: z.enum(['page', 'api']),
  /** For API routes: the method this entry is about. */
  method: HttpMethodSchema.exactOptional(),
  /** Route file, relative to the repository root. */
  file: z.string().min(1),
  /** True when the path has `[param]` segments, which the MVP cannot fill in. */
  dynamic: z.boolean(),
});
export type Route = z.infer<typeof RouteSchema>;

/** Why an affected route is not probed. */
export const NotProbedReasonSchema = z.enum(['dynamic-params', 'cap']);
export type NotProbedReason = z.infer<typeof NotProbedReasonSchema>;

/**
 * What a run probes. `skip` means the PR cannot change behavior (docs, tests, CI or lockfile
 * only) and the run ends as `skipped`.
 */
export const ImpactPlanSchema = z.strictObject({
  skip: z.strictObject({ reason: z.string().min(1) }).exactOptional(),
  /** Pages to probe. */
  pages: z.array(RouteSchema),
  /** API endpoints to probe. */
  endpoints: z.array(RouteSchema),
  /** Affected routes that are not probed, and why; shown in the report's coverage section. */
  notProbed: z.array(z.strictObject({ route: RouteSchema, reason: NotProbedReasonSchema })),
  /** `low` when nothing mapped and a fallback set of pages is probed instead. */
  confidence: z.enum(['high', 'medium', 'low']),
  /** Changed runtime files that no route depends on (config, assets, unresolved imports). */
  unmappedFiles: z.array(z.string()),
  notes: z.array(z.string()),
});
export type ImpactPlan = z.infer<typeof ImpactPlanSchema>;
