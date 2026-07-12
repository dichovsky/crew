---
status: accepted
---

# Deterministic launch plan with a side-effect-free `--print`

`crew team <name> --launch` first resolves everything a launch needs — configuration, roster,
client, worktree, Task brief, and the files to be generated — into one validated launch plan
**before** it changes anything: no state write, no filesystem write, no subprocess, no tmux
(FR-H03). The plan is deterministic: the same inputs always produce exactly the same plan.
`--print` prints that plan and stops, with **zero** side effects (FR-H04): it works out what the
worktree path would be but runs no git, writes no files, and starts no tmux. The plan is one
nested JSON document (`launch-plan.json`, `schema_version: 1`), and `--print --json` prints
exactly those bytes. That is a deliberate exception to crew's usual machine output, where each
line is a separate JSON object (NDJSON): the plan is a single versioned document, and it doubles
as the stable fixture that compatibility tests compare against — the same canonical serializer
produces both the printed output and the plan file the live launch writes to disk.

The helpers that do have side effects — the git worktree resolver and
the safe process-spawning path that passes arguments as an array with `shell:false`, so no shell
ever interprets them (FR-H09/H11/H21) — were built and tested first against a recording process
adapter that logs calls instead of running them; no production code path executed them for real
at that stage. Actually launching tmux (bare `--launch` without `--print`) was therefore
deferred to the live-launch work (ADR-0008): until it landed, bare `--launch` failed with
`USAGE` (exit 2) and pointed the operator at `--print`. The git worktree resolver
talks to git only through the existing capture-only `Io.runProcess`, using the `git -C <dir>`
argument form, so the `Io` interface — the boundary where crew's environment access can be
swapped out in tests — gains nothing new until the live launch (ADR-0008) adds its long-lived
streaming process method.
