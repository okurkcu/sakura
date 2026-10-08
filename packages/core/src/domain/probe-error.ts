import { z } from 'zod';

/**
 * Why one page or request of a probe could not be captured. The probe goes on; the capture
 * carries the error.
 */
export const ProbeErrorSchema = z.strictObject({
  code: z.enum(['PROBE_TIMEOUT', 'PROBE_FAILED']),
  message: z.string(),
});
export type ProbeError = z.infer<typeof ProbeErrorSchema>;
