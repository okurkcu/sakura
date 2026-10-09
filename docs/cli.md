# bdiff CLI

```bash
pnpm bdiff run --repo <url|path> --base <ref> --head <ref> [options]
pnpm bdiff batch <dataset.json> [--concurrency 1|2] [--resume | --force] [--only <tag=value>]… [options]
pnpm bdiff stats [--by difficulty|prType|author] [--out <dir>]
```

From a build, the same command is `node packages/cli/dist/main.js run …` (package bin: `bdiff`).

## `bdiff run`

Compares the behavior of `--base` and `--head` of a repository and writes a run record. It needs a running Docker daemon and, for the UI probe, Chromium installed with `pnpm browser:install`; without it the run fails at `probe-ui` with `BROWSER_UNAVAILABLE`.

| Flag                  | Env                 | Default  | Meaning                                                                              |
| --------------------- | ------------------- | -------- | ------------------------------------------------------------------------------------ |
| `--repo <url\|path>`  |                     | required | Repository: HTTPS URL or local path. Other transports (ssh, `file://`) are rejected. |
| `--base <ref>`        |                     | required | Base ref (branch, tag or SHA).                                                       |
| `--head <ref>`        |                     | required | Head ref. With `--pr`, falls back to GitHub's `pull/<n>/head` (fork PRs).            |
| `--pr <number>`       |                     |          | Pull request number, positive integer. Recorded, and used to fetch PR text.          |
| `--out <dir>`         | `BDIFF_OUT`         | `.bdiff` | Output root, relative to the working directory.                                      |
| `--timeout <minutes>` | `BDIFF_TIMEOUT_MIN` | `20`     | Limit for the whole run, `0 < minutes ≤ 1440`. Decimals allowed.                     |
| `--budget <usd>`      | `BDIFF_BUDGET_USD`  | `1`      | LLM spend cap for the run, `0 ≤ usd ≤ 100`. `0` allows no LLM calls.                 |
| `--log-level <level>` | `BDIFF_LOG_LEVEL`   | `info`   | `debug`, `info`, `warn` or `error`.                                                  |

Flags take precedence over environment variables, which take precedence over defaults. Refs and the repository may not start with `-`. Every invalid value is reported at once.

Other environment variables:

| Env                  | Meaning                                                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BDIFF_TOOL_VERSION` | Overrides the tool version recorded in `run.json` (otherwise `GITHUB_SHA`, then the git SHA of the bdiff checkout, `-dirty` if it has uncommitted changes).                                          |
| `BDIFF_PRICING`      | Path of the pricing table; default `config/pricing.json` in the bdiff checkout.                                                                                                                      |
| `BDIFF_CACHE_DIR`    | Cache of bare repository clones (`repos/`) and detected recipes (`recipes/`), reused across runs. Default `$XDG_CACHE_HOME/bdiff`, else `~/.cache/bdiff`. Safe to delete.                            |
| `ANTHROPIC_API_KEY`  | Claude API key for the LLM stages: setup repair, generated API requests and interpretation (an `ant auth login` profile also works). Only needed when a run calls the LLM. Never logged or recorded. |
| `GITHUB_TOKEN`       | Optional GitHub token for fetching PR text. Never logged or recorded.                                                                                                                                |

## Output

- **stdout:** a short summary: outcome, findings by severity (also for a run that failed after the diff, e.g. at interpret), duration, LLM cost, run id, and the paths of the report and `run.json`:

  ```text
  bdiff: success, 2 findings (1 breaking, 1 warning)
    84.2s · LLM $0.0031 · run 01k6t3y8k0g3m5x9a2b7c4d6ef
    report: .bdiff/runs/01k6t3y8k0g3m5x9a2b7c4d6ef/report/index.html
    record: .bdiff/runs/01k6t3y8k0g3m5x9a2b7c4d6ef/run.json
  ```

  The paths are absolute. The `report:` line is left out when no report was written (a failing report stage).

- **stderr:** structured JSON logs (pino) and usage errors.
- **Files:** `<out>/runs/<runId>/run.json` and one row in `<out>/results.csv`; see [metrics.md](metrics.md).
- **Report:** `<out>/runs/<runId>/report/index.html`, for every run (failed and skipped ones too). Open it from disk: it needs no server and loads nothing from the network. Screenshots, overlays and logs are linked by relative path, so keep the run directory together when moving it.

## Exit codes

| Code | Meaning                                                                                       |
| ---- | --------------------------------------------------------------------------------------------- |
| `0`  | The run succeeded or was skipped (e.g. a docs-only PR).                                       |
| `1`  | The run failed and was recorded, or it could not be recorded (e.g. unreadable pricing table). |
| `2`  | Invalid usage; nothing ran and nothing was written.                                           |

For `bdiff batch` and `bdiff stats`, see their sections; `2` and `130` mean the same for every command.
| `130` | Interrupted by SIGINT or SIGTERM; cleanup ran and the run was recorded as `ABORTED`. |

On the first Ctrl+C (or SIGTERM), bdiff aborts the stage in progress, runs every cleanup hook (containers, worktrees, browsers), renders the report and writes the record. A second Ctrl+C exits immediately without waiting for cleanup.

## `bdiff batch`

Runs every pull request of a dataset file, unattended, one at a time (`--concurrency 2` runs two at once; more would compete for Docker resources). `--out`, `--timeout`, `--budget` and `--log-level` work as for `bdiff run`; timeout and budget apply to each run. Each entry is isolated: a run that fails is recorded like any other, and an entry that cannot even be recorded is reported and skipped. Each record carries the entry's id and tags (`dataset` in `run.json`, `dataset_id` in the CSV). At the end, `<out>/report/batch-index.html` lists the latest record of every entry, linked to its report.

The dataset (validated; an invalid one exits with 2 and lists every problem):

```json
{
  "entries": [
    {
      "id": "shop-42",
      "repoUrl": "https://github.com/acme/shop.git",
      "prNumber": 42,
      "baseRef": "main",
      "headRef": "refs/pull/42/head",
      "tags": { "difficulty": "easy", "prType": "ui", "author": "human" }
    }
  ]
}
```

`id` is unique, made of letters, digits, `.`, `_` and `-`. `prNumber` is optional (a local repository has none). Tags: `difficulty` is `easy` or `realistic`, `prType` is `ui`, `api`, `mixed` or `refactor` (use `refactor` for any PR that should not change behavior; the false-difference criterion counts on it), `author` is `human` or `agent`. `--only prType=api` (repeatable; all must match) runs a subset.

An entry is **done** when `<out>` holds a record of it from the same bdiff version (`toolVersion`), whatever its status, except an interrupted run (`ABORTED`). If some selected entries are done, `bdiff batch` refuses to start (exit 2) unless `--resume` (skip them: continue a batch that was interrupted) or `--force` (run them again). Ctrl+C stops the batch: the runs in progress are aborted and recorded, no further entry starts, and the command exits with 130; run it again with `--resume`. `bdiff batch` exits with 0 when every entry it ran was recorded (whatever the runs' status), 1 when some could not be.

## `bdiff stats`

Reads every `run.json` under `<out>/runs`, prints the experiment's numbers and writes them to `<out>/stats.json` (see [metrics.md](metrics.md#statsjson)). A dataset entry recorded several times counts once (its latest record); single runs each count. `--by <tag>` adds the same numbers per tag value. It exits with 1 when there is no record.

It ends with the epic's success criteria, each `PASS`, `FAIL` or `N/A` (not enough runs to judge):

| Criterion           | Measured as                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `setup-success`     | ≥ 50% of the runs that tried to set the app up got it running (after repair, if any).                        |
| `median-duration`   | Median duration of the runs that were not skipped < 10 min.                                                  |
| `false-differences` | ≤ 10% of the successful runs tagged `prType: refactor` (no behavior change expected) have a finding.         |
| `hidden-changes`    | At least one run has a finding the interpretation flagged as unexpected for the PR's intent (needs the LLM). |

## Explicit API requests

The API probe sends the same requests to base and head: every static GET endpoint the PR can affect, plus one or two requests per other endpoint (POST, PUT, …) that the LLM (`fast` tier) proposes from the handler's source, labeled `generated` in `run.json` (`apiRequests`). Generating needs `ANTHROPIC_API_KEY` (or an `ant auth login` profile); without credentials, or once `--budget` is spent, those endpoints are listed as not probed and the rest of the run goes on. To send requests of your own, add `bdiff.requests.json` to the app or repository root; they are sent first, in order, and an endpoint they cover gets no generated request:

```json
{
  "requests": [
    { "method": "GET", "path": "/api/orders?page=2" },
    {
      "method": "POST",
      "path": "/api/feedback",
      "description": "Five-star feedback",
      "json": { "message": "Great mugs", "rating": 5 }
    },
    {
      "method": "POST",
      "path": "/api/search",
      "headers": { "Content-Type": "application/x-www-form-urlencoded" },
      "text": "q=mug"
    }
  ]
}
```

`path` is a path on the app (no host); `json` or `text` is the body; `headers` may not set `Host`, `Cookie` or transport headers. At most 50 requests. An invalid file fails the run with `CONFIG_INVALID`. Every request also carries `User-Agent: bdiff` and never a cookie, and each one has 10 seconds.

## Chromium sandbox on Linux

The UI probe loads pages built from the repository under test, so Chromium always runs with its sandbox on; bdiff has no option to turn it off. Ubuntu 23.10+ restricts the unprivileged user namespaces the sandbox needs, and the run then fails at `probe-ui` with `BROWSER_UNAVAILABLE` ("Chromium could not start its sandbox"). Allow them until the next reboot with:

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

or permanently with an AppArmor profile for Playwright's Chromium, as described in [Chromium's AppArmor notes](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md). macOS needs nothing.

## Containers

`bdiff run` starts base and head in Docker containers of one compose project, `bdiff-<runId>`, and removes it when the run ends, including after Ctrl+C or SIGTERM. Only a process killed with `kill -9` cannot clean up. To remove any bdiff projects left behind:

```bash
docker compose ls --all --quiet --filter name=bdiff- | xargs -n1 -I{} docker compose --project-name {} down --volumes --remove-orphans
```

Each app container gets 2 CPUs and 4 GB of memory; its port is published on `127.0.0.1` only. Setup (install, database, build, start) has 10 minutes. The logs of each side are saved in `runs/<runId>/logs/{base,head}.log`.

## Setup repair

When the app's setup fails (no recipe could be detected, or install, database setup, build, start or the health check failed), the LLM proposes a fix to the recipe and bdiff tries again, at most 3 times and for at most $0.50 of LLM spend per run (within `--budget`). The fix is data, never a shell command: it can set environment variables and change the Node version, package manager, install, build, start and database commands, app root, port and health path. Commands are limited to the package manager installing or running a script of the repository's `package.json`, `next`, `prisma` or `drizzle-kit` through it or `npx`, and `node <file>` for a file of the repository; anything else is rejected and costs an attempt. Commands still run only inside the containers. Each attempt is recorded in `run.json` (`setupAttempts`); the logs of a failed attempt are kept as `runs/<runId>/logs/<side>-attempt-<n>.log`. A recipe that worked is cached, so later runs of the same repository skip the repair. Without credentials (or once a budget is spent) the run fails with the original setup error, as it would without repair.

## Interpretation

When a run has findings, the interpret stage asks the LLM to summarize them and to flag those the pull request's stated intent does not account for, with a risk level, a coverage note and up to three things to check by hand. The intent is read from GitHub when `--pr` is given for a github.com repository (`GITHUB_TOKEN` is optional for public repositories), else from the messages of the commits between base and head. It uses the `fast` tier, or `smart` when a finding is breaking or there are more than 15. A run without findings makes no LLM call. Without credentials, a run with findings fails at `interpret` with `LLM_UNAVAILABLE`; its findings are still recorded.

## LLM configuration

`config/llm.json` sets the model of each tier, how much it thinks (`effort`), and the request timeout and retry count:

| Tier    | Model               | Used for                                        |
| ------- | ------------------- | ----------------------------------------------- |
| `fast`  | `claude-haiku-5-5`  | Default: high-volume, simple structured calls.  |
| `smart` | `claude-sonnet-5-5` | Hard cases, e.g. interpreting breaking changes. |

The `smart` tier sets `"fallbacks": "default"`: if Claude Sonnet 5.5 declines a request on policy grounds (cyber or frontier-LLM categories), the Claude API retries it on Claude Sonnet 5 within the same call. Each attempt is recorded and priced at its own model. Every configured model, and every fallback model, must have a price in `config/pricing.json`; bdiff refuses to start a call it cannot price. The `--budget` cap is checked before every request.
