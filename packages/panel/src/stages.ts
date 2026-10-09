import type { StageName } from '@bdiff/core';

/**
 * The stages the panel draws, in pipeline order (`metrics` is bookkeeping, not a stage). Pure
 * data, shared by the server and the web UI.
 */
export const PANEL_STAGES: readonly StageName[] = [
  'workspace',
  'impact',
  'recipe',
  'environment',
  'repair',
  'probe-ui',
  'probe-api',
  'diff',
  'interpret',
  'report',
];
