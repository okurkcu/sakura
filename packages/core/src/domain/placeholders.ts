import { z } from 'zod';

// Contracts owned by later tasks. They are declared here so stage signatures are stable; each task
// replaces its placeholder with the real schema.

/** One API response in one probe run. TODO(SKR-26): define the schema. */
export const ApiCaptureSchema = z.looseObject({});
export type ApiCapture = z.infer<typeof ApiCaptureSchema>;

/** LLM explanation of the findings. TODO(SKR-28): define the schema. */
export const InterpretationSchema = z.looseObject({});
export type Interpretation = z.infer<typeof InterpretationSchema>;
