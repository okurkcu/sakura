import { z } from 'zod';

/** One bullet of the summary, with the findings it is about. */
export const SummaryBulletSchema = z.strictObject({
  text: z.string().min(1),
  findingIds: z.array(z.string().min(1)),
});
export type SummaryBullet = z.infer<typeof SummaryBulletSchema>;

/** A finding that does not match what the pull request says it does. */
export const UnexpectedFindingSchema = z.strictObject({
  findingId: z.string().min(1),
  /** One line: why it does not match the stated intent. */
  reason: z.string().min(1),
});
export type UnexpectedFinding = z.infer<typeof UnexpectedFindingSchema>;

/**
 * A reviewer-friendly reading of the findings, compared with the pull request's intent. Written
 * by the LLM (`source: 'llm'`) from observed evidence only, or deterministically when there is
 * nothing to interpret (`source: 'no-findings'`).
 */
export const InterpretationSchema = z.strictObject({
  source: z.enum(['llm', 'no-findings']),
  summary: z.array(SummaryBulletSchema).min(1).max(5),
  unexpected: z.array(UnexpectedFindingSchema),
  riskLevel: z.enum(['low', 'medium', 'high']),
  /** What the run did not verify. */
  coverageNote: z.string(),
  /** At most three things a human should still check. */
  reviewerChecklist: z.array(z.string().min(1)).max(3),
  /** The model that answered, for `source: 'llm'`. */
  model: z.string().min(1).exactOptional(),
});
export type Interpretation = z.infer<typeof InterpretationSchema>;
