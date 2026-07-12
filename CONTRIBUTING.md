# Contributing to crew

Thanks for helping improve crew. This guide explains how to work on the code locally and
which conventions CI checks for.

## Prerequisites

- **Node.js `>=24.15`** — crew will not run on anything older. The State Store (crew's
  shared SQLite database) uses the `node:sqlite` module built into Node itself, and that
  module only exists in Node 24+; there is no SQLite dependency in `package.json`.
- **tmux** for the launcher/Relay tests (`brew install tmux` / `apt-get install tmux`).
  tmux is a tool that splits one terminal into several panes; crew's Launcher drives it.
  In CI the test against real tmux must pass (`CREW_REQUIRE_TMUX=1` turns a missing tmux
  into a failure); on your machine the same test simply skips itself when tmux is not
  installed.

```sh
npm install
```

## Commands

```sh
npm run build          # tsc -p tsconfig.build.json → dist/ (the publishable artifact)
npm run typecheck      # tsc -p tsconfig.json (noEmit, includes tests)
npm run lint           # eslint . (type-checked rules; lint:fix to autofix)
npm run format         # prettier --write . (format:check in CI)
npm test               # vitest run
npm run test:coverage  # vitest run --coverage (95% threshold: statements/branches/functions/lines)

# A single file or a named test:
npx vitest run tests/unit/format.test.ts
npx vitest run -t "rejects a non-empty version-0 database"
```

CI runs **typecheck → lint → format:check → build → test** on GitHub's hosted runners,
at Node `24.18.0`. Every step must pass, so run the same commands locally before
pushing.

## Two-tier CI

- **Fast tier** (`ci.yml`, every PR): all the checks above, plus a short
  stress run that forces several processes to compete for the database at once
  (`CREW_STRESS_ITERS=25`), and an `npm publish --dry-run` job that proves the package
  could be published without actually publishing anything. TypeScript, lint, and format
  must all be green.
- **Full tier** (nightly, started by hand via `workflow_dispatch`, or triggered by a PR
  label):
  - `stress.yml` — the heavy version of the database-contention stress: hundreds of
    iterations across a matrix of settings (the `stress-full` label). When it fails, it
    uploads the random seed, the timings that actually occurred, and a copy of the
    failing database, so the failure can be reproduced.
  - `launch-e2e.yml` — the full end-to-end launch test, which drives real tmux with a
    fake Participant CLI (the `launch-e2e` label). Locally it runs only when
    `CREW_LAUNCH_E2E=1` is set, so a normal per-PR `npm test` shows it as a visible skip
    instead of silently leaving it out.

If a full-tier run fails only some of the time, treat that as a release blocker. Do not
just rerun it and hope it passes.

## Branch discipline

Each unit of work ships as its own branch and its own reviewed PR, started from the
latest `main`:

```sh
git checkout main && git pull && git checkout -b feat/<slug>
```

Never continue new work on a branch that has already been merged. Keep refactors,
dead-code removal, and new features in separate commits. Commit messages follow
`type: description` (feat / fix / refactor / docs / test / chore / perf / ci) and explain
**why** the change was made, not just what changed.

## Docs are the contract

`docs/` defines what the code must do — it is the implementation contract, not background
reading. When the source code and the docs disagree, the documents rank in this authority
order (see [`docs/README.md`](./docs/README.md)): accepted **ADRs** (Architecture
Decision Records — write-ups of decisions that would be hard to reverse) →
the **requirements specification** → **CLI contract** + **data model** →
**architecture**. The domain vocabulary in [`CONTEXT.md`](./CONTEXT.md) is
binding: for example, a Worker produces a _Submission_, and only an Inspector's _Review_
_completes_ a _Task_ — the two are not the same thing.

A change in behavior must update the requirements, the CLI contract, and the tests in
the **same** change. A change to the database schema must update
the data model, the migration tests, and `user_version` together. Add or update tests for
any changed logic (the repo enforces at least 95% coverage on statements, branches,
functions, and lines); tests are not applicable for docs-only changes.

## Before you open a PR

- `npm run typecheck && npm run lint && npm run format:check && npm run build && npm test`
  are all green.
- The matching docs-as-contract updates land in the same PR as the behavior change.
- The PR description explains why the change is needed and includes a test plan.
