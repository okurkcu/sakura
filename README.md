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

## Layout

| Path              | Purpose                                                    |
| ----------------- | ---------------------------------------------------------- |
| `packages/core`   | Engine: domain types, pipeline, stages, adapters.          |
| `packages/report` | Renders a run result into a self-contained HTML report.    |
| `packages/cli`    | Command-line entry point; wires real adapters into core.   |
| `tests`           | Repo-level tooling tests (e.g. package import boundaries). |
