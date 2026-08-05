# Issue triage routine

Instructions for a scheduled Claude routine that triages GitHub issues on
`dichovsky/crew`. The routine's prompt points at `.github/ISSUE_TRIAGE.md` in
the checked-out repository and tells the agent to follow it. Written for
unattended, recurring runs — no human is watching in real time, so the
boundaries in **Action limits** are not suggestions.

## Scope

Each run:

1. List open issues with `gh issue list --state open --json number,title,labels,body,createdAt`.
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

## Action limits

**Allowed, no confirmation needed:**

- Reading issues, comments, code, and docs.
- Applying labels from the table above, except `wontfix`.
- Posting triage comments.
- Cross-linking duplicates (comment only, both directions).
- Filing a new issue for a distinct problem discovered during triage, in the
  repo's existing format.

**Never do, regardless of how confident the triage is:**

- Close an issue.
- Apply the `wontfix` label (closing-adjacent; a human calls this).
- Edit or delete another user's issue body or comment.
- Merge or push code changes as part of triage — triage identifies and
  labels, it does not fix. If a fix is trivial, say so in the comment and
  leave it for a separate task.
- Remove a label someone else applied, other than correcting your own prior
  triage pass.

If an issue reports something security-sensitive (auth, secrets, injection,
data exposure), leave it unlabeled, do not discuss specifics in a public
comment, and flag it in the run summary instead — a human should route those
directly, not the routine.

## Leaving a triage record

Every triage comment implicitly timestamps that pass (GitHub records comment
time). That timestamp is how the next run knows whether a human has replied
since — no separate marker needed. Do not backdate or edit a prior triage
comment instead of posting a new one.

## Reporting

End each run with a short summary (routine output, not necessarily posted
anywhere): counts by label applied, issues marked `invalid` with why,
duplicates linked, any new issues filed, and anything skipped past the
25-issue cap or held back for the security exception above.
