import { z } from 'zod';

/** Pipeline stages, in execution order. Used in run records, errors and log bindings. */
export const StageNameSchema = z.enum([
  'workspace',
  'recipe',
  'environment',
  'impact',
  'probe-ui',
  'probe-api',
  'diff',
  'interpret',
  'report',
  'metrics',
]);
export type StageName = z.infer<typeof StageNameSchema>;

/** One of the two versions of the code under comparison. */
export const SideSchema = z.enum(['base', 'head']);
export type Side = z.infer<typeof SideSchema>;

/**
 * One capture pass. `baseA` and `baseB` are two captures of the same base environment;
 * whatever differs between them is noise.
 */
export const ProbeRunSchema = z.enum(['baseA', 'baseB', 'head']);
export type ProbeRun = z.infer<typeof ProbeRunSchema>;
