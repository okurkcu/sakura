import { z } from 'zod';

import { PackageManagerNameSchema } from './recipe.js';
import type { Recipe } from './recipe.js';
import { SideSchema } from './stage.js';
import type { Side } from './stage.js';
import type { Workspace } from './workspace.js';

const argv = z.array(z.string().min(1).max(500)).min(1).max(30);

/** Name of an environment variable the patch may set. */
export const EnvNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/);

/**
 * A change to a `Recipe` proposed by the setup repair loop. It is data, never shell text: a
 * field that is `null` stays as it is. Commands are argv arrays and are checked against the command
 * allowlist before the patch is applied.
 */
export const RecipePatchSchema = z.strictObject({
  /** Why this patch should fix the failure, in one or two sentences. */
  reason: z.string().min(1).max(500),
  /** Environment variables to set (added or overwritten). */
  env: z.array(z.strictObject({ name: EnvNameSchema, value: z.string().max(2_000) })).max(30),
  nodeVersion: z
    .string()
    .regex(/^\d{2}$/)
    .nullable(),
  packageManager: PackageManagerNameSchema.nullable(),
  installCmd: argv.nullable(),
  buildCmd: argv.nullable(),
  startCmd: argv.nullable(),
  /** Replaces every database setup command; `[]` removes them. */
  dbSetupCmds: z.array(argv).max(5).nullable(),
  appRoot: z.string().min(1).max(200).nullable(),
  port: z.number().int().min(1).max(65_535).nullable(),
  healthPath: z.string().startsWith('/').max(200).nullable(),
});
export type RecipePatch = z.infer<typeof RecipePatchSchema>;

/** What happened to one repair attempt. */
export const SetupAttemptOutcomeSchema = z.enum([
  /** The patched recipe started both apps. */
  'repaired',
  /** The patched recipe was tried and setup failed again (`errorCode`). */
  'setup-failed',
  /** The patch broke the rules (disallowed command, bad path…) and was not tried (`problem`). */
  'rejected',
  /** No patch: the LLM call failed (`errorCode`). */
  'no-patch',
]);
export type SetupAttemptOutcome = z.infer<typeof SetupAttemptOutcomeSchema>;

/** One attempt of the setup repair loop, as recorded in `run.json`. */
export const SetupAttemptSchema = z.strictObject({
  /** 1-based. */
  attempt: z.number().int().min(1),
  /** The failure that started this attempt. */
  trigger: z.strictObject({
    stage: z.enum(['recipe', 'environment']),
    code: z.string().min(1),
    side: SideSchema.exactOptional(),
  }),
  tier: z.enum(['fast', 'smart']),
  patch: RecipePatchSchema.nullable(),
  outcome: SetupAttemptOutcomeSchema,
  /** The error code of a failed retry or LLM call. */
  errorCode: z.string().min(1).exactOptional(),
  /** Why a patch was rejected. */
  problem: z.string().min(1).exactOptional(),
  /** LLM cost of this attempt, retries included. */
  costUsd: z.number().nonnegative(),
});
export type SetupAttempt = z.infer<typeof SetupAttemptSchema>;

/** The setup failure a repair attempt answers. */
export interface SetupFailure {
  /** `recipe` when detection found no recipe, `environment` when the apps did not start. */
  readonly stage: 'recipe' | 'environment';
  readonly code: string;
  readonly message: string;
  /** The side whose container failed. */
  readonly side?: Side;
}

/** Input of the repair stage's `propose` step. */
export interface RepairRequest {
  readonly workspace: Workspace;
  /** The recipe that failed; `null` when detection found none. */
  readonly recipe: Recipe | null;
  readonly failure: SetupFailure;
  /** 1-based. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** This run's earlier attempts, oldest first. */
  readonly previousAttempts: readonly SetupAttempt[];
}

/** What the repair stage proposes: a patched recipe to try, or a patch that broke the rules. */
export type RepairProposal =
  | {
      readonly kind: 'patched';
      readonly recipe: Recipe;
      readonly patch: RecipePatch;
      readonly tier: LlmTierName;
    }
  | {
      readonly kind: 'rejected';
      readonly patch: RecipePatch;
      readonly problems: readonly string[];
      readonly tier: LlmTierName;
    };

/** The model tier an attempt used. */
export type LlmTierName = SetupAttempt['tier'];

/** The model tier of a repair attempt: `fast`, and `smart` for the last one. Pure. */
export function repairTier(attempt: number, maxAttempts: number): LlmTierName {
  return attempt >= maxAttempts ? 'smart' : 'fast';
}
