import { z } from 'zod';

import { JsonValueSchema } from './json.js';

/** What kind of behavior difference a finding describes. */
export const FindingKindSchema = z.enum([
  'visual',
  'text',
  'runtime-error',
  'failed-request',
  'status-changed',
  'field-added',
  'field-removed',
  'type-changed',
  'value-changed',
  'content-type-changed',
]);
export type FindingKind = z.infer<typeof FindingKindSchema>;

/** How much a reviewer should care about a finding. */
export const SeveritySchema = z.enum(['info', 'warning', 'breaking']);
export type Severity = z.infer<typeof SeveritySchema>;

/** A rectangle on a screenshot, in CSS pixels. */
export const BoxSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type Box = z.infer<typeof BoxSchema>;

/** Where a finding was observed. */
export const FindingLocationSchema = z.object({
  route: z.string().min(1).exactOptional(),
  endpoint: z.string().min(1).exactOptional(),
  jsonPath: z.string().min(1).exactOptional(),
  bbox: BoxSchema.exactOptional(),
});
export type FindingLocation = z.infer<typeof FindingLocationSchema>;

/** One trustworthy behavior difference between base and head, after noise filtering. */
export const FindingSchema = z.object({
  /** Stable hash of the finding's content: same input, same id. */
  id: z.string().min(1),
  kind: FindingKindSchema,
  severity: SeveritySchema,
  location: FindingLocationSchema,
  before: JsonValueSchema.exactOptional(),
  after: JsonValueSchema.exactOptional(),
  /** Artifact paths (screenshots, overlays, response bodies) that prove the finding. */
  evidence: z.array(z.string().min(1)),
});
export type Finding = z.infer<typeof FindingSchema>;
