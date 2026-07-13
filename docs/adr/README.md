# Architecture Decision Records

| ADR | Status | Decision |
|---|---|---|
| [0001](./0001-one-shot-core-session-relay.md) | accepted | every command runs once and exits; wake-up comes from an optional per-session Relay |
| [0002](./0002-local-sqlite-state-store.md) | accepted | one local SQLite State Store |
| [0003](./0003-separate-config-from-runtime-state.md) | accepted | track config in git, ignore only runtime state |
| [0004](./0004-reviewed-task-lifecycle.md) | accepted | reviewed Task lifecycle and Task Events |
| [0005](./0005-at-most-once-message-receive.md) | accepted | `receive` delivers each Message at most once, in bounded batches (v1) |
| [0006](./0006-platform-registry-is-authoritative.md) | accepted | one platform registry is the single source of platform facts |
| [0007](./0007-deterministic-launch-plan-and-print-contract.md) | accepted | the launch plan is fully computed before anything changes; `--print` shows it with no side effects |
| [0008](./0008-relay-process-model-and-live-launch.md) | accepted | the Relay is an internal node subcommand; a live launch owns exactly the one tmux session it creates |
| [0009](./0009-fault-injection-and-concurrency-hardening.md) | accepted | tests inject crashes and randomness through the Io interface; `clean` guarantees no silent data loss, not linearizability |
| [0010](./0010-launch-token-provenance-and-scoped-reap.md) | accepted | each launch stamps the Agent rows it creates with a token; after a failed launch's confirmed teardown, cleanup deletes only unused rows carrying that token |
| [0011](./0011-worktree-store-location.md) | accepted | a Crew launched inside a git worktree uses the worktree's own short-lived Store, never a redirect to the main workspace's Store |
| [0012](./0012-optional-local-ui-server.md) | accepted | optional `crew ui` Console: started by the Operator, foreground-only, reachable only from the local machine, built on existing Store reads and actions |
| [0013](./0013-console-redesign.md) | accepted | Console redesign: five separate views, one-click confirm (FR-U25), owned-session listing (FR-U35), CDN fonts (FR-U08); supersedes ADR-0012's presentation and confirmation specifics |
| [0014](./0014-worker-context-clear-signoff.md) | accepted | a Worker may clear its own context only after a Manager-sent Sign-off note confirms its Task has fully landed; no new Message kind |
| [0015](./0015-per-worker-task-worktrees.md) | accepted | opt-in per-Task Worker worktrees share the one State Store through a pointer file; the Inspector instead gets one persistent, reusable review worktree |
| [0016](./0016-structured-clear-safe-signoff-and-relay-reset.md) | accepted | the Sign-off is a structured `clear_safe` Message kind created by land/abandon (schema v6), and crew's Relay — not the Worker — delivers the context reset; amends ADR-0014's no-new-kind and no-registry-reset-command sentences |
| [0017](./0017-console-now-view-theme-and-agent-archive.md) | accepted | Console v2: a "Now" triage view (FR-U37), a light/dark theme toggle (FR-U38), and Operator Agent archive/restore over the Console (FR-U36, the same `crew leave`/`crew join --resume` operations the CLI already exposes — not permanent delete); extends ADR-0013 |

ADRs record choices that would be hard to reverse, and the reasoning behind them. Detailed
behavior belongs in the requirements and contract documents.
