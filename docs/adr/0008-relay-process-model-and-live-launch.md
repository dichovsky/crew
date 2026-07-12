---
status: accepted
---

# The Relay is an internal node subcommand; the live launch owns one tmux session

ADR-0001 established that launched mode may run one Relay per tmux session — a helper that
checks each Agent's Inbox for unread Messages without reading their content or marking them
read, and types a fixed wake-up line into the panes. This ADR records the implementation of
that Relay and the live tmux Launcher. Four choices carried real weight and would be hard to
reverse.

**The Relay is a hidden node subcommand, not a shell script.** An earlier sketch had the Relay
as a shell script (`scripts/crew-relay.sh`), but the Relay's core logic — the per-Agent throttle rules (nudge when
`max_unread_id` grew, OR when the reminder interval passed with Messages still unread), Agent-id
validation, and the loop over many Agents — sits close to the security boundary and must be
unit-testable. So it ships as `crew relay --internal --session <name>`, run as the command of a
`crew-relay` tmux window. That gives one packaged build output (`dist/`), fully typed, with the
decision logic isolated in a pure function (`relayStep`) — same inputs, same output, no side
effects — and the loop reduced to a thin timer that feeds it through injected dependencies. The
Relay reads Inbox state by calling the **same** `getPendingSummary` query that the
`crew pending --summary` command uses, over one long-lived read-only Store connection — it does
not spawn a `crew pending` process on every poll. SQLite's write-ahead-logging mode makes one
persistent reader the natural fit and avoids starting a new process every few seconds. The Relay
never runs `receive` and never types Message content.

**A new `Io.runInteractive` method backs `tmux attach`.** The existing `runProcess` captures a
process's output and enforces a timeout — the wrong shape for the one process crew starts that
takes over the terminal, runs in the foreground, and may run indefinitely. `runInteractive` is
its opposite: the child inherits the terminal directly, there is no timeout, and the call
resolves with the exit code. Every other tmux and git call stays on the bounded `runProcess`.

**The live launch owns exactly the tmux session it creates.** If a session with the derived name
already exists, the launch refuses with `ALREADY_EXISTS` — crew never builds on top of a session
it did not create. Ownership begins the moment `new-session` succeeds; from then on, a guard
tears down the whole owned session if anything fails. Agent rows that already joined the Store
are left in place for `doctor` or a retry rather than deleted on the failure path — crew avoids
destructive database writes at exactly the moment things are going wrong. Readiness is checked
in two stages: the pane's process name must match and a settle delay must pass before the launch
command is pasted in; after that, the Agent registering itself in the Store is the real proof of
success. The pane-map file is written as soon as the participant panes exist — before any
readiness or roster waiting — so `crew team stop <session>` can still prove ownership and tear
down a half-built session even if the launch process dies before the Relay window is created.

**Worktree-enabled live launch was deferred, then wired.** When the launch uses an isolated
worktree — a separate working copy of the repository sharing the same history — it was never
specified where the launched Crew's State Store should live, and the answer interacted with the
deferred "share one Store" goal. So launching live into a worktree was refused (`USAGE`) while
`--print` still showed the derived worktree path; the decision, and the end-to-end test that
launches a fake Participant in real tmux, came later. **Update
(ADR-0011):** the Store-location question is settled — a launched Crew inside a
worktree uses the worktree's own short-lived, worktree-local Store, found through the ordinary
`.crew/` discovery; this is deliberately *not* a redirect back to the main workspace's Store —
and the full fake-Participant real-tmux launch e2e ships. **Update:**
the `USAGE` refusal is gone — `preflightLaunch` now resolves or creates the worktree before any
tmux change, and the entire live launch (Store, generated files, pane working directory) runs
inside it; see ADR-0011 for the full wiring and failure-cleanup details.

The consequence: automatic wake-up in launched mode is real but bounded — one tmux session, one
session-scoped Relay that watches without consuming anything, and a clean teardown that never
touches a session crew did not create.
