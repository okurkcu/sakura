import { compactFindings } from './compact.js';
import { coverageOf, describeCoverage } from './coverage.js';
import type { Coverage } from './coverage.js';
import { resolveIntent } from './intent.js';
import { tierFor } from './routing.js';
import type { Exec } from '../adapters/exec.js';
import type { GitHubClient } from '../adapters/github.js';
import type { ApiProbe } from '../domain/api-probe.js';
import type { Finding } from '../domain/finding.js';
import type { ImpactPlan } from '../domain/impact.js';
import type { Interpretation } from '../domain/interpretation.js';
import type { Target } from '../domain/target.js';
import type { UiCapture } from '../domain/ui-capture.js';
import type { Workspace } from '../domain/workspace.js';
import type { LlmClient } from '../llm/llm-client.js';
import { interpretAnswerSchema, interpretPrompt } from '../llm/prompts/interpret.js';
import type { Stage } from '../pipeline/stage.js';
import { createGit } from '../workspace/git.js';

/** The summary of a run without findings: no LLM call is made for it. */
export const NO_FINDINGS_SUMMARY = 'No behavior changes observed in the probed surface.';

/** Most coverage gaps turned into checklist items when there are no findings. */
const MAX_CHECKLIST = 3;

/** Dependencies of the interpret stage. */
export interface InterpretStageDeps {
  readonly llm: LlmClient;
  /** Runs `git log` for the head commits' messages. */
  readonly exec: Exec;
  readonly github: GitHubClient;
}

/**
 * The interpret stage: asks the LLM to explain the findings and to flag those the pull request's
 * stated intent does not account for. It interprets observed evidence only: every finding id it
 * cites must exist (the answer's schema checks it, see `interpretAnswerSchema`). `fast` tier,
 * `smart` for breaking or many findings. Without findings it makes no LLM call and says so,
 * with what was and was not probed.
 */
export function createInterpretStage(deps: InterpretStageDeps): Stage<
  {
    target: Target;
    workspace: Workspace;
    impact: ImpactPlan;
    ui: UiCapture[];
    api: ApiProbe;
    findings: Finding[];
  },
  Interpretation
> {
  return {
    name: 'interpret',
    run: async ({ target, workspace, impact, ui, api, findings }, ctx) => {
      const coverage = coverageOf(impact, ui, api);
      if (findings.length === 0) {
        ctx.logger.info('no findings to interpret');
        return withoutFindings(coverage);
      }
      const intent = await resolveIntent(
        target,
        workspace,
        { github: deps.github, git: createGit(deps.exec, ctx.signal) },
        ctx,
      );
      const tier = tierFor(findings);
      const answer = await deps.llm.complete(
        interpretPrompt(
          {
            intent,
            changedFiles: workspace.changedFiles.map((file) =>
              file.status === 'renamed'
                ? `R ${file.oldPath} -> ${file.path}`
                : `${file.status[0]?.toUpperCase() ?? '?'} ${file.path}`,
            ),
            findings: compactFindings(findings),
            coverage,
            tier,
          },
          interpretAnswerSchema(findings.map((finding) => finding.id)),
        ),
        ctx,
      );
      const interpretation: Interpretation = {
        source: 'llm',
        ...answer.data,
        model: answer.usage.model,
      };
      ctx.logger.info('interpretation', {
        intentSource: intent.source,
        tier,
        model: interpretation.model ?? null,
        riskLevel: interpretation.riskLevel,
        summary: interpretation.summary.map((bullet) => bullet.text),
        unexpected: interpretation.unexpected.map((entry) => `${entry.findingId}: ${entry.reason}`),
      });
      return interpretation;
    },
  };
}

/** The deterministic interpretation of a run without findings. Pure. */
export function withoutFindings(coverage: Coverage): Interpretation {
  return {
    source: 'no-findings',
    summary: [{ text: NO_FINDINGS_SUMMARY, findingIds: [] }],
    unexpected: [],
    riskLevel: 'low',
    coverageNote: describeCoverage(coverage),
    reviewerChecklist: coverage.gaps
      .slice(0, MAX_CHECKLIST)
      .map((gap) => `Check ${gap.what} by hand: ${gap.reason}.`),
  };
}
