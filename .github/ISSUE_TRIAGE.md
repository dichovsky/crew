# Issue triage and resolution routine

Instructions for a scheduled Claude routine that triages and resolves GitHub
issues on `dichovsky/crew`. The routine's prompt points at this file in the
checked-out repository and tells the agent to follow it. Written for
unattended, recurring runs — no human is watching in real time, so the
boundaries in each phase's **Action limits** are not suggestions.

Every run has two phases, in order:

- **Phase A — label sweep.** Classify issues that need classifying. Never
  touches code.
- **Phase B — resolve one issue.** Pick exactly one already-classified issue
  and drive it to a verdict: propose closing it, produce a plan for it, or
  implement it and open a pull request.

Phase A always runs. Phase B runs after it, on at most one issue per run.

---

# Phase A — label sweep

## Scope

1. List open issues with
   `gh issue list --state open --json number,title,labels,body,createdAt`.
2. Triage every open issue that has **no labels**, plus any labeled issue
   where a prior triage comment (see **Leaving a triage record**) is older
   than the issue's most recent non-bot comment (i.e. a human replied since
   last triage).
3. Skip issues already carrying `wontfix`, `duplicate`, or `invalid` — those
   are closed decisions, not open triage work.
4. Stop after triaging 25 issues in one run; if more remain, note the
   remainder in the run summary (see **Reporting**) rather than continuing
   unbounded.

## Before labeling anything: verify against current state

This repo's issues cite exact files, lines, and behavior
(`src/templates.ts:33-34`, `docs/design/product-spec.md:87`, etc.). Code and
docs move; an issue that was true when filed may already be fixed, or may
have drifted further. For every issue:

- Open the cited file(s) at the current `main` and re-check the claim. Don't
  trust the issue body as still-accurate.
- If the underlying problem is already fixed, say so in a triage comment and
  apply `invalid` — do **not** close it yourself (see **Action limits**).
- If the problem is confirmed but the specifics have shifted (different line
  numbers, an extra affected file), note the delta in your triage comment
  rather than silently editing the issue body.

## Resolving what "authoritative" means

Before calling something a bug, check whether it's actually a documented,
intentional decision. Authority order (from
[docs/README.md](../docs/README.md)), highest first:

1. Accepted ADRs (`docs/adr/`)
2. SRS (`docs/design/srs.md`) — functional `FR-*` / non-functional `NFR-*`
3. CLI contract (`docs/design/cli-contract.md`) and data model
   (`docs/design/data-model.md`)
4. Architecture (`docs/design/architecture.md`)

The domain vocabulary in [CONTEXT.md](../CONTEXT.md) is binding — an issue
that misuses a term (calls a Task a "job", conflates Submission with Review)
should get a clarifying comment, not necessarily a code-side fix.

If a lower-authority doc disagrees with a higher one, the lower doc is the
bug, not the code. If an issue's premise is that intentional, ADR-documented
behavior is wrong, it's a design disagreement — label `question`, don't wave
it through as `bug`/`enhancement`.

## Classification

Use the repo's existing labels only — do not invent new ones:

| Label | Apply when |
|---|---|
| `bug` | Code behavior contradicts the SRS, an accepted ADR, or its own docstring/comment; or a gate (typecheck/lint/test/coverage) is silently bypassed. |
| `documentation` | The drift is confined to `docs/`, `docs-site/`, `README.md`, `CLAUDE.md`, `AGENTS.md`, or `CONTEXT.md` — code and requirements are already correct. |
| `enhancement` | A working-as-specified gap, process inefficiency (e.g. redundant CI steps), or a net-new capability request ("Idea: ..."). |
| `question` | Ambiguous intent, a design disagreement with an intentional decision, or missing information needed to act. |
| `duplicate` | Substantively the same root cause as another open issue — cross-link both ways, see below. |
| `invalid` | The claim doesn't reproduce against current `main`, or cites something that was already fixed. |
| `good first issue` | Confirmed, narrowly scoped, single-file, no design judgment required. |
| `help wanted` | Confirmed and scoped, but larger or needs domain context beyond a first-time contributor. |
| `wontfix` | Never apply this yourself — see **Action limits**. |
| `triage/close-proposed` | Phase B only. See **Verdicts**. |
| `triage/plan-ready` | Phase B only. See **Verdicts**. |

An issue can carry more than one label (e.g. `bug` + `good first issue`).

### Duplicate detection

Before labeling anything else, search open and recently-closed issues for the
same root cause: `gh issue list --state all --search "<key terms>"`. A
duplicate is the same underlying defect or drift, not just a similar title —
two issues about different stale facts in the same file are not duplicates
of each other. When found:

- Label the newer issue `duplicate`.
- Comment on it linking the original (`Duplicate of #N`).
- Comment on the original cross-linking back, only if it doesn't already
  reference the new one.

## Format for triage comments

Match the terse, evidence-first style already used in this repo's issue
bodies (see #23, #24, #40 for examples: a factual finding citing exact
files/lines, no editorializing). A triage comment should:

- State the verification you did and what you found (confirmed as-is,
  confirmed with a correction, or not reproducible) — cite the file/line you
  checked.
- Name the label(s) applied and, in one line, why.
- If filing a *new* issue during triage (e.g. you found a distinct,
  previously unreported problem while investigating), use this repo's
  existing body shape: a factual description with exact file/line citations,
  a `**Impact:**` paragraph, and a `**Acceptance:**` paragraph — see any of
  #43–#45 for the pattern. Title style: `Area: short description` (e.g.
  `Launcher: worktree teardown policy for crew team stop is undecided`).

Keep comments short. Do not restate the entire issue body back at the
reporter.

## Action limits (Phase A)

**Allowed, no confirmation needed:**

- Reading issues, comments, code, and docs.
- Applying labels from the table above, except `wontfix` and the `triage/*`
  labels (those belong to Phase B).
- Posting triage comments.
- Cross-linking duplicates (comment only, both directions).
- Filing a new issue for a distinct problem discovered during triage, in the
  repo's existing format.

**Never do in Phase A, regardless of how confident the triage is:**

- Close an issue.
- Apply the `wontfix` label (closing-adjacent; a human calls this).
- Edit or delete another user's issue body or comment.
- Change any code. Phase A identifies and labels; it does not fix. Code
  changes happen only in Phase B, and only under Phase B's rules.
- Remove a label someone else applied, other than correcting your own prior
  triage pass.

## Leaving a triage record

Every triage comment implicitly timestamps that pass (GitHub records comment
time). That timestamp is how the next run knows whether a human has replied
since — no separate marker needed. Do not backdate or edit a prior triage
comment instead of posting a new one.

---

# Phase B — resolve one issue

Exactly one issue per run. If nothing is eligible, say so in the run summary
and stop — do not lower the bar to find work.

## Eligibility

An open issue is eligible only if **all** of these hold:

- It carries at least one classification label (Phase A gets first pass).
- It does **not** carry `triage/close-proposed`, `triage/plan-ready`,
  `wontfix`, `duplicate`, or `invalid`.
- It has **no linked open pull request**. Check with
  `gh issue view <n> --json closedByPullRequestsReferences` and
  `gh pr list --state open --search 'in:title,body "#<n>"'`; treat any open PR whose body or
  title references the issue as a link.
- The routine's own most recent comment on it is **not** newer than the
  newest human (non-bot) comment. In other words: once a human replies after
  a routine comment, the issue becomes eligible again.

That last rule is what makes the routine self-healing. If you reject a plan,
close a PR unmerged, or ask for a retry, replying on the issue is enough to
put it back in the queue. Nothing else is needed.

## Selection order

Among eligible issues, take the **first match** walking these tiers in order,
and within a tier the **lowest issue number**:

1. `documentation`
2. `enhancement` scoped to build, CI, tooling, config, or types — the
   infrastructure kind, not a net-new product capability
3. `bug`
4. Everything else remaining, including `question` and net-new capability
   requests (issue titles starting `Idea:`)

Tier 4 items are rarely implementable unattended; expect most of them to end
at PLAN-ONLY or PROPOSE-CLOSE, and that is a correct outcome.

## Assessment

Re-verify the issue against current `main` before deciding anything — the
same rule as Phase A's **Before labeling anything**, and for the same reason:
the cited lines may have moved or the problem may already be fixed.

Then reason explicitly about three things, and record that reasoning in the
comment you post:

- **Blast radius** — which modules, contracts, and published surfaces the fix
  would touch. Consult the module boundaries in `CLAUDE.md`.
- **Reversibility** — how hard the change is to undo once merged and, if it
  reaches a release, once published to npm.
- **Contract impact** — whether it changes anything governed by the authority
  order: an accepted ADR, an `FR-*`/`NFR-*` requirement, the CLI contract, the
  data model, or the State Store schema. A schema change is never isolated —
  it requires a `CURRENT_SCHEMA_VERSION` bump, a `SchemaMigration`, migration
  tests, and a `data-model.md` update in the same change.

Reach exactly one verdict. Be honest about your own appetite: the correct
answer for a large, contract-touching change is PLAN-ONLY even when you are
confident you could implement it.

## Verdicts

| Verdict | Meaning | Action |
|---|---|---|
| **PROPOSE-CLOSE** | The issue should not be acted on: not reproducible on current `main`, already fixed, a duplicate, based on a misreading of an intentional decision, or not worth doing. | Post a comment with the decision and the evidence for it. Apply `triage/close-proposed`. **Do not close the issue and do not apply `wontfix`** — a human reviews the proposal and closes it. |
| **PLAN-ONLY** | Legitimate, but too large or too contract-sensitive to implement in one unattended pass. | Post a comment containing a precise implementation plan (below). Apply `triage/plan-ready`. **Write no code.** A human gives the go-ahead. |
| **IMPLEMENT** | Legitimate and safely completable in this run. | Delegate to the implementer subagent (below), then the reviewer(s). |

### What a PLAN-ONLY plan must contain

Precise enough that a separate agent could execute it without re-deriving the
analysis:

- The exact files to change, and what changes in each.
- Which contract documents must be updated in the same change (ADR, SRS,
  CLI contract, data model) and what each must say.
- The tests to add or update, named, and how they fail before the fix.
- Any decision a human must make first, stated as a question.
- Anything explicitly out of scope.

## Implementation

Delegate to an implementer subagent. Brief it with: the issue number and
body, your verification findings, the plan, the constraints below, the
verification gate, and the required output format.

**Branch discipline (hard rule; see `CONTRIBUTING.md` and `CLAUDE.md`):**

`git checkout main && git pull && git checkout -b feat/<slug>`

Before editing any code, follow `CLAUDE.md`'s baseline checks (confirm the prior work is merged; verify `git branch --show-current`).

Never continue work on a merged branch. One unit of work, one branch, one PR.

**Scope:** every changed line must trace to the issue. Do not improve
adjacent code, comments, or formatting. Do not delete pre-existing dead code.
If you find a distinct problem while implementing, file it as a new issue in
the repo's format — do not fold it into this change.

**Verification gate — all of these must pass before pushing:**

```sh
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run test:coverage   # 95% statements/branches/functions/lines
```

Add or update tests for any changed logic. Tests are not required for
docs-only, config-only, or pure-UI-only changes — say so explicitly in the PR
body when claiming that exemption. Some tests self-skip without tmux
installed; that is expected, and the PR's CI run is authoritative.

**Immediately before pushing**, rebase onto the latest `main`
(`git fetch origin main && git rebase origin/main`) and re-run the gate. Runs
are daily and uncapped, so several routine PRs can be open at once and they
frequently touch the same documentation files.

**Open the pull request as a draft:**

- Title: `<type>: <description>`, matching the commit convention.
- Body includes `Closes #N`, a short statement of what changed and why, the
  verification commands actually run with their results, and a
  **Related open PRs** section listing any other open routine PR that touches
  the same files (`gh pr list --state open --json number,title,files`). Say
  "none" when there are none.

```sh
gh pr create --draft --title "<type>: <description>" --body "<body>"
```

## Review

Run the reviewer subagents against the PR diff. Roster depends on what
changed:

| Condition | Reviewer |
|---|---|
| Always | general code reviewer |
| Diff touches `src/`, `tests/`, `bin/`, `web/`, or `docs-site/` | TypeScript reviewer |
| Diff touches `src/store/`, `src/process.ts`, `src/which.ts`, `src/fs-safe.ts`, `src/setup/`, or the Launcher | security reviewer |
| Docs-only diff | Instead of the TypeScript reviewer, verify the new prose against the code it describes and against the authority order in Phase A |

Post the findings as a PR review (`gh pr review --comment`), tagged
CRITICAL / HIGH / MEDIUM / LOW.

**On CRITICAL or HIGH findings:** the implementer gets **exactly one** fix
pass, then the reviewer re-checks the changed areas only. There is no second
round.

- Nothing CRITICAL or HIGH survives → mark the PR ready for review
  (`gh pr ready <n>`).
- Anything CRITICAL or HIGH survives → leave the PR as a draft, leave the
  findings posted, and flag it in the run summary as needing a human.

## Action limits (Phase B)

**Allowed:**

- Applying `triage/close-proposed` and `triage/plan-ready`.
- Posting assessment comments, implementation plans, and PR reviews.
- Creating a branch, committing, pushing, and opening a draft PR.
- Marking the routine's own PR ready for review after a clean review.

**Never do:**

- Close an issue, or apply `wontfix`.
- Push to `main`, or merge any pull request.
- Approve a pull request (`gh pr review --approve`) — the routine does not
  approve its own work.
- Force-push, rewrite published history, or delete a branch someone else
  created.
- Work on more than one issue per run.
- Edit or delete another user's issue body or comment.

---

# Applies to both phases

## Security-sensitive issues

If an issue reports something security-sensitive (auth, secrets, injection,
data exposure), leave it unlabeled, do not discuss specifics in a public
comment, do not implement a fix, and flag it in the run summary instead — a
human should route those directly, not the routine.

## Reporting

End each run with a short summary:

- **Phase A** — counts by label applied, issues marked `invalid` with why,
  duplicates linked, new issues filed, anything skipped past the 25-issue cap.
- **Phase B** — the issue selected and why it was first in tier order (or that
  nothing was eligible), the verdict with its blast-radius / reversibility /
  contract-impact reasoning, labels applied, the PR link, the review outcome,
  and whether the PR is ready for review or still a draft awaiting a human.
- Anything withheld under the security exception above.
