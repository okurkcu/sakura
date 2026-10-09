# bdiff

Behavior diff for pull requests. bdiff runs the base and head versions of a PR side by side, exercises them identically, and shows how the software's behavior changed: screenshots, visible text, API responses and runtime errors.

> Status: early MVP, under construction. See [CLAUDE.md](CLAUDE.md) for architecture and engineering standards.

## Requirements

- Node.js 22 (see `.nvmrc`; ≥ 22.12 is required)
- pnpm, via corepack: `corepack enable` (the version is pinned in `package.json`)
- Docker (target-repo code only ever runs in containers)
- Chromium for Playwright, used by the UI probe: `pnpm browser:install` (about 200 MB, in Playwright's cache)

## Setup

```bash
corepack enable
pnpm install
pnpm browser:install   # Chromium for the UI probe and browser tests
cp .env.example .env   # then fill in ANTHROPIC_API_KEY and GITHUB_TOKEN
pnpm check             # lint + typecheck + test
```

## Usage

```bash
pnpm bdiff run https://github.com/<owner>/<repo>/pull/<n>
pnpm bdiff run --repo <url|path> --base <ref> --head <ref>
```

Each run writes `.bdiff/runs/<runId>/report/index.html` and `run.json`; see [docs/cli.md](docs/cli.md). Without `ANTHROPIC_API_KEY` the LLM is off (no interpretation); `--llm fake` shows canned answers.

### Dev panel

```bash
pnpm bdiff ui --demo   # demo data, no Docker or API key needed
pnpm bdiff ui          # your runs in .bdiff, live while they run
```

A local page (127.0.0.1 only) with the runs, each run's timeline, API and page changes and interpretation, and the fixture check. See [docs/panel.md](docs/panel.md).

## Running the experiment in CI

`.github/workflows/batch.yml` runs a dataset through `bdiff batch` in parallel shards on GitHub Actions and combines the results with `bdiff stats`: Actions → Dataset batch → Run workflow. See [docs/ci.md](docs/ci.md). Cost: GitHub Actions is free for public repositories; on a private repository, standard Linux runners are billed per minute (each shard runs for minutes to hours, depending on the dataset).

## Layout

| Path              | Purpose                                                    |
| ----------------- | ---------------------------------------------------------- |
| `packages/core`   | Engine: domain types, pipeline, stages, adapters.          |
| `packages/report` | Renders a run result into a self-contained HTML report.    |
| `packages/panel`  | Dev panel (`bdiff ui`): local web UI over a workspace.     |
| `packages/cli`    | Command-line entry point; wires real adapters into core.   |
| `tests`           | Repo-level tooling tests (e.g. package import boundaries). |
