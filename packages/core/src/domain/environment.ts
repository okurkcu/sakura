import { z } from 'zod';

/** One side's app, running in its container and reachable from the host. */
export const SideEnvironmentSchema = z.strictObject({
  /** Base URL on the host, e.g. `http://127.0.0.1:55012`; only bound to the loopback interface. */
  url: z.url(),
  /** Compose service of the app, e.g. `app-head`. */
  service: z.string().min(1),
});
export type SideEnvironment = z.infer<typeof SideEnvironmentSchema>;

/** Base and head apps running in containers of one compose project, ready to be probed. */
export const RunningEnvironmentSchema = z.strictObject({
  /** Compose project name, `bdiff-<runId>`. */
  project: z.string().min(1),
  sides: z.strictObject({ base: SideEnvironmentSchema, head: SideEnvironmentSchema }),
});
export type RunningEnvironment = z.infer<typeof RunningEnvironmentSchema>;
