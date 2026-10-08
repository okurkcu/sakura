import { z } from 'zod';

/**
 * Every reason a run can fail. Codes are part of the run record and CSV, so they are stable:
 * add new ones, never rename. Tasks add the codes their stage needs.
 */
export const ErrorCodeSchema = z.enum([
  'SETUP_UNSUPPORTED',
  'SETUP_MISSING_ENV',
  'SETUP_BUILD_FAILED',
  'SETUP_TIMEOUT',
  'PROBE_TIMEOUT',
  'LLM_INVALID_OUTPUT',
  'BUDGET_EXCEEDED',
  'EXEC_TIMEOUT',
  'EXEC_FAILED',
  'GIT_FAILED',
  'FS_FAILED',
  'ABORTED',
  'INVALID_INPUT',
  'CONFIG_INVALID',
  'METRICS_CSV_MISMATCH',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
