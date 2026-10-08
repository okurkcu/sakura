import { z } from 'zod';

const argv = z.array(z.string().min(1)).min(1);

/** Package managers bdiff can drive. */
export const PackageManagerNameSchema = z.enum(['npm', 'pnpm', 'yarn', 'bun']);
export type PackageManagerName = z.infer<typeof PackageManagerNameSchema>;

/** Where an environment variable value came from. */
export const EnvSourceSchema = z.enum(['default', 'example', 'generated']);
export type EnvSource = z.infer<typeof EnvSourceSchema>;

/** A backing service the app needs, run as its own container per side. */
export const RecipeServiceSchema = z.strictObject({
  kind: z.enum(['postgres', 'redis']),
  /** Docker image tag, e.g. `16`. */
  version: z.string().min(1),
  /** Environment variable that receives the service's connection URL, e.g. `DATABASE_URL`. */
  envVar: z.string().min(1),
});
export type RecipeService = z.infer<typeof RecipeServiceSchema>;

/**
 * How to install, build and start a repository's Next.js app. Commands are argv arrays, never shell
 * strings: `installCmd` runs in `installRoot`; `dbSetupCmds`, `buildCmd` and `startCmd` run in
 * `appRoot`. All of them run only inside containers.
 */
export const RecipeSchema = z.strictObject({
  /** Where dependencies are installed (the workspace root of a monorepo), relative to the repo. */
  installRoot: z.string().min(1),
  /** App directory relative to the repository root; `.` is the root. */
  appRoot: z.string().min(1),
  /** Node.js major version; the container image is `node:<nodeVersion>`. */
  nodeVersion: z.string().regex(/^\d+$/),
  packageManager: z.strictObject({
    name: PackageManagerNameSchema,
    version: z.string().min(1).exactOptional(),
  }),
  installCmd: argv,
  buildCmd: argv,
  startCmd: argv,
  port: z.number().int().min(1).max(65_535),
  /** Path polled until the app answers with a 2xx. */
  healthPath: z.string().startsWith('/'),
  env: z.record(z.string(), z.strictObject({ value: z.string(), source: EnvSourceSchema })),
  /** Keys whose example value is empty and could not be filled; the app may need them. */
  missingEnv: z.array(z.string()),
  services: z.array(RecipeServiceSchema),
  dbSetupCmds: z.array(argv),
  confidence: z.enum(['high', 'medium', 'low']),
  /** Why confidence is lower, and other observations, for the report and the repair loop. */
  notes: z.array(z.string()),
});
export type Recipe = z.infer<typeof RecipeSchema>;
