import { z } from 'zod';

/**
 * Every reason a run can fail. Codes are part of the run record and CSV, so they are stable:
 * add new ones, never rename. Tasks add the codes their stage needs.
 */
export const ErrorCodeSchema = z.enum([
  'SETUP_UNSUPPORTED',
  'SETUP_MISSING_ENV',
  'SETUP_INSTALL_FAILED',
  'SETUP_DB_FAILED',
  'SETUP_BUILD_FAILED',
  'SETUP_START_FAILED',
  'SETUP_PORT_CONFLICT',
  'DOCKER_UNAVAILABLE',
  'SETUP_TIMEOUT',
  'PROBE_TIMEOUT',
  'LLM_INVALID_OUTPUT',
  'LLM_REFUSED',
  'LLM_UNAVAILABLE',
  'LLM_REQUEST_FAILED',
  'BUDGET_EXCEEDED',
  'EXEC_TIMEOUT',
  'EXEC_FAILED',
  'GIT_FAILED',
  'REPO_UNSUPPORTED',
  'REF_NOT_FOUND',
  'NO_MERGE_BASE',
  'FS_FAILED',
  'HTTP_FAILED',
  'ABORTED',
  'RUN_TIMEOUT',
  'CLEANUP_FAILED',
  'INVALID_INPUT',
  'CONFIG_INVALID',
  'METRICS_CSV_MISMATCH',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
