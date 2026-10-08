import { z } from 'zod';

// Contracts owned by later tasks. They are declared here so stage signatures are stable; each task
// replaces its placeholder with the real schema.

/** How to install, build and start a repo. TODO(SKR-21): define the schema. */
export const RecipeSchema = z.looseObject({});
export type Recipe = z.infer<typeof RecipeSchema>;

/** Base and head apps running in containers, with URLs to probe. TODO(SKR-22): define the schema. */
export const RunningEnvironmentSchema = z.looseObject({});
export type RunningEnvironment = z.infer<typeof RunningEnvironmentSchema>;

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
