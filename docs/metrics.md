# Run records and metrics

Every bdiff run leaves two machine-readable traces under the output root (`.bdiff/` by default):

- `runs/<runId>/run.json`: the complete record of one run.
- `results.csv`: one row per run, across all runs, for quick analysis.

Both are public contracts. Change them only deliberately: update this document in the same PR, and bump `schemaVersion` for any change that would break readers of existing `run.json` files.

## Run ids

A run id is a [ULID](https://github.com/ulid/spec) written in **lowercase** (e.g. `01k6t3y8k0g3m5x9a2b7c4d6ef`). It sorts by creation time and is used unchanged as the run directory name and in the docker compose project name `bdiff-<runId>` (compose requires lowercase).

## `run.json`

Written atomically: a temp file is written next to it and renamed, so a reader never sees a partial record. A record is validated against `RunRecordSchema` (`packages/core/src/metrics/run-record.ts`) before it is written. A run that fails at any stage still produces a valid record, with the failure and the timings of every stage that ran, including the failed one.

| Field            | Type                                    | Meaning                                                                                                                                                                                                                                                                                  |
| ---------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`  | `1`                                     | Format version of this record.                                                                                                                                                                                                                                                           |
| `runId`          | string                                  | Lowercase ULID.                                                                                                                                                                                                                                                                          |
| `toolVersion`    | string                                  | Git SHA of the bdiff checkout that produced the record.                                                                                                                                                                                                                                  |
| `target`         | object                                  | `repoUrl`, `baseRef`, `headRef`, and optionally `prNumber`, `prTitle`, `prBody`.                                                                                                                                                                                                         |
| `startedAt`      | ISO 8601 UTC                            | When the run started.                                                                                                                                                                                                                                                                    |
| `finishedAt`     | ISO 8601 UTC                            | When the record was produced.                                                                                                                                                                                                                                                            |
| `durationMs`     | number                                  | Wall time of the run, from a monotonic clock.                                                                                                                                                                                                                                            |
| `status`         | `success` \| `failed` \| `skipped`      | How the run ended.                                                                                                                                                                                                                                                                       |
| `failure`        | object, only when `status` is `failed`  | `code` (error code), `stage`, `message`, `details` (JSON) and `causes` (the error's cause chain).                                                                                                                                                                                        |
| `skip`           | object, only when `status` is `skipped` | `reason`: `no-changes`, `docs-only`, `tests-only`, `ci-only`, `lockfile-only` or `non-runtime-only` (a mix of those kinds).                                                                                                                                                              |
| `stageTimings`   | array                                   | One entry per stage execution, in start order: `stage`, `durationMs`, `outcome` (`success` \| `failed`). A stage may appear more than once.                                                                                                                                              |
| `computeSeconds` | `{ base, head }`                        | Container CPU time per side, in seconds.                                                                                                                                                                                                                                                 |
| `llmUsage`       | array                                   | One entry per LLM call: `purpose`, `model`, token counts (see below) and `costUsd`.                                                                                                                                                                                                      |
| `totals`         | object                                  | Sums over `llmUsage` (`llmCalls`, token counts, `llmCostUsd`) and `computeSeconds` (sum of both sides).                                                                                                                                                                                  |
| `counts`         | object                                  | `routesProbed`, `endpointsProbed`, `rawDiffs`, `noiseDiffs`, `findings`.                                                                                                                                                                                                                 |
| `apiRequests`    | array                                   | The API probe's request set, in send order: `key`, `source` (`explicit`, `route` or `generated` by the LLM), `method`, `path`, `headers`, `body`, `description`, `endpoint`. Empty when no API was probed.                                                                               |
| `riskLevel`      | `low` \| `medium` \| `high` \| `null`   | The interpretation's risk level; `null` when the run produced no interpretation (failed or skipped before it).                                                                                                                                                                           |
| `setupAttempts`  | array                                   | Attempts of the setup repair loop, oldest first (empty when setup needed no repair): `attempt`, `trigger` (`stage`, `code`, `side`), `tier`, `patch` (the recipe patch, or `null`), `outcome` (`repaired`, `setup-failed`, `rejected` or `no-patch`), `errorCode`, `problem`, `costUsd`. |

Token counts per LLM call mirror the API's `usage` object:

| Field                | API source                                         |
| -------------------- | -------------------------------------------------- |
| `inputTokens`        | `input_tokens` (uncached input)                    |
| `outputTokens`       | `output_tokens` (includes thinking tokens)         |
| `cacheReadTokens`    | `cache_read_input_tokens`                          |
| `cacheWrite5mTokens` | `cache_creation.ephemeral_5m_input_tokens`         |
| `cacheWrite1hTokens` | `cache_creation.ephemeral_1h_input_tokens`         |
| `model`              | The model id as configured and sent in the request |

## `results.csv` columns

The first line is the header. Rows are RFC 4180: fields containing a comma, quote or line break are quoted, and quotes are doubled. Lines end with `\n`. Empty means "not applicable": no failure, no skip, no PR number, or a stage that never ran. bdiff refuses to append to an existing file whose header differs (`METRICS_CSV_MISMATCH`); move the old file aside after a column change.

| Column                      | Meaning                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `run_id`                    | Run id.                                                                                                                          |
| `schema_version`            | `run.json` format version.                                                                                                       |
| `tool_version`              | Git SHA of bdiff.                                                                                                                |
| `started_at`                | ISO 8601 UTC.                                                                                                                    |
| `finished_at`               | ISO 8601 UTC.                                                                                                                    |
| `duration_ms`               | Wall time of the run.                                                                                                            |
| `status`                    | `success`, `failed` or `skipped`.                                                                                                |
| `failure_code`              | Error code of a failed run.                                                                                                      |
| `failure_stage`             | Stage that failed.                                                                                                               |
| `failure_message`           | Error message of a failed run.                                                                                                   |
| `skip_reason`               | Why the run was skipped: the `skip.reason` of `run.json`.                                                                        |
| `repo_url`                  | Repository URL or path.                                                                                                          |
| `base_ref`                  | Base ref as given.                                                                                                               |
| `head_ref`                  | Head ref as given.                                                                                                               |
| `pr_number`                 | Pull request number, if any.                                                                                                     |
| `ms_workspace`              | Total ms in the workspace stage.                                                                                                 |
| `ms_recipe`                 | Total ms in the recipe stage.                                                                                                    |
| `ms_environment`            | Total ms in the environment stage (all attempts).                                                                                |
| `ms_repair`                 | Total ms in the setup repair stage (all attempts, and caching a repaired recipe).                                                |
| `ms_impact`                 | Total ms in the impact stage.                                                                                                    |
| `ms_probe_ui`               | Total ms in the UI probe stage.                                                                                                  |
| `ms_probe_api`              | Total ms in the API probe stage.                                                                                                 |
| `ms_diff`                   | Total ms in the diff stage.                                                                                                      |
| `ms_interpret`              | Total ms in the interpret stage.                                                                                                 |
| `ms_report`                 | Total ms rendering the report (runs for every status).                                                                           |
| `ms_metrics`                | Always empty: the record is written after it is final, so it can't time itself. Reserved.                                        |
| `setup_attempts`            | Attempts of the setup repair loop (see `setupAttempts` in `run.json`); 0 when setup needed no repair.                            |
| `compute_seconds_base`      | Container run time (wall clock), base side.                                                                                      |
| `compute_seconds_head`      | Container run time (wall clock), head side.                                                                                      |
| `llm_calls`                 | Number of LLM calls.                                                                                                             |
| `llm_input_tokens`          | Uncached input tokens, all calls.                                                                                                |
| `llm_output_tokens`         | Output tokens, all calls.                                                                                                        |
| `llm_cache_read_tokens`     | Cache-read tokens, all calls.                                                                                                    |
| `llm_cache_write_5m_tokens` | 5-minute cache-write tokens, all calls.                                                                                          |
| `llm_cache_write_1h_tokens` | 1-hour cache-write tokens, all calls.                                                                                            |
| `llm_cost_usd`              | LLM cost in USD, all calls.                                                                                                      |
| `routes_probed`             | Pages probed.                                                                                                                    |
| `endpoints_probed`          | API endpoints probed.                                                                                                            |
| `raw_diffs`                 | Differences between baseA and head before noise filtering, counted per visual region, text block, runtime signal and API change. |
| `noise_diffs`               | Of those, the ones set aside as noise because baseA and baseB already differ there.                                              |
| `findings`                  | Findings reported.                                                                                                               |

## Pricing: `config/pricing.json`

LLM cost is computed from `config/pricing.json`, never from prices in code. Prices are USD per million tokens, keyed by the model id exactly as sent in API requests. `source` and `retrievedAt` record where and when the prices were checked; re-check them against the [pricing page](https://platform.claude.com/docs/en/about-claude/pricing) when adding a model.

Each model has one or more **prompt-length tiers**. Most models have a single tier. Claude Haiku 5.5 has two: prompts up to 100,000 tokens and prompts over that. A call's prompt length is its uncached input plus cache-read and cache-write tokens. The first tier whose `upToPromptTokens` covers that length applies to **every** token of the call, including output. The pricing page doesn't spell out exactly which counts make up "prompt length"; this is bdiff's reading of it. Revisit it if billed costs disagree.

Cost of a call:

```
input × inputPerMTok + output × outputPerMTok + cacheRead × cacheReadPerMTok
  + cacheWrite5m × cacheWrite5mPerMTok + cacheWrite1h × cacheWrite1hPerMTok
```

all divided by 1,000,000. Batch API and data-residency multipliers are not modelled; bdiff uses neither.

Compute cost (container time) is recorded as `computeSeconds` only: wall-clock container run time, which is what CI runners bill, and which is known even for a container that exited during its build. Converting it to dollars is left to the stats step.
