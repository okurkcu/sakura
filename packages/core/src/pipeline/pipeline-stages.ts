import type { RunResult } from './run-result.js';
import type { Stage } from './stage.js';
import type { Finding } from '../domain/finding.js';
import type {
  ApiCapture,
  ImpactPlan,
  Interpretation,
  Recipe,
  RunningEnvironment,
  UiCapture,
} from '../domain/placeholders.js';
import type { Target } from '../domain/target.js';
import type { Workspace } from '../domain/workspace.js';

/**
 * Every stage of a run, keyed by role. Each later task replaces one stub with a real
 * implementation; the orchestrator's flow stays the same.
 */
export interface PipelineStages {
  readonly workspace: Stage<Target, Workspace>;
  readonly impact: Stage<{ workspace: Workspace }, ImpactPlan>;
  readonly recipe: Stage<{ workspace: Workspace }, Recipe>;
  readonly environment: Stage<{ workspace: Workspace; recipe: Recipe }, RunningEnvironment>;
  readonly probeUi: Stage<{ environment: RunningEnvironment; impact: ImpactPlan }, UiCapture[]>;
  readonly probeApi: Stage<{ environment: RunningEnvironment; impact: ImpactPlan }, ApiCapture[]>;
  readonly diff: Stage<{ impact: ImpactPlan; ui: UiCapture[]; api: ApiCapture[] }, Finding[]>;
  readonly interpret: Stage<
    { target: Target; workspace: Workspace; impact: ImpactPlan; findings: Finding[] },
    Interpretation
  >;
  /** Runs after every run, including failed and skipped ones. */
  readonly report: Stage<RunResult, void>;
}
