---
status: accepted
---

# Each Worker gets its own opt-in, per-Task git worktree while sharing one State Store

ADR-0011 named this decision before it existed: while settling where a whole-Crew worktree's
State Store lives, it explicitly kept "several worktrees, one shared Store" out of scope,
filing it as "the deferred per-Agent-worktrees goal (FR-X07)" — it needed answers about
cross-worktree identity, write contention, and lifecycle that a v1 release did not. This ADR
builds that goal. It is **not** a replacement for ADR-0011's whole-Crew worktree (used only
by `crew team --launch`: one worktree — a separate working copy of the repository sharing the
same history — for the entire launched Crew, short-lived and removed with the session). It is a
second, independent mechanism: **one worktree per Worker per Task**, off by default, and usable
from a manual `crew join` as well as from `--launch`. A Workspace can use either feature, both,
or neither.

**The feature is off by default and switched on through a new `.crew/config.yaml`.**
`src/config.ts` (`loadWorkspaceConfig`, `parseWorkspaceConfig`) parses
`worker_worktrees.enabled` and `worker_worktrees.base_ref` with the same strictness
`launcher/config.ts` already applies to `launcher.yaml` — one flat mapping, no alternative
spellings, unknown keys rejected. If the file or the key is missing, the feature is off
(`enabled: false`) and nothing changes. `base_ref` defaults to the literal `HEAD`, which
`worktree.ts`'s `resolveConcreteBaseRef` turns into a concrete branch name when the worktree is
created; schema v4 refuses to ever store the literal `HEAD`, because a later "has this landed?"
check needs a fixed starting commit — not whatever `HEAD` happens to point at when evaluated
later from some other directory. `CURRENT_SCHEMA_VERSION` moves from 3 to 4: the `tasks` table
gains a triple of columns — `worktree_path`/`worktree_branch`/`worktree_base_ref` — which are
always set and cleared together, enforced by their own CHECK constraint separate from the
existing per-status CHECK matrix (the triple tracks the Task's worktree, not its review
progress); and a new STRICT `review_worktrees` table holds one row per reviewing Agent's own
dedicated worktree.

**A worktree created from a Task's worktree carries the git-tracked `.crew/roles` and
`.crew/teams`, but not the git-ignored `.crew/state/` — so the ordinary Workspace discovery,
run there, would open a second, disconnected State Store instead of the real shared one.** The
alternative considered was teaching `findWorkspaceRoot` to understand git's own worktree
machinery (`git worktree list`, the `.git` file that points back to the main repository) and
find the main working tree that way. That was rejected: it would tie Workspace discovery to git
internals for *every* caller, not just Task worktrees, and a git failure would surface silently
or confusingly. Instead, `crew task start` writes a plain-text pointer file
(`workspace-pointer`, `WORKSPACE_POINTER_BASENAME` in `src/workspace.ts`) into the new
worktree's `.crew/state/`, containing the absolute path back to the real Workspace root
(`writeWorkspacePointer`). `findWorkspaceRoot` looks for this pointer after its normal walk up
the directory tree and, if present, follows it — but only if the target passes the same
is-this-really-a-`.crew/`-directory check that ordinary discovery uses. A missing or broken
pointer target fails loudly with `NOT_WORKSPACE`; it never falls back silently to the local,
disconnected Store. An explicit file you can read and debug beats an inference buried in git
internals.

**A Task's worktree belongs to the Task, not to the Worker.** `crew task start` derives the
worktree's path and branch (`crew/task-<taskId>-<slugified-title>`, `deriveTaskWorktreePath`)
fresh for each Task, rather than reusing one long-lived worktree per Worker, because
`crew task land` deletes the worktree once the Task is done (`removeTaskWorktree` — but only
after `hasUnlandedChanges` has confirmed, via `git status` and
`git merge-base --is-ancestor`, that nothing would be lost). ADR-0014 already lists "worktree
cleanup done" among the conditions a Task must meet before it has "fully landed" and its Worker
may clear its own context; a worktree that outlived its Task would make that condition
permanently impossible to meet. Tying the worktree's lifetime to the Task's is what lets `land`
retire both together.

**The Inspector gets a different kind of worktree: one persistent, reusable worktree per
reviewing Agent, not a fresh one per reviewed Task.** `review_worktrees` holds exactly one row
per `agent_id`, whose `current_ref` is null while the worktree is resting on its own `base_ref`
and holds a Task's branch while a review is under way. `crew task review` fetches this row —
creating it on first use — and then switches the worktree (`checkoutRef`) onto the submitted
Task's branch (`crew/review-<hex-agent-id>`, `deriveReviewWorktreePath`); writing the Agent id
in hexadecimal keeps every valid public Agent id safe to use in a git branch name without
changing the identifier itself. `crew task approve`/`requeue` switch the worktree back to rest
(`restoreReviewWorktreeIfNeeded`) as a best-effort extra step that prints a warning on stderr
instead of failing the approval. The alternative — a fresh worktree per reviewed Task, shaped
like a Worker's — was rejected because it multiplies the places on disk where an Agent might
run `git checkout`, which is exactly the danger worktree isolation
exists to prevent: an Agent switching branches in a place other Agents also depend
on can silently pull that shared directory out from under them. Giving each reviewer exactly
one worktree that it alone controls, and that always returns to a known resting state, keeps
every `git checkout` this feature performs inside a directory no other Agent ever touches.

**`crew task land` sends the ADR-0014 Sign-off itself, instead of requiring a separate
`crew send`.** ADR-0014 already treats "worktree cleanup done, if any" as a condition that must
be true before the Sign-off note is honest — but crew had no way to observe that condition
becoming true, until `land` became the very thing that makes it true. `landTask`
(`src/store/tasks.ts`) sends the existing Sign-off text
(`Task <id>: landed, safe to clear your context.`) to the assignee in the same database
transition that clears the Task's worktree columns, once `land` has removed the worktree and
its branch from disk. This collapses two steps a Manager previously had to sequence correctly
by hand — remove the worktree, then remember to send the note — into one command. A Task that
never had a worktree (feature disabled, or the assignee did not use one) still needs a manual
Sign-off; `land` refuses with `TASK_CONFLICT` when `worktree_path` is null — deliberately,
because there is nothing for it to do.

The consequence: FR-X07 ships as an opt-in addition alongside ADR-0011's whole-Crew worktree,
not as its replacement. A Workspace that never sets `worker_worktrees.enabled` sees no change
in schema behavior, Workspace discovery, or Role prompts, beyond three new nullable Task
columns and a new, empty `review_worktrees` table. Deletion safety (`hasUnlandedChanges`) is
the one place where this feature reasons about git state instead of crew's own database,
because crew knows nothing about GitHub or any remote — "landed" can only ever mean "locally an
ancestor of its base ref," never "merged upstream."
