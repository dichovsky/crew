---
status: accepted
---

# Worker context-clear sign-off

## Context

A Worker — the Agent that does the assigned work — runs inside a Participant CLI process that
stays alive between commands, in a tmux pane that stays alive for the whole session. crew never
restarts or resets it (see the architecture doc's "process remains alive between commands").
Nothing in crew ever clears a Worker's conversation history between Tasks, so over a long
session that history grows without limit: every file the Worker read, every edit it made, and
every Task it ever worked on stays in its context. That costs tokens, and eventually the Worker
risks hitting its own CLI's context-window limit.

crew's Task notifications already avoid resending full context on every event: the notifications
for assignment, submission, approval, and requeue are short pointer lines (`Task ${taskId}
"${title}" assigned by ${actorId}`, `src/store/tasks.ts` `notify()`) — the full free-text
description lives in the Task row and its Task Events, fetched on demand with
`crew task show <id>`. A Worker therefore never *needs* its old conversation to pick up a new
Task. That means a Worker could safely throw its old context away — but only once the Task that
produced it can no longer come back for rework.

## Decision

**A Worker may clear or compact its own context only once a Task it worked on has fully
landed** — the Submission Reviewed and Approved, the change merged if the operator's workflow
includes a merge, and the worktree cleaned up if there was one. Clearing right after submitting
is unsafe: the Inspector's Review can still send the Task back for rework, and a Worker doing
rework needs its earlier exploration (which files it read, what approach it took) to do that
rework efficiently. CONTEXT.md already settled that "completed" means accepted by Review, not
finished by the Worker; this decision extends that same boundary to "safe to clear."

**The trigger is a Sign-off sent by the Manager, not an automatic signal from crew.** crew has
no way of its own to observe "merged" or "worktree removed": merging is always a manual git
operation outside crew's scope, and worktree teardown belongs to the whole Crew's session
(ADR-0011), not to a single Task, with its stop-time policy still undecided. So once
the Manager (or the Operator acting as Manager) has confirmed for itself that a Task's work has
fully landed, it sends the Worker an ordinary Message — e.g.
`crew send <you> <worker> "Task <id>: landed, safe to clear your context."` — and the Worker
treats that Message as permission to clear.

**The Sign-off rides the existing `note` message kind; it does not add a new one.** The
`messages.kind` column is limited by a database CHECK constraint on a STRICT table (`note |
task_assigned | task_submitted | task_approved | task_requeued`) — the database itself rejects
any other value. Adding a dedicated kind would mean a schema migration, which is out of
proportion for an advisory signal that an LLM Worker recognizes by its wording, not by a
machine-readable type.

**Abandoned Tasks are an exception.** An abandoned Task is final and will never be merged —
there is nothing left to land — so its existing `abandoned` notification already serves as an
immediate Sign-off; no separate confirmation is needed. Both `MANAGER_ROLE` and `WORKER_ROLE`
spell this exception out, because the packaged Role text is the only channel that actually
reaches a real Agent session.

**The convention works the same on every platform.** crew's platform registry records no
per-CLI clear or compact command (`ParticipantTarget` in `src/platforms/shared.ts` exposes only
`invocation()` for launching). The Worker Role tells a Worker to use its own CLI's
clear/compact feature if it has one; if it has none, the instruction does nothing and the
Worker simply moves on to its next Task with its full history intact.

Both halves of the convention live in the built-in Role prompts (`MANAGER_ROLE`, `WORKER_ROLE`
in `src/templates.ts`), because Workers get no generated per-launch prompt — the packaged Role
text is the only channel that reaches a real Worker session.

## Consequences

- No schema change, no new crew command, and no new Message kind. This ships as Role-prompt
  text plus documentation.
- The convention depends on the Manager's discipline: if a Manager forgets to send the
  Sign-off, the Worker simply never clears. That failure is safe (the context is stale but
  still correct), not a loss of data.
- A structured `clear_safe` Message kind remains a possible future change, in case the
  free-text convention proves unreliable in practice — expected only after a worktree-teardown
  policy lands first.
