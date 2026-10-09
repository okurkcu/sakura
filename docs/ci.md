# CI workflows

| Workflow      | File                           | When                                                                                       |
| ------------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| CI            | `.github/workflows/ci.yml`     | Every push to `main` and every PR: `pnpm check` and `pnpm build`.                          |
| Docker tests  | `.github/workflows/docker.yml` | PRs and pushes touching core, cli, report, fixtures or e2e: Docker, browser and e2e tests. |
| Dataset batch | `.github/workflows/batch.yml`  | On demand, and on PRs that change it or the batch code (with the fixture dataset).         |

## Dataset batch

Runs the experiment in CI instead of on a laptop. Start it from Actions → Dataset batch → Run workflow, or with:

```bash
gh workflow run batch.yml -f dataset=datasets/dataset.json -f shards=4 -f budget=1
```

| Input     | Default   | Meaning                                                                                                        |
| --------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `dataset` | `fixture` | A dataset file in the repository, or `fixture`: the fixture repository's PR branches (`pnpm fixture:dataset`). |
| `shards`  | `4`       | Parallel shard jobs, 1–20.                                                                                     |
| `only`    | (none)    | A `bdiff batch --only` filter, e.g. `prType=api`.                                                              |
| `budget`  | `1`       | LLM budget per PR, in USD (`--budget`).                                                                        |

1. **plan** checks `shards` and lists the shards.
2. **shard** (one job per shard, 120 minutes at most):
   1. installs dependencies (pnpm, cached), Chromium and the `node:22` image;
   2. prepares the dataset;
   3. runs `bdiff batch <dataset> --shard i/n`;
   4. uploads its `runs/` (reports, `run.json`, logs; no worktrees) as the artifact `bdiff-shard-<i>`, kept 7 days.
3. **combine and stats** downloads every shard's runs into one directory and runs `bdiff stats --by prType`. It writes the PASS/FAIL table and the main numbers to the job summary, and uploads everything as `bdiff-results`, kept 30 days:
   - `stats.json`;
   - `report/batch-index.html`, which links each run's report;
   - `runs/`.

   It runs even when a shard failed, so the other shards' runs still count.

Download the results from the workflow run's page (Artifacts → `bdiff-results`) or with `gh run download <run-id> -n bdiff-results`, then open `report/batch-index.html`.

**Secrets.**

- `ANTHROPIC_API_KEY` is the repository secret of the same name. Without it, the runs that need the LLM (interpretation of findings, setup repair, generated API requests) fail or skip that step as they do locally without a key.
- `GITHUB_TOKEN` is the workflow's own token, which is enough to read public pull requests.

Neither is printed: GitHub masks secrets in logs, and bdiff never logs them.

**Cost.** GitHub Actions is free for public repositories. On a private repository, standard Linux runners are billed per minute. Each shard spends a few minutes on setup plus the runs themselves, roughly 1–5 minutes per PR.
