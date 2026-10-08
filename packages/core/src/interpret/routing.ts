import type { Finding } from '../domain/finding.js';
import type { LlmTier } from '../llm/llm-client.js';

/** More findings than this go to the `smart` tier. */
export const SMART_TIER_FINDINGS = 15;

/**
 * The model tier that interprets `findings`: `smart` when any is breaking or there are many,
 * `fast` otherwise. Pure.
 */
export function tierFor(findings: readonly Finding[]): LlmTier {
  return findings.length > SMART_TIER_FINDINGS ||
    findings.some((finding) => finding.severity === 'breaking')
    ? 'smart'
    : 'fast';
}
