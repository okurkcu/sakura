import { z } from 'zod';

/**
 * How a run uses the LLM:
 * - `on`: the real model (needs `ANTHROPIC_API_KEY`);
 * - `off`: no LLM; the stages that need it are skipped (interpretation, setup repair) or degrade
 *   (generated API requests are not probed), findings stay complete;
 * - `fake`: canned answers from {@link createCannedLlmClient}, so the whole report can be seen
 *   without a key. Nothing it says comes from a model.
 */
export const LlmModeSchema = z.enum(['on', 'off', 'fake']);
export type LlmMode = z.infer<typeof LlmModeSchema>;

/** The mode chosen for a run and whether it was chosen for the user. */
export interface ResolvedLlmMode {
  readonly mode: LlmMode;
  /** `true` when no mode was asked for and `off` was picked because there is no API key. */
  readonly defaulted: boolean;
}

/**
 * The mode a run uses: the one asked for, else `on` when an API key is set, else `off`. Pure.
 *
 * @param requested the `--llm` value, if given.
 * @param hasApiKey whether `ANTHROPIC_API_KEY` is set (non-empty).
 */
export function resolveLlmMode(
  requested: LlmMode | undefined,
  hasApiKey: boolean,
): ResolvedLlmMode {
  if (requested !== undefined) {
    return { mode: requested, defaulted: false };
  }
  return hasApiKey ? { mode: 'on', defaulted: false } : { mode: 'off', defaulted: true };
}
