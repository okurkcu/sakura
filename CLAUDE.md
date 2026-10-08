# bdiff

**bdiff runs the base and head versions of a pull request side by side, exercises them identically, and shows how the software's behavior changed**: what pages look like, what visible text changed, what API responses changed and what new runtime errors appear. _Others interpret what the code says. We show what the software does._

The MVP is a **CLI** that we run against real open-source Next.js PRs to measure setup success rate, run time, cost per PR, false-difference rate after noise filtering, and how often the behavior diff reveals something the code diff hides.

Work is tracked in Jira: project **SKR**, epic **SKR-14**, tasks SKR-15 → SKR-34 (`[01]` … `[20]`), done in order and respecting each task's "Depends on". Run one task with `/work-issue SKR-<n>`.

**Out of scope for the MVP (do not build):** web app, GitHub App, agent/MCP integration, database/performance probes, hosted sandboxes, Rust, dynamic route parameters, authentication flows.

## Commands

| Command              | What it does                                                         |
| -------------------- | -------------------------------------------------------------------- |
| `pnpm install`       | Install dependencies (Node ≥ 22.12, pnpm via corepack).              |
| `pnpm check`         | **lint + typecheck + test. Must be green before a task is done.**    |
| `pnpm lint`          | ESLint (zero warnings allowed) and Prettier check.                   |
| `pnpm typecheck`     | `tsc` over root tooling files and every package, tests included.     |
| `pnpm test`          | Vitest, all projects. `pnpm vitest run --project core` for just one. |
| `pnpm test:coverage` | Vitest with v8 coverage.                                             |
| `pnpm test:docker`   | `*.docker.test.ts` integration tests; needs a running Docker daemon. |
| `pnpm bdiff run …`   | Runs the CLI from source; flags and exit codes in `docs/cli.md`.     |
| `pnpm fixture:build` | Builds the fixture git repo in a temp dir and prints its path.       |
| `pnpm build`         | `tsc -b tsconfig.build.json` (project references) into `dist/`.      |
| `pnpm format`        | Prettier write.                                                      |

## Architecture

```
packages/
  core/      Engine. Domain types, pipeline, stages, adapters behind interfaces.
             MUST NOT import from cli/ or report/ (enforced by ESLint).
  report/    Renders a RunResult into static, self-contained HTML. Depends only on core types.
  cli/       commander entry point. The ONLY composition root: builds real adapters, injects them into core.
fixtures/                 @bdiff/fixtures workspace package
  sample-next-app/        Small Next.js app (ground truth); its own project, not linted by us
  branches/<name>/        Files each PR branch adds or replaces on top of main
  branches.ts             PR branch definitions
  build-fixture-repo.ts   Builds a deterministic git repo with known PR branches
  expected.json           Expected changed files, impact + findings per branch (ExpectedSchema)
scripts/                  Dev scripts (dataset builder)
e2e/                      @bdiff/e2e: stage integration and end-to-end tests over the fixture (real git)
tests/                    Repo-level tooling tests (e.g. package boundaries)
```

Suggested `packages/core/src` layout:

```
domain/        types + zod schemas
errors/        BdiffError, failure records
adapters/      exec, fs, clock, logger (interfaces + real impls)
testing/       fakes: FakeExec, FakeClock, FakeLlmClient, builders
metrics/       RunRecord, StageTimer, CostCalculator, MetricsStore, ArtifactPaths
pipeline/      Stage interface, runPipeline, cleanup registry
workspace/     repo cache, worktrees, changed files
recipe/        detectors, recipe cache, repair/ (LLM fallback)
environment/   compose generation, container lifecycle, health checks
impact/        route discovery, import graph, skip rules
probes/ui/     Playwright capture
probes/api/    request set + replay
diff/          visual, text, runtime-signal and API diff, noise filter, findings
llm/           LlmClient, prompts/
interpret/     findings → explanation
```

### Pipeline

```
main chain (stops at the first error):
  workspace → impact ─(skip? stop)→ recipe → environment(base, head)
    → probe-ui(baseA, baseB, head) → probe-api(baseA, baseB, head) → diff + noise filter → interpret (LLM)
finalization (always, also after failure, skip, abort or timeout):
  cleanup hooks (LIFO) → report → final record → run.json + results.csv (metrics)
```

- `runPipeline(target, stages, deps)` in `packages/core/src/pipeline` is the orchestrator; `PipelineStages` types every stage's input and output. Each stage task replaces one stub from `createStubStages()` in the CLI composition root; the flow stays the same.
- Each stage: typed input → typed output. Stages never call each other; only the orchestrator sequences them.
- Impact runs right after the workspace so a skipped PR (docs only, tests only) never builds containers.
- The report runs in finalization so failed and skipped runs get a report too; it receives `RunResult` with a preview of the record. A failing report fails an otherwise successful run (stage `report`); a failing cleanup hook fails it with `CLEANUP_FAILED`.
- `baseA` and `baseB` are two captures of the **same base environment**. Anything that differs between them is noise and is masked when comparing base vs head.
- The orchestrator measures each stage, stops on first error, always runs cleanup hooks (LIFO), and always writes a run record — success, failure or skip. A run timeout (`RUN_TIMEOUT`) or Ctrl+C (`ABORTED`) aborts the stage in progress through `ctx.signal`; a stage that ignores the signal is abandoned, and its resources are released by its cleanup hooks.

### Core contracts (shape, refine as needed)

```ts
interface Stage<I, O> {
  name: StageName;
  run(input: I, ctx: StageContext): Promise<O>;
}

interface StageContext {
  runId: RunId;
  target: Target;
  logger: Logger; // bound to run and stage
  clock: Clock;
  paths: ArtifactPaths;
  signal: AbortSignal; // run timeout, Ctrl+C
  budget: Budget; // LLM spend cap per run: call budget.assertAvailable() before every LLM call
  onCleanup(name: string, hook: (signal: AbortSignal) => Promise<void>): void;
  recordLlmUsage(purpose: string, usage: TokenUsage): LlmUsage;
  addCounts(counts: Partial<RunCounts>): void;
  setComputeSeconds(side: Side, seconds: number): void;
}

type ProbeRun = 'baseA' | 'baseB' | 'head';

interface Finding {
  id: string; // stable hash
  kind:
    | 'visual'
    | 'text'
    | 'runtime-error'
    | 'failed-request'
    | 'status-changed'
    | 'field-added'
    | 'field-removed'
    | 'type-changed'
    | 'value-changed'
    | 'content-type-changed';
  severity: 'info' | 'warning' | 'breaking';
  location: { route?: string; endpoint?: string; jsonPath?: string; bbox?: Box };
  before?: unknown;
  after?: unknown;
  evidence: string[]; // artifact paths
}

interface LlmClient {
  complete<T>(
    req: {
      purpose: string;
      system: string;
      messages: LlmMessage[];
      schema: z.ZodType<T>;
      tier: 'fast' | 'smart';
      maxOutputTokens: number;
    },
    ctx: LlmCallContext, // budget, recordLlmUsage, signal, logger: a stage passes its StageContext
  ): Promise<{ data: T; usage: LlmUsage }>;
}
```

### Artifacts

```
.bdiff/
  results.csv
  runs/<runId>/
    run.json
    compose.yml
    logs/
    worktrees/<side>/      (removed by cleanup when the run ends)
    ui/<probeRun>/<route-slug>-<hash8>.png
    api/<probeRun>/<request-slug>-<hash8>.json
    diff/
    report/index.html
```

All paths come from the typed `ArtifactPaths` helper (`createArtifactPaths(root, runId)`) — never build path strings ad hoc. Routes and request keys become a readable slug plus 8 hex chars of their SHA-256, so distinct keys never collide and untrusted keys can't escape the run directory. Run ids are lowercase ULIDs.

**Repo cache.** The workspace stage keeps one bare clone per repository in `~/.cache/bdiff/repos/<slug>-<hash8>` (`BDIFF_CACHE_DIR` overrides) and only fetches on later runs. All git calls go through `createGit` (`workspace/git.ts`): no user hooks, no credential prompts, no LFS downloads, https and local transports only.

**Recipes.** The recipe stage turns the head checkout into a `Recipe` with pure detectors (`packages/core/src/recipe/detect-*.ts`) over a `RepoFiles` snapshot; each detector is unit-tested with in-memory file trees (`createRepoFiles`). Commands are argv arrays, never shell strings: `installCmd` runs in `installRoot`, everything else in `appRoot`. Only example env files are read, never a real `.env`. Recipes are cached in `~/.cache/bdiff/recipes/` keyed by repository and invalidated by a fingerprint of manifests, lockfiles and Node version files; entries with `source: 'llm'` (repair loop) are reused the same way. Missing information throws `SETUP_UNSUPPORTED`.

**Environments.** The environment stage writes `runs/<id>/compose.yml` (project `bdiff-<runId>`), copies each worktree into its app container with `docker compose cp` (never a bind mount), and runs the recipe through a generated shell script whose arguments are all quoted; each setup phase exits with its own code (`SETUP_EXIT_CODES`), mapped to `SETUP_*_FAILED`. The host only ever runs `docker` (and `git` in the workspace stage). Every `$` in the compose file is escaped because env values come from the repository. The `docker compose down -v` cleanup hook is registered before anything is created.

**Impact.** The impact stage (`packages/core/src/impact`) decides which pages and API endpoints to probe, before any container exists. Skip rules come first (`skip-rules.ts`): a PR that only touches docs, tests, CI config or lockfiles is skipped with `<kind>-only` (`non-runtime-only` for a mix); `.md`/`.mdx` and test-named folders inside `app/` or `pages/` are runtime code. Routes are discovered from file names alone (App Router `page`/`route` files, Pages Router `pages/`), and route handlers' HTTP methods from their exports. The head's import graph comes from dependency-cruiser over a static parse: no repository code, config or plugin is loaded, packages are not followed, and tsconfig/jsconfig `paths` and `baseUrl` are read by `readImportAliases` (relative `extends` only). Changed files are walked backwards to routes; an App Router `layout`/`template` covers every page below it, `pages/_app` and `_document` every Pages Router page. Dynamic routes are listed as not probed (`dynamic-params`), and at most 10 pages and 10 endpoints are probed (the rest is `cap`). When no changed file reaches a route, `/` plus three top-level static pages are probed with `low` confidence; some unmapped files mean `medium`.

**LLM calls.** Every call goes through `LlmClient.complete(request, ctx)` (`packages/core/src/llm`); stages pass their `StageContext` as `ctx`. The client checks the budget before every request (retries included), records every attempt's usage, sends the zod schema as the structured output format, validates the answer with zod and retries once with the validation problem before `LLM_INVALID_OUTPUT`. Refusals become `LLM_REFUSED`; branch on errors, never read content of a refused response. Models, effort and server-side fallback per tier live in `config/llm.json`; every model a tier or its fallback can use must be in `config/pricing.json`. Never send `temperature`, `top_p`, `top_k` or an assistant prefill (current models reject them). Prompts live in `packages/core/src/llm/prompts/*.ts` as typed functions; keep run-specific data out of `system` so it stays cacheable. Tests use `FakeLlmClient` from `@bdiff/core/testing`, or `createAnthropicLlmClient({ fetch })` with a fake transport: never the real API.

**Metrics.** A run's numbers are accumulated by a `RunRecorder` (stage timings via its `timer`, LLM usage via `recordLlmUsage`, compute seconds, counts) and persisted by `MetricsStore` (`run.json` atomically, one `results.csv` row). LLM cost comes only from `config/pricing.json` through `CostCalculator`; never hardcode a price. `run.json` fields, CSV columns and the pricing rules are documented in `docs/metrics.md`; a test fails if the documented CSV columns drift from the code.

## Repo tooling conventions

- **Workspace packages** are `@bdiff/core`, `@bdiff/report` and `@bdiff/cli`, linked with `workspace:*`. Shared dev tooling lives in the root `package.json` only.
- **Source condition.** Each package's `exports` has a `bdiff-source` condition pointing at `src/index.ts`. TypeScript (`customConditions`), Vitest (`ssr.resolve.conditions`), ESLint's import resolver and tsx (`tsx --conditions=bdiff-source …`) use it, so typecheck, tests and dev runs never need a prior build. Plain Node resolves to `dist/`.
- **Two tsconfigs per package.** `tsconfig.json` is used by the editor, typecheck and lint, and covers `src/` including tests (`noEmit`). `tsconfig.build.json` is the composite build project: it excludes `*.test.ts`, emits to `dist/` and declares project references to the packages it depends on. The root `tsconfig.json` covers root-level tooling files and `tests/`; `tsconfig.build.json` is the build solution.
- **Adding a package:** copy an existing package's `package.json`, `tsconfig.json` and `tsconfig.build.json`; add it to the root `tsconfig.build.json` references and to `projects` in `vitest.config.ts`; add ESLint boundary rules if it has import restrictions.
- **Tests** live next to the code as `src/**/*.test.ts`. Repo-level tooling tests go in `tests/`.
- **Stage tests** run a single stage outside the pipeline with `createTestStageContext()` from `@bdiff/core/testing` (fake clock, test logger, recorded cleanup hooks). Tests against the fixture repository live in `e2e/`.
- **Docker tests** are named `*.docker.test.ts`. They are excluded from `pnpm test` and `pnpm check` and run with `pnpm test:docker` (`vitest.docker.config.ts`, serial, long timeouts), and in CI by `.github/workflows/docker.yml` when core, cli, fixtures or e2e change. Every container they create is removed in `finally`.
- **The fixture** is ground truth: changing the sample app or a branch overlay means updating `fixtures/expected.json` in the same PR. Its lockfile is regenerated with `pnpm install --lockfile-only` in a copy outside the workspace; never install or run the fixture app on the host.
- **Imports** use explicit `.js` extensions for relative paths (NodeNext), `import type` for types, and the order enforced by `import-x/order`.
- **Lint suppressions** need a reason: `// eslint-disable-next-line <rule> -- <why>`. Unused or undescribed directives fail lint.
- **Dependency build scripts** are denied by default (`allowBuilds` in `pnpm-workspace.yaml`). Allow one only with a reason.

## Core building blocks

- **Schemas:** a zod schema `FooSchema` plus `type Foo = z.infer<typeof FooSchema>`; never a hand-written duplicate type. Optional fields use `.exactOptional()` to match `exactOptionalPropertyTypes`. Values written to records or sent to an LLM are `JsonValue`.
- **Placeholders:** `domain/placeholders.ts` holds contracts owned by later tasks (`TODO(SKR-n)`). The owning task replaces the placeholder with the real schema.
- **Errors:** `new BdiffError(code, message, { stage?, cause?, details? })`. Codes live in `errors/codes.ts`; add codes, never rename them (they're stored in records and the CSV). `details` must be JSON and must not contain secrets. Adapters leave `stage` empty; `toFailureRecord(err, stage)` fills it in. Abort reasons become errors via `abortError(signal)` / `throwIfAborted(signal)`.
- **Exec:** every host command goes through the `Exec` adapter with an args array, a `timeoutMs` and an abort `signal` (both required). Commands run in their own process group, so timeout/abort kills the whole tree (POSIX only). `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` are stripped from child environments; pass one explicitly via `env` only when a command needs it, and never put secrets in `args`. A non-zero exit code is returned, not thrown.
- **Logging:** depend on the `Logger` interface; scope with `logger.child({ stage })`. Secret-looking keys (`apiKey`, `token`, `authorization`, the secret env vars, …) are redacted up to two levels deep, but don't rely on that: don't log secrets.
- **Time:** inject `Clock` (`now`, `monotonicMs`, `sleep`) instead of calling `Date.now()`, `performance.now()` or `setTimeout` in logic.
- **Test fakes** come from `@bdiff/core/testing` (`FakeExec`, `FakeClock`, `createTestLogger`). `FakeExec` throws on unscripted calls. Production code never imports from `testing/`.

## Engineering standards (non-negotiable)

**Code**

- TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`. ESM, Node 22. No `any`. No non-null assertions without a justification comment.
- Small, single-purpose modules. Pure functions for all logic; side effects (process exec, filesystem, Docker, browser, network, LLM, clock) only in adapters behind interfaces, injected via the CLI composition root.
- Validate every external input with zod: CLI config, dataset files (`repos.json`), recipe files, cached files, HTTP responses we interpret, **all LLM output**.
- Public functions have TSDoc. Names describe intent. No dead code, no commented-out code.
- Logging with pino (structured). No `console.log` in core (enforced by ESLint).

**Errors & resources**

- Throw `BdiffError { code, stage, cause, details }`. Never swallow errors; never `catch` without rethrowing or recording. Every failed run is recorded with a reason code.
- Every subprocess, network call and browser action has a timeout and respects the abort signal.
- Containers, networks, worktrees and browsers are always released in `finally` via the cleanup registry. A killed run must leave nothing behind.

**Security**

- **Target-repo code runs only inside Docker containers, never on the host.** The host browser only loads pages served by our containers.
- Secrets (`ANTHROPIC_API_KEY`, `GITHUB_TOKEN`) come from env, are never logged, never written to artifacts, never committed. `.env` is git-ignored; `.env.example` lists the names only.
- Treat repo content, PR text and response bodies as untrusted: escape in HTML, never execute, never interpolate into shell strings (pass args arrays).

**LLM usage**

- All calls go through `LlmClient`; prompts live in `llm/prompts/*.ts` as typed functions.
- Every call is budget-checked before it is made and its usage is recorded.
- The LLM interprets observed evidence; it never decides whether something changed. Diffing is deterministic code.
- Models are configured, not hardcoded (`config/llm.json`): `fast` tier (Claude Haiku 5.5) by default, `smart` tier (Claude Sonnet 5.5, with server-side fallback) for hard cases.

**Testing**

- Vitest everywhere. Unit tests for all pure logic (table-driven where possible), adapter tests with fakes, integration tests tagged `@docker` against the fixture.
- The fixture (`fixtures/expected.json`) is ground truth. The e2e suite must assert that `ui-change` → findings on `/login` only, `api-breaking` → breaking `type-changed` on `total` + `field-added` `currency`, `refactor-no-change` → zero findings, `docs-only` → skipped, the noisy page never produces a finding, and no resources leak.
- **Never weaken, skip or delete a test to make it pass.** If a test is wrong, explain why in the PR before changing it.
- No real LLM or GitHub calls in CI; use fakes.

**Workflow**

- One Jira task = one branch = one PR. Branch `SKR-<n>-short-slug`, commits `SKR-<n>: message`.
- Before coding a task: restate the goal, list the files you will touch and the interfaces you will add/change, and flag anything ambiguous or conflicting with this document. Ask instead of guessing when a decision affects architecture.
- `pnpm check` (lint + typecheck + test) must pass before you say a task is done. Walk through every acceptance-criteria checkbox and confirm each explicitly.
- Keep scope tight: do not implement work from later tasks; leave a `TODO(SKR-<n>)` only if it points to an existing task.
- Update `CLAUDE.md` when a convention changes; update `docs/` when a public contract (CLI flags, run.json/CSV schema) changes.

## Definition of done (every task)

- Acceptance criteria met and individually confirmed.
- Tests added; `pnpm check` green locally and in CI.
- No new lint/type errors, no `any`, no leaked resources.
- Public APIs documented; CLAUDE.md/docs updated if needed.
- PR description: what changed, why, how it was tested, known limitations.
