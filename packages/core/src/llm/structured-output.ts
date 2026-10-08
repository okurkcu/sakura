import type { ZodType } from 'zod';

/** Outcome of reading a model's JSON answer. */
export type StructuredOutput<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly problem: string };

/** Longest validation problem quoted back to the model on retry. */
const MAX_PROBLEM_LENGTH = 2_000;

/**
 * Parses `text` as JSON and validates it with `schema`. On failure, `problem` explains what is
 * wrong in a form that can be shown to the model so it can correct its answer. Pure.
 */
export function parseStructuredOutput<T>(text: string, schema: ZodType<T>): StructuredOutput<T> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, problem: `The answer is not valid JSON (${reason}).` };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }
  const issues = parsed.error.issues
    .map(
      (issue) => `- ${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
    )
    .join('\n');
  return {
    ok: false,
    problem: `The JSON does not match the required schema:\n${issues}`.slice(0, MAX_PROBLEM_LENGTH),
  };
}
