import { z } from 'zod';

// Contracts owned by later tasks. They are declared here so stage signatures are stable; each task
// replaces its placeholder with the real schema.

/**
 * Which routes and endpoints to probe. `skip` means the PR cannot change behavior (e.g. docs only)
 * and the run ends as `skipped`. TODO(SKR-24): define the rest of the schema.
 */
export const ImpactPlanSchema = z.looseObject({
  skip: z.strictObject({ reason: z.string().min(1) }).exactOptional(),
});
export type ImpactPlan = z.infer<typeof ImpactPlanSchema>;

/** What one page looked like in one probe run. TODO(SKR-25): define the schema. */
export const UiCaptureSchema = z.looseObject({});
export type UiCapture = z.infer<typeof UiCaptureSchema>;

/** One API response in one probe run. TODO(SKR-26): define the schema. */
export const ApiCaptureSchema = z.looseObject({});
export type ApiCapture = z.infer<typeof ApiCaptureSchema>;

/** LLM explanation of the findings. TODO(SKR-28): define the schema. */
export const InterpretationSchema = z.looseObject({});
export type Interpretation = z.infer<typeof InterpretationSchema>;
