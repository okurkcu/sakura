import type { RunResult } from './run-result.js';
import type { Stage } from './stage.js';
import type { ApiProbe } from '../domain/api-probe.js';
import type { RunningEnvironment } from '../domain/environment.js';
import type { Finding } from '../domain/finding.js';
import type { ImpactPlan } from '../domain/impact.js';
import type { Interpretation } from '../domain/interpretation.js';
import type { Recipe } from '../domain/recipe.js';
import type { RepairProposal, RepairRequest } from '../domain/setup-repair.js';
import type { Target } from '../domain/target.js';
import type { UiCapture } from '../domain/ui-capture.js';
import type { Workspace } from '../domain/workspace.js';

/** Every stage of a run, keyed by role. */
export interface PipelineStages {
  readonly workspace: Stage<Target, Workspace>;
  readonly impact: Stage<{ workspace: Workspace }, ImpactPlan>;
  readonly recipe: Stage<{ workspace: Workspace }, Recipe>;
  readonly environment: Stage<{ workspace: Workspace; recipe: Recipe }, RunningEnvironment>;
  /**
   * Setup repair: `propose` turns a setup failure into a patched recipe to try; `keep` saves a
   * patched recipe that worked. The orchestrator runs the loop (see `runSetup`).
   */
  readonly repair: {
    readonly propose: Stage<RepairRequest, RepairProposal>;
    readonly keep: Stage<{ workspace: Workspace; recipe: Recipe }, void>;
  };
  readonly probeUi: Stage<{ environment: RunningEnvironment; impact: ImpactPlan }, UiCapture[]>;
  readonly probeApi: Stage<
    { workspace: Workspace; recipe: Recipe; environment: RunningEnvironment; impact: ImpactPlan },
    ApiProbe
  >;
  readonly diff: Stage<{ impact: ImpactPlan; ui: UiCapture[]; api: ApiProbe }, Finding[]>;
  readonly interpret: Stage<
    {
      target: Target;
      workspace: Workspace;
      impact: ImpactPlan;
      ui: UiCapture[];
      api: ApiProbe;
      findings: Finding[];
    },
    Interpretation
  >;
  /** Runs after every run, including failed and skipped ones. */
  readonly report: Stage<RunResult, void>;
}
