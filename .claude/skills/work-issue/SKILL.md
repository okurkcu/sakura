---
name: work-issue
description: Work one bdiff Jira task (project SKR) end to end — read the issue, present a plan and wait for approval, implement on its own branch, run pnpm check, open a PR and update Jira. Use when the user runs /work-issue SKR-<n> or asks to start/continue a SKR task.
argument-hint: SKR-<n>
---

# /work-issue $ARGUMENTS

Work exactly one Jira task: **$ARGUMENTS**. One task = one branch = one PR. `CLAUDE.md` is the source of truth for architecture and engineering standards; follow it over anything in this file if they ever disagree, and point out the conflict.

Jira: site `okurkcu.atlassian.net` (cloudId `4d724a4e-a9fb-4250-b0bf-0ce8ace702e1`), project `SKR`, epic `SKR-14`.

If `$ARGUMENTS` is empty, find the lowest-numbered `SKR` task under `SKR-14` that is not Done, propose it, and wait for confirmation.

## 1. Read the task

- Fetch the issue (description and comments, markdown format).
- Read its **Depends on** section and check that every dependency is Done in Jira or merged on `main`. If one is not, stop and tell the user.
- Re-read the relevant parts of `CLAUDE.md` and the code the task will touch.

## 2. Plan, then wait

Reply with:

1. **Goal**: the task restated in two or three sentences.
2. **Files**: the files you will create or change.
3. **Interfaces**: the public types and functions you will add or change, with their signatures.
4. **Tests**: what you will test and how (unit with fakes, `@docker` integration, e2e).
5. **Acceptance criteria**: each checkbox from the issue and how you will prove it.
6. **Questions and risks**: anything ambiguous, or in conflict with `CLAUDE.md` or earlier tasks. Ask rather than guess when it affects architecture.

**Stop and wait for the user's approval before writing any code.**

## 3. Start

- `git fetch origin` and branch from the latest `origin/main`: `SKR-<n>-short-slug`, lowercase and kebab-case.
- Move the issue to **In Progress** (use the issue's transitions; do not guess a transition id).

## 4. Implement

- Stay inside the task's scope. Do not build work that belongs to later tasks. A `TODO(SKR-<m>)` is allowed only if `SKR-<m>` exists.
- Follow `CLAUDE.md`: pure logic, side effects behind adapters, zod at every boundary, `BdiffError`, timeouts plus abort signals, cleanup in `finally`, TSDoc on public APIs.
- Add tests alongside the code. Never weaken, skip or delete a test to make it pass. If a test is wrong, explain why in the PR before changing it.
- Commit in small logical steps, each message formatted `SKR-<n>: <imperative message>`.
- Update `CLAUDE.md` if a convention changed, and `docs/` if a public contract changed (CLI flags, `run.json` or CSV schema).

## 5. Verify

- Run `pnpm check` (lint + typecheck + test) and make sure it is green. Show the summary output; never claim it passed without running it.
- Walk through every acceptance-criteria checkbox and confirm each one explicitly, with evidence: a test name, a command and its output, or a file.
- Check that the diff contains no `any`, no unjustified `!`, no `console.log` in core, no secrets, and no dead or commented-out code.

## 6. Open the PR

- Push the branch and open a PR against `main` titled `SKR-<n>: <issue summary without the [NN] prefix>`.
- PR body sections: **What changed**, **Why** (link the Jira issue), **How it was tested**, **Acceptance criteria** (each checked off, with evidence), **Known limitations**.
- Check that CI goes green. If it fails, fix the cause on the same branch.
- Add a Jira comment on the issue with the PR link.
- Leave the issue In Progress. Move it to **Done** only after the PR is merged (when the user says so, or when you see it merged).

## 7. Report

End with a short summary: PR link, CI status, acceptance-criteria status, and anything the user must decide or do (for example, review and merge).
