import type { PipelineStages } from './pipeline-stages.js';
import type { Stage } from './stage.js';
import type { RunningEnvironment } from '../domain/environment.js';
import type { Recipe } from '../domain/recipe.js';
import { repairTier } from '../domain/setup-repair.js';
import type { SetupAttempt, SetupFailure } from '../domain/setup-repair.js';
import type { Workspace } from '../domain/workspace.js';
import { isBdiffError } from '../errors/bdiff-error.js';
import type { ErrorCode } from '../errors/codes.js';

/** Most repair attempts in one run. */
export const MAX_SETUP_ATTEMPTS = 3;

/** Failures the repair loop answers, per stage. */
const REPAIRABLE: Readonly<Record<SetupFailure['stage'], ReadonlySet<ErrorCode>>> = {
  recipe: new Set(['SETUP_UNSUPPORTED']),
  environment: new Set([
    'SETUP_INSTALL_FAILED',
    'SETUP_DB_FAILED',
    'SETUP_BUILD_FAILED',
    'SETUP_START_FAILED',
    'SETUP_TIMEOUT',
  ]),
};
/** Repair call failures that end the loop: another attempt cannot get a patch either. */
const FINAL_REPAIR_ERRORS: ReadonlySet<ErrorCode> = new Set([
  'LLM_UNAVAILABLE',
  'LLM_REFUSED',
  'BUDGET_EXCEEDED',
]);
/** Repair call failures that cost an attempt; the next one may succeed. */
const RETRYABLE_REPAIR_ERRORS: ReadonlySet<ErrorCode> = new Set([
  'LLM_INVALID_OUTPUT',
  'LLM_REQUEST_FAILED',
]);

/** What {@link runSetup} needs from the orchestrator. */
export interface SetupLoopDeps {
  readonly stages: Pick<PipelineStages, 'recipe' | 'environment' | 'repair'>;
  /** Runs (and times) one stage, as the orchestrator does for every stage. */
  readonly runStage: <I, O>(stage: Stage<I, O>, input: I) => Promise<O>;
  /** The run's LLM spend so far, to price each attempt. */
  readonly spentUsd: () => number;
  /** Receives the attempts after every change, for the run record. */
  readonly onAttempts: (attempts: readonly SetupAttempt[]) => void;
  readonly maxAttempts?: number;
}

/** How setup ended: running apps, or the setup failure the loop could not repair. */
export type SetupResult =
  | { readonly ok: true; readonly recipe: Recipe; readonly environment: RunningEnvironment }
  | {
      readonly ok: false;
      /** The last setup failure (never a repair call's own error). */
      readonly error: unknown;
      readonly stage: SetupFailure['stage'];
      /** The last recipe tried; `null` when there never was one. */
      readonly recipe: Recipe | null;
    };

/**
 * Detects the recipe and starts the environment, repairing setup failures with the LLM:
 * `recipe → environment`, and after a repairable failure (`SETUP_UNSUPPORTED` from detection,
 * install/db/build/start/timeout from the environment) `repair.propose → environment` again, at
 * most {@link MAX_SETUP_ATTEMPTS} attempts. A rejected patch, or an invalid or failed repair call,
 * costs an attempt; no credentials, a refusal or a spent budget end the loop. When the apps start
 * with a patched recipe, `repair.keep` caches it. Every attempt goes to `onAttempts`.
 *
 * A setup failure the loop could not repair comes back as `ok: false` with the last setup error, so
 * a run without LLM access fails exactly as it would without the loop. Other errors (abort,
 * Docker unavailable, I/O) are thrown.
 */
export async function runSetup(workspace: Workspace, deps: SetupLoopDeps): Promise<SetupResult> {
  const { stages, runStage } = deps;
  const maxAttempts = deps.maxAttempts ?? MAX_SETUP_ATTEMPTS;
  const attempts: SetupAttempt[] = [];
  const record = (attempt: SetupAttempt): void => {
    attempts.push(attempt);
    deps.onAttempts(attempts);
  };

  /** Either a recipe to try, or the failure to repair (with the last recipe, if any). */
  let state:
    | { readonly kind: 'try'; readonly recipe: Recipe }
    | {
        readonly kind: 'repair';
        readonly recipe: Recipe | null;
        readonly error: unknown;
        readonly failure: SetupFailure;
      };
  try {
    state = { kind: 'try', recipe: await runStage(stages.recipe, { workspace }) };
  } catch (error) {
    state = { kind: 'repair', recipe: null, error, failure: repairable(error, 'recipe') };
  }

  /** The attempt whose patched recipe is being tried. */
  let trying: Omit<SetupAttempt, 'outcome'> | undefined;
  for (;;) {
    if (state.kind === 'try') {
      const { recipe } = state;
      try {
        const environment = await runStage(stages.environment, { workspace, recipe });
        if (trying !== undefined) {
          record({ ...trying, outcome: 'repaired' });
          await runStage(stages.repair.keep, { workspace, recipe });
        }
        return { ok: true, recipe, environment };
      } catch (error) {
        if (trying !== undefined) {
          const code = isBdiffError(error) ? error.code : 'INTERNAL';
          record({ ...trying, outcome: 'setup-failed', errorCode: code });
          trying = undefined;
        }
        state = { kind: 'repair', recipe, error, failure: repairable(error, 'environment') };
      }
    }
    const { recipe, error: setupError, failure } = state;
    const gaveUp: SetupResult = { ok: false, error: setupError, stage: failure.stage, recipe };
    if (attempts.length >= maxAttempts) {
      return gaveUp;
    }

    const attempt = attempts.length + 1;
    const spentBefore = deps.spentUsd();
    const base = {
      attempt,
      trigger: {
        stage: failure.stage,
        code: failure.code,
        ...(failure.side === undefined ? {} : { side: failure.side }),
      },
      tier: repairTier(attempt, maxAttempts),
    };
    const cost = (): number => Math.max(0, deps.spentUsd() - spentBefore);
    let proposal;
    try {
      proposal = await runStage(stages.repair.propose, {
        workspace,
        recipe,
        failure,
        attempt,
        maxAttempts,
        previousAttempts: [...attempts],
      });
    } catch (error) {
      const code = isBdiffError(error) ? error.code : undefined;
      if (
        code === undefined ||
        !(FINAL_REPAIR_ERRORS.has(code) || RETRYABLE_REPAIR_ERRORS.has(code))
      ) {
        throw error;
      }
      record({ ...base, patch: null, outcome: 'no-patch', errorCode: code, costUsd: cost() });
      if (FINAL_REPAIR_ERRORS.has(code)) {
        return gaveUp;
      }
      continue;
    }
    if (proposal.kind === 'rejected') {
      record({
        ...base,
        patch: proposal.patch,
        outcome: 'rejected',
        problem: proposal.problems.join('; '),
        costUsd: cost(),
      });
      continue;
    }
    trying = { ...base, patch: proposal.patch, costUsd: cost() };
    state = { kind: 'try', recipe: proposal.recipe };
  }
}

/**
 * The setup failure behind `error`, if the loop can repair it; otherwise rethrows `error`, which
 * then fails the run as usual.
 */
function repairable(error: unknown, stage: SetupFailure['stage']): SetupFailure {
  if (!isBdiffError(error) || !REPAIRABLE[stage].has(error.code)) {
    throw error;
  }
  const side = error.details.side;
  return {
    stage,
    code: error.code,
    message: error.message,
    ...(side === 'base' || side === 'head' ? { side } : {}),
  };
}
