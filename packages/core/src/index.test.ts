import { describe, expect, it } from 'vitest';

import * as core from './index.js';
import type {
  ApiCapture,
  Box,
  ChangedFile,
  Clock,
  ErrorCode,
  Exec,
  ExecOptions,
  ExecResult,
  FailureRecord,
  FileSystem,
  Finding,
  FindingKind,
  FindingLocation,
  ImpactPlan,
  Interpretation,
  JsonObject,
  JsonValue,
  Logger,
  LogFields,
  LogLevel,
  ProbeRun,
  Recipe,
  RunningEnvironment,
  RunResult,
  Severity,
  Side,
  StageName,
  Target,
  UiCapture,
  Workspace,
} from './index.js';
import * as testing from './testing/index.js';

/** Compile-time check: every public type above is exported. Unused at runtime by design. */
export type PublicTypes = [
  ApiCapture,
  Box,
  ChangedFile,
  Clock,
  ErrorCode,
  Exec,
  ExecOptions,
  ExecResult,
  FailureRecord,
  FileSystem,
  Finding,
  FindingKind,
  FindingLocation,
  ImpactPlan,
  Interpretation,
  JsonObject,
  JsonValue,
  Logger,
  LogFields,
  LogLevel,
  ProbeRun,
  Recipe,
  RunningEnvironment,
  RunResult,
  Severity,
  Side,
  StageName,
  Target,
  UiCapture,
  Workspace,
];

describe('@bdiff/core public API', () => {
  it('exports its package name', () => {
    expect(core.CORE_PACKAGE_NAME).toBe('@bdiff/core');
  });

  it.each([
    'TargetSchema',
    'StageNameSchema',
    'SideSchema',
    'ProbeRunSchema',
    'ChangedFileSchema',
    'WorkspaceSchema',
    'FindingSchema',
    'RecipeSchema',
    'RunningEnvironmentSchema',
    'ImpactPlanSchema',
    'UiCaptureSchema',
    'ApiCaptureSchema',
    'InterpretationSchema',
    'RunResultSchema',
    'ErrorCodeSchema',
    'FailureRecordSchema',
    'BdiffError',
    'isBdiffError',
    'toFailureRecord',
    'abortError',
    'throwIfAborted',
    'createExecaExec',
    'createLogger',
    'systemClock',
    'nodeFileSystem',
    'SECRET_ENV_VARS',
  ])('exports %s', (name) => {
    expect(core).toHaveProperty(name);
  });

  it.each(['FakeClock', 'FakeExec', 'createTestLogger'])('testing entry exports %s', (name) => {
    expect(testing).toHaveProperty(name);
  });
});
