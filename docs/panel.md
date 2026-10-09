# Dev panel (`bdiff ui`)

A local web page to watch runs while they run, read their results and check the fixture suite. It is a developer tool on your own machine: it listens on `127.0.0.1` only, has no accounts and is never deployed.

```bash
pnpm bdiff ui --demo          # bundled demo data: no Docker, no API key
pnpm bdiff ui                 # the runs in .bdiff, live
pnpm bdiff run … --llm fake   # in another terminal: the run shows up live
```

## Screens

- **Runs**: the experiment's numbers against their targets (setup success, median run time, noise filtered, LLM cost per PR, computed like `bdiff stats`), a card for every run in progress (pipeline stages, page captures per probe run, the last 20 log lines; live, no reload), and every run with status filters.
- **Run detail**: what was compared, a timeline of the stages from their real start and end (base and head environment as two lanes, skipped stages dashed), API changes as a diff of the base and head responses, pages with a before/after slider, the diff overlay and the text diff, the intent check (the interpretation, or why there is none), coverage, and the run's files (report, `run.json`, logs, `compose.yml`). A failed run starts with its failure and last 100 log lines.
- **Fixture check**: the latest run of every fixture branch compared with `fixtures/expected.json`, plus a check that the noisy page never has a finding and one that no Docker resources were left behind. A failure shows what differed, the owning stage, a re-run command and, for noise, the baseA/baseB/head screenshots. **Re-run suite** builds the fixture repository and runs every branch (`bdiff batch --force`) in the panel's workspace and LLM mode; follow it on Runs, and Cancel stops it like Ctrl+C (the runs clean up).

Status is always a dot and a word, never color alone.

## LLM modes

The sidebar shows the mode a run started now would use. Without `ANTHROPIC_API_KEY` it is `off`: runs have no interpretation (and no setup repair), and the panel says so instead of showing one. `--llm fake` fills in canned interpretations, every text marked `[fake]`, so the whole page can be seen without a key. Put the key in `.env` and the mode becomes `on`: new runs show the real interpretation, with nothing else to change. See [cli.md](cli.md#llm-modes).

## How it works

- Runs write their progress to `runs/<runId>/events.jsonl` and everything they produced to `result.json` ([metrics.md](metrics.md)). The panel reads them and `run.json`, never writes to the workspace.
- `GET /api/runs`, `/api/runs/:id`, `/api/fixture` and `/api/status` answer JSON; `/api/runs/:id/events` streams new events (Server-Sent Events, checked every 250 ms; a reconnecting browser resumes after the last event it saw); `/api/runs/:id/files/<path>` serves run files read-only (images, HTML report, JSON, logs). A run without a record whose process is gone shows as `interrupted`.
- Safety: only `127.0.0.1`; requests must name the panel as `Host` (no DNS rebinding) and POSTs must come from its own page; file paths with `..`, absolute paths, backslashes or other run ids are refused, and only known file types are served; the page has a strict Content-Security-Policy and loads nothing from the network (fonts are bundled). Untrusted text (PR titles, logs, response bodies) is rendered as text, never as markup.
- The web UI (`packages/panel/web`, Preact) is built with Vite into `packages/panel/dist/web` by `bdiff ui` when its sources changed. The server (`packages/panel/src`) uses Node's `http` module; the CLI injects every adapter (file system, Docker, the suite runner).

## Demo data

`packages/panel/demo/` holds real runs of the fixture repository (`--llm fake`): three successful branches, a docs-only skip and a setup failure (`variant/needs-repair` with the LLM off), plus one run in `live/` whose events are replayed as a run in progress, sped up to 45 s, over and over. To refresh it, run the branches and copy them:

```bash
pnpm bdiff batch "$(pnpm --silent fixture:dataset)" --force --llm fake
pnpm panel:demo .bdiff --live <runId> <runId>…
```

`panel:demo` copies only what the panel shows and replaces local paths (workspace, fixture repository, home directory) so none ends up in the repository.
