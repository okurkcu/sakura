import { z } from 'zod';

import { RunningEnvironmentSchema } from '../domain/environment.js';
import { FindingSchema } from '../domain/finding.js';
import { ImpactPlanSchema } from '../domain/impact.js';
import { ApiCaptureSchema, InterpretationSchema, UiCaptureSchema } from '../domain/placeholders.js';
import { RecipeSchema } from '../domain/recipe.js';
import { WorkspaceSchema } from '../domain/workspace.js';
import { RunRecordSchema } from '../metrics/run-record.js';

/**
 * Everything a run produced: the record plus the output of every stage that completed. This is the
 * report's input. A stage output is absent when the run ended before that stage finished.
 */
export const RunResultSchema = z.strictObject({
  record: RunRecordSchema,
  workspace: WorkspaceSchema.exactOptional(),
  impact: ImpactPlanSchema.exactOptional(),
  recipe: RecipeSchema.exactOptional(),
  environment: RunningEnvironmentSchema.exactOptional(),
  ui: z.array(UiCaptureSchema).exactOptional(),
  api: z.array(ApiCaptureSchema).exactOptional(),
  findings: z.array(FindingSchema).exactOptional(),
  interpretation: InterpretationSchema.exactOptional(),
});
export type RunResult = z.infer<typeof RunResultSchema>;

/** The stage outputs of a {@link RunResult}, collected while the run progresses. */
export type StageOutputs = Omit<RunResult, 'record'>;
