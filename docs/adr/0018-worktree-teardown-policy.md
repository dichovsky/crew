---
status: accepted
---

# Stopping a Team never removes its Worktree

## Context

[ADR-0011](./0011-worktree-store-location.md) gave a launched Crew an optional whole-Crew
Worktree — a separate working copy of the repository, checked out on its own branch — and
decided that the Crew lives entirely inside it: its State Store, its generated artifacts, and
every pane's working directory. `preflightLaunch` (`src/launcher/session.ts`) resolves that
Worktree (creating it, or reusing one that already exists) as the last thing it does before
tmux is touched, and `runLiveLaunch` then uses it as the launch root for everything that
follows.

Exactly one path removes such a Worktree today, and it is narrow on purpose. If the build after
`new-session` throws, the catch in `runLiveLaunch` tears the owned session down and — only when
that teardown is **confirmed**, and only when the resolution's action was `create` — calls
`removeCreatedWorktree`, a best-effort `git worktree remove --force`. A **reused** Worktree
pre-existed the launch and is never removed even then, mirroring the same "never touch anything
that existed before this invocation" invariant that governs the session itself
([ADR-0008](./0008-relay-process-model-and-live-launch.md),
[ADR-0010](./0010-launch-token-provenance-and-scoped-reap.md)).

Nothing removes the Worktree of a launch that **succeeded**. `crew team stop`
(`src/launcher/stop.ts`) reads the crew-written pane-map as its ownership proof, requires the
live tmux session's marker to match, kills the session through the tmux adapter, archives the
Agents the pane-map names, writes the clean-stop marker, and retires the pane-map. It spawns no
`git` at all, and the only file it deletes is the pane-map it wrote itself. The same is true of
the Console's stop action, which calls straight into `runTeamStop`.

Issue #4 recorded that as an undecided question rather than a decision: the absence of a
teardown had been observed, but no ADR said whether it was the intended behavior or a gap.
[ADR-0015](./0015-per-worker-task-worktrees.md) makes the ambiguity concrete — in passing, while
distinguishing its per-Task Worker Worktrees from ADR-0011's whole-Crew one, it describes the
latter as "short-lived and removed with the session." That parenthetical describes an intention
nobody built; the code has never done it. This ADR is the correction, and since accepted ADRs
sit at the top of the authority order, its wording — not ADR-0015's aside — is what the rest of
the documentation and the code must match.

Note that none of this is in tension with ADR-0015's own lifecycle. A **Task** Worktree and a
**Review** Worktree are removed by `task land` and `task abandon` (`removeTaskWorktree`, guarded
by `hasUnlandedChanges`), because a Task has a definite end that crew itself observes. A
launched Crew's Worktree has no such moment: stopping a session is a statement about tmux, not
about the work in the tree.

## Decision

**`crew team stop` never removes a Worktree.** The Worktree the stopped session was running in
is left exactly as the session left it — files, branch, and git's own worktree bookkeeping
untouched — and removing it is the Operator's own `git worktree remove`. This is a decision to
keep the current behavior, not a change to it: the policy is now recorded, required (FR-U27),
stated in the CLI contract, and pinned by a test, so that it can only change deliberately.

The reason is that a Worktree is where a Worker's output lives. At the moment a stop runs, that
tree can hold uncommitted edits, untracked files, and a branch that has not landed anywhere, and
crew has no way to know that the Operator is finished with any of it — the session ending says
nothing about the work. Deleting it would be precisely the irreversible, unprompted act that a
coordination tool must not take. crew coordinates; it does not decide.

**No `--remove-worktree` flag.** An opt-in teardown was considered and rejected. It cannot be
just a flag: `git worktree remove` refuses a dirty tree, so the flag needs a dirty-state
policy — refuse, or accept a second `--force` — plus its own error code shape, its own contract
paragraph, and tests for each branch. All of that buys a convenience the Operator already has in
one command that git documents better than crew could, and every path it adds is a path along
which crew can destroy work. The right place to decide "am I done with this tree?" is the shell
the Operator is already standing in.

**No "remove it when crew created it and the tree is clean" heuristic.** This is the tempting
one, because it looks symmetric with the failed-build teardown above, and it is the one most
firmly rejected. The two situations are not symmetric at all: after a failed build, nothing ever
ran in the Worktree, so there is provably nothing to lose; after a successful session, the tree
is the entire product of the run. And "clean" would be carrying far more weight than it can
bear — `git status` says nothing about a stash, and an ignored build artifact or a `.env` the
Operator put there deliberately is invisible to it. A heuristic that silently deletes on a
wrong guess is worse than no teardown at all, because the failure is unattributable: by the time
anyone notices, the evidence is what was removed.

**No dirty-state guard, because the policy makes one unnecessary.** A guard exists to decide
whether a removal is safe. Under this policy crew never attempts a removal from `team stop`, so
there is no decision for a guard to make, and adding one would only imply the removal it is
guarding exists.

**The failed-build teardown keeps its current, narrow shape.** `removeCreatedWorktree` is
untouched by this decision: it removes only a Worktree that this very invocation created, only
after a confirmed teardown of the session that used it as its working directory, and never a
reused one. Its justification is that the Worktree was created seconds earlier by a launch that
never reached a running Crew — the one case where crew genuinely knows the tree holds nothing.

## Consequences

- Worktrees accumulate. Every launched-and-stopped Crew leaves its Worktree and its branch
  behind, and a repository that hosts many launches collects many of them. This is the honest
  cost of the decision and it is accepted deliberately: cleanup is the Operator's, via
  `git worktree remove <path>` (and `git worktree prune` / `git branch -d` for what remains).
  crew reports what it left — the launch prints the Worktree it resolved — but it will not tidy
  it up.
- `crew team stop`'s blast radius is now a stated boundary, not an accident of implementation.
  It kills the tmux session, archives the pane-map's Agents, and rewrites its own generated
  files under `.crew/generated/<session>/`; it touches nothing else. FR-U27 says so and
  `tests/integration/commands/team-stop.test.ts` pins it, so a future change that makes `stop`
  spawn a `git worktree remove` fails a test rather than shipping quietly.
- ADR-0015's description of the whole-Crew Worktree as "removed with the session" is superseded
  by this ADR on that one point. Its own subject — per-Task Worker Worktrees and the persistent
  Review Worktree, whose removal `task land`/`task abandon` own — is unaffected.
- Reopening this is cheap. Nothing here forecloses a later opt-in teardown: because the decision
  is "crew never removes it," adding a removal would be a new capability with its own ADR, FR,
  and dirty-state policy, rather than a quiet loosening of an existing one.
