# Building the dataset

The experiment runs `bdiff batch` over a curated `datasets/dataset.json` of real pull requests (target: 10–15 repositories, at least 40 PRs). `pnpm candidates` produces the list to choose from.

## `pnpm candidates`

```bash
GITHUB_TOKEN=$(gh auth token) pnpm candidates [--out datasets] [--months 6] [--max-repos 60] [--validate]
```

1. **Repositories.** GitHub's repository search for the topics `nextjs`, `next` and `next-js`. A repository qualifies when it:
   - is written in TypeScript;
   - has ≥ 200 stars;
   - was pushed in the last `--months`;
   - is not archived and has a license;
   - has a `package.json` (at most three levels deep) depending on `next`. That `package.json`'s directory is the app root.

   At most `--max-repos` repositories are examined.

2. **Pull requests.** For each repository, at most 25 PRs merged in the same window are examined. A PR is kept only if it changes at most 30 files, is not one bdiff would skip (only docs, tests, CI config or lockfiles), and is not a dependency update (only `package.json` and lockfiles).
3. **Tags.**
   - `prType` comes from the changed paths:
     - `api`: App Router `route.*` files and `pages/api/`;
     - `ui`: pages, layouts, components and styles;
     - `mixed`: both;
     - `refactor`: neither.
   - `author` is `agent` for logins ending in `[bot]` and the logins in `scripts/agent-authors.json`, `human` otherwise.
   - `difficulty` is `easy` when the repository has no Prisma or Drizzle schema and either has an example env file or no env schema file (`env.ts`, `env.mjs`); `realistic` otherwise.
4. **Ranking.** The score (0–1) favors `ui` and `api` changes over `mixed` and `refactor`, `easy` over `realistic`, and small PRs. At most 8 candidates per repository are kept, best first.

GitHub responses are cached for 24 hours in `<cache>/github/` (`BDIFF_CACHE_DIR`, default `~/.cache/bdiff`), so running it again within a day costs no API requests. Rate limits are respected: the script waits and retries.

With `--validate`, every candidate is also checked with bdiff's workspace and recipe stages: clone, check out base and head, detect a recipe. No container is built and no LLM is called. Each candidate gets a `validation` field: `ok` with the recipe's confidence, or the error code.

## Output

- `datasets/candidates.json`: `generatedAt`, `since`, `repos` and the ranked `candidates`. Each candidate carries:
  - the dataset entry fields `id`, `repoUrl`, `prNumber`, `baseRef` (the PR's base commit), `headRef` (its head commit) and `tags`;
  - `title`, `url`, `author`, `mergedAt`, `changedFiles`;
  - `repo` (`fullName`, `stars`, `signals`), `score` and `validation`.
- `datasets/candidates.md`: the same as a table, for reading.

## Curating `dataset.json`

1. Copy the chosen candidates' dataset fields (`id` through `tags`) into `datasets/dataset.json` as `{ "entries": [ … ] }`. Every tag can be corrected by hand. Tag a PR that should not change behavior `prType: refactor`, since the false-difference criterion counts on it.
2. Run `pnpm bdiff batch datasets/dataset.json`, then `pnpm bdiff stats --by prType` (see [cli.md](cli.md)).
