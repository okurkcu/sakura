import { INTERPRET_PURPOSE } from '@bdiff/core';
import type { Finding, InterpretAnswer, PipelineStages } from '@bdiff/core';
import type { FakeLlmClient } from '@bdiff/core/testing';

/**
 * A valid interpretation of `findings`, standing in for the model's: it cites every finding and
 * flags the breaking ones as unexpected.
 */
export function scriptedInterpretation(findings: readonly Finding[]): InterpretAnswer {
  const ids = findings.map((finding) => finding.id);
  const breaking = findings.filter((finding) => finding.severity === 'breaking');
  return {
    summary: [
      { text: 'Scripted summary of every finding.', findingIds: ids },
      { text: 'Scripted note on the first finding.', findingIds: ids.slice(0, 1) },
    ],
    unexpected: breaking.map((finding) => ({
      findingId: finding.id,
      reason: 'Scripted: breaking changes are flagged.',
    })),
    riskLevel: breaking.length > 0 ? 'high' : 'low',
    coverageNote: 'Scripted coverage note.',
    reviewerChecklist: [],
  };
}

/**
 * `stages` with a diff stage that, once it found the findings, scripts `llm` to answer the
 * interpret call with {@link scriptedInterpretation} of them. `onFindings` sees the findings.
 */
export function withScriptedInterpretation(
  stages: PipelineStages,
  llm: FakeLlmClient,
  onFindings: (findings: Finding[]) => void = () => undefined,
): PipelineStages {
  return {
    ...stages,
    diff: {
      name: 'diff',
      run: async (input, ctx) => {
        const findings = await stages.diff.run(input, ctx);
        llm.on(INTERPRET_PURPOSE, scriptedInterpretation(findings));
        onFindings(findings);
        return findings;
      },
    },
  };
}
