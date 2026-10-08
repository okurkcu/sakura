# bdiff CLI

```bash
pnpm bdiff run --repo <url|path> --base <ref> --head <ref> [options]
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

| Env                  | Meaning                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BDIFF_TOOL_VERSION` | Overrides the tool version recorded in `run.json` (otherwise `GITHUB_SHA`, then the git SHA of the bdiff checkout, `-dirty` if it has uncommitted changes).               |
| `BDIFF_PRICING`      | Path of the pricing table; default `config/pricing.json` in the bdiff checkout.                                                                                           |
| `BDIFF_CACHE_DIR`    | Cache of bare repository clones (`repos/`) and detected recipes (`recipes/`), reused across runs. Default `$XDG_CACHE_HOME/bdiff`, else `~/.cache/bdiff`. Safe to delete. |
| `ANTHROPIC_API_KEY`  | Claude API key for the LLM stages (an `ant auth login` profile also works). Only needed when a run calls the LLM. Never logged or recorded.                               |
| `GITHUB_TOKEN`       | Optional GitHub token for fetching PR text. Never logged or recorded.                                                                                                     |

## Output

- **stdout:** a short summary (status, duration, LLM cost, path of `run.json`).
- **stderr:** structured JSON logs (pino) and usage errors.
- **Files:** `<out>/runs/<runId>/run.json` and one row in `<out>/results.csv`; see [metrics.md](metrics.md).

## Exit codes

| Code  | Meaning                                                                                       |
| ----- | --------------------------------------------------------------------------------------------- |
| `0`   | The run succeeded or was skipped (e.g. a docs-only PR).                                       |
| `1`   | The run failed and was recorded, or it could not be recorded (e.g. unreadable pricing table). |
| `2`   | Invalid usage; nothing ran and nothing was written.                                           |
| `130` | Interrupted by SIGINT or SIGTERM; cleanup ran and the run was recorded as `ABORTED`.          |

On the first Ctrl+C (or SIGTERM), bdiff aborts the stage in progress, runs every cleanup hook (containers, worktrees, browsers), renders the report and writes the record. A second Ctrl+C exits immediately without waiting for cleanup.

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

## LLM configuration

`config/llm.json` sets the model of each tier, how much it thinks (`effort`), and the request timeout and retry count:

| Tier    | Model               | Used for                                        |
| ------- | ------------------- | ----------------------------------------------- |
| `fast`  | `claude-haiku-5-5`  | Default: high-volume, simple structured calls.  |
| `smart` | `claude-sonnet-5-5` | Hard cases, e.g. interpreting breaking changes. |

The `smart` tier sets `"fallbacks": "default"`: if Claude Sonnet 5.5 declines a request on policy grounds (cyber or frontier-LLM categories), the Claude API retries it on Claude Sonnet 5 within the same call. Each attempt is recorded and priced at its own model. Every configured model, and every fallback model, must have a price in `config/pricing.json`; bdiff refuses to start a call it cannot price. The `--budget` cap is checked before every request.
