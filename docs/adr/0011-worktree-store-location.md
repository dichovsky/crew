---
status: accepted
---

# A launched Crew inside a git worktree uses the worktree's own ephemeral State Store

ADR-0008 deferred launching live into a git worktree — a separate working copy of the
repository that shares the same history — for exactly one reason: nobody had decided *where the
launched Crew's State Store lives* in that case. A whole-Crew worktree checks out the tracked
configuration (`roles/`, `teams/`, `launcher.yaml`) but not the git-ignored `state/` directory,
so the launched panes could either open a fresh Store inside the worktree or be pointed back at
the original workspace's Store through some override. This ADR settles that contract.
The wiring stayed deferred at first; the contract did not.

**A launched Crew inside a worktree uses the worktree's own Store, found the same way as
everywhere else.** `crew` locates its Workspace by walking up the directory tree to the nearest
`.crew/` directory (`workspace.ts`). Panes started with the worktree as their working directory
therefore find the *worktree's* `.crew/` and open a fresh `state/crew.db` local to that
worktree. This adds **no new mechanism at all** — no setting that overrides the Store location,
no environment-variable redirect, no second discovery rule. The launched Crew's Agent
registrations, Inboxes, Tasks, and Relay all live inside the worktree and are removed together
with it.

**This is deliberately NOT a redirect to a shared main Store.** Making a worktree launch write
into the original workspace's Store is a *different* feature — "several worktrees, one shared
Store" — tracked separately as the deferred per-Agent-worktrees goal (FR-X07). That goal needs
answers about cross-worktree identity, write contention, and lifecycle that a v1 release does
not; folding it into "run a Crew in a worktree" would sneak an unproven shared-state design
into the launch path. The two are kept apart on purpose: the short-lived, worktree-local Store
is the v1 contract; a shared Store is a future change that must justify itself separately.

**The short-lived Store is a feature, not a limitation.** Because the worktree's `state/` is
git-ignored and belongs to that worktree alone, removing the worktree (`git worktree remove`)
cleanly discards its Crew state — no leftover rows in a shared database, no id collisions
between worktrees. A worktree Crew is as disposable as the worktree itself.

**Update: the wiring has landed.** `preflightLaunch`
(`src/launcher/session.ts`) resolves the single whole-Crew worktree — through the existing
`resolveWorktree` (`src/launcher/worktree.ts`) — as the very last step of preflight, after
every read-only check and strictly before anything touches tmux. Everything downstream in the
live launch (each pane's working directory, `openWorkspaceStore`,
`writePlanArtifacts`/`writePaneMap`) then runs against the resolved worktree path instead of
the original workspace root. That is exactly the "no new mechanism" discovery this ADR
describes: the only thing that changed is the pane's own working directory. The old `USAGE`
refusal in `src/launcher/index.ts` is gone.

**Failure cleanup is deliberately uneven.** If the launch fails after creating a NEW worktree
for this run, the owned-session teardown removes that worktree (`git worktree remove --force`)
— but only once the tmux session teardown is *confirmed*. An unconfirmed teardown may still
have live processes working inside the worktree, so in that case it is left alone. A REUSED
(pre-existing) worktree is never removed on failure, mirroring the standing rule that crew
never touches a tmux session it did not create. A **successfully** launched worktree is never
removed by this change — what happens to it after the live session ends is out of scope here.

**`crew team stop` needed no code change.** Because `resolveWorkspaceRoot` already walks up to
the nearest `.crew/`, running `crew team stop <session>` from inside (or below) the worktree
finds that worktree's own pane-map and Store exactly as it would in any other workspace.
Operators manage a worktree-launched session by changing into the worktree directory first;
there is no `--worktree` override flag on `stop` and no pointer file left behind in the
original workspace, in keeping with this ADR's view of the worktree as fully self-contained
and disposable.

An end-to-end test launches a fake Participant
in real tmux and proves the whole live path (readiness check → each pane runs `crew join` →
Manager brief → Relay nudge → each Message received exactly once → teardown stops the Relay)
against the worktree-local discovery this ADR fixes. See ADR-0008 for the Relay and live-launch
model this refines.

The consequence: the Store-location question that blocked ADR-0008 is answered — a worktree
Crew is short-lived and self-contained — and the live launch now actually creates and tears
down that worktree. The one-shared-Store direction (FR-X07) remains an explicit, deferred item,
and the question of what happens to a successfully launched worktree afterwards is deferred
separately.
