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
| [0011](./0011-worktree-store-location.md) | accepted | a Crew launched inside a git worktree uses the worktree's own short-lived Store, never a redirect to the main workspace's Store; the per-Agent-worktrees goal it defers is promoted by ADR-0015 |
| [0012](./0012-optional-local-ui-server.md) | accepted | optional `crew ui` Console: started by the Operator, foreground-only, reachable only from the local machine, built on existing Store reads and actions; ADR-0013 supersedes its presentation and confirmation specifics, and ADR-0017 replaces its closed list of approved Operator actions with FR-U19's |
| [0013](./0013-console-redesign.md) | accepted | Console redesign: one view per concern (five at the time, six once ADR-0017 adds Now), one-click confirm (FR-U25), owned-session listing (FR-U35), CDN fonts (FR-U08); supersedes ADR-0012's presentation and confirmation specifics |
| [0014](./0014-worker-context-clear-signoff.md) | accepted | a Worker's context is safe to clear only after a Sign-off confirms its Task has fully landed, never right after a Submission; the Sign-off's mechanics are amended by ADR-0015 and ADR-0016 |
| [0015](./0015-per-worker-task-worktrees.md) | accepted | opt-in per-Task Worker worktrees share the one State Store through a pointer file; the Inspector instead gets one persistent, reusable review worktree |
| [0016](./0016-structured-clear-safe-signoff-and-relay-reset.md) | accepted | the Sign-off is a structured `clear_safe` Message kind created by land/abandon (schema v6, shipped); it further decides that crew's Relay — not the Worker — is what delivers the context reset, but the ADR defers that half to a follow-up and it is not built yet; amends ADR-0014's no-new-kind and no-registry-reset-command sentences |
| [0017](./0017-console-now-view-theme-and-agent-archive.md) | accepted | Console v2: a "Now" triage view (FR-U37), a light/dark theme toggle (FR-U38), and Operator Agent archive/restore over the Console (FR-U36, the same `crew leave`/`crew join --resume` operations the CLI already exposes — not permanent delete); extends ADR-0013 |
| [0018](./0018-worktree-teardown-policy.md) | accepted | `crew team stop` never removes a Worktree — a stopped session's tree can hold uncommitted Worker output, so removing it stays the Operator's own `git worktree remove` (FR-U27); no opt-in flag, no remove-if-clean heuristic; supersedes ADR-0015's aside that the whole-Crew worktree is "removed with the session" |
| [0019](./0019-fts5-search.md) | accepted | lexical FTS5 search over Message content and Task Event detail (group S, schema v8): external-content indexes kept in sync by triggers, `bm25()` ranking made into a total order and never fused across indexes, a crew-compiled query language rather than raw FTS5 pass-through, and no embeddings ever; **specified only — `crew search` is not implemented, and the implementation is a separate change** |

ADRs record choices that would be hard to reverse, and the reasoning behind them. Detailed
behavior belongs in the requirements and contract documents.
