---
status: accepted
---

# Launch-token provenance and the scoped teardown reap

The live launch (ADR-0008) deliberately left joined Agent rows in the Store when it failed
and was torn down. The reason: each pane runs its own `crew join` between the first pasted
command and any later failure, and a snapshot of the Store proves only "this row exists" — not
"this launch created it". A second launch running at the same time (or someone joining by hand)
could create the same new id in a shared workspace, and a naive cleanup would then delete a row
crew did not create. Any cleanup was therefore deferred until rows carried real provenance —
proof of where they came from. This ADR records that provenance mechanism and the narrowly
scoped cleanup ("reap"). Building it together with the concurrency hardening (ADR-0009), rather
than deferring it further, was a deliberate product decision: the hardening work that owns the
concurrency test fixtures should also own the schema migration those fixtures must survive.

**Each launch stamps the rows it creates with its own token.** The live launch generates a
token of at least 128 random bits using `node:crypto` — never the seedable random stream used
for contention jitter, which tests can control — and puts it into every participant pane's
environment as `CREW_LAUNCH_TOKEN`, passed to tmux as `tmux -e KEY=VALUE` (a single argument in
the argument array, with `shell:false` so no shell ever interprets it; the Relay window gets no
token because it never joins). Each pane's `crew join` reads the variable and writes it into the
new Agent's nullable `launch_token` column — but **only when creating a brand-new row**, never
on resume, conflict, or update. A malformed value is silently ignored (the variable is crew's
own plumbing, not something users set). Delivering the token through the environment rather
than as a CLI argument means it never appears in the pane process's argument list — it shows up
only in tmux's own arguments during session setup. The token also grants no power by itself:
the only thing that reads it, the scoped reap, already needs write access to the same local
Store the token is saved in. Repository config cannot inject it either (`env` is a
`FORBIDDEN_KEY`).

**The reap deletes only rows that match the token and were never used — and only after
teardown is confirmed.** The launcher runs the reap only once `kill-session` has *succeeded*.
If teardown failed, the panes' participant processes may still be running, and deleting their
rows would break them with `AGENT_INACTIVE` on their next command — strictly worse than leaving
the rows alone — so the reap is skipped. After a confirmed teardown, the launcher opens the
Store and **deletes** every active row whose `launch_token` matches this launch AND that left
no trace of use: no Task references it (as creator, assignee, reviewer, or lease owner), no
Task Event names it, and it sent and received no Messages. Deleting (rather than archiving) is
deliberate and safe: an unused row has no history to preserve and nothing in the database
points at it, so it disappears cleanly. More importantly, the launch preflight treats
*archived* ids as taken too (`preexistingAgentIds` counts them) — so archiving a reaped row
would block relaunching the same team. Only deletion frees the id and lets the failed launch
be retried immediately, which is the whole point of the reap. Rows that were used, rows carrying
a different launch's token, and rows with no token (they existed before the launch) are all
left alone for `doctor` or a retry. The reap runs in one `BEGIN IMMEDIATE` transaction and is
strictly best-effort: any failure is swallowed and the outcome falls back to the old baseline —
every joined row stays active. It never replaces or hides the original launch error, and it can
never leave a half-deleted state. Because it removes only pristine rows it created itself, no
archive-reason marker or dedicated `doctor` finding is needed: a successful reap leaves nothing
behind, and a skipped or failed reap leaves the rows **active**, where `crew agents` lists them
for the operator to `crew leave` or `crew clean`.

**The column ships as schema version 2 — the first real migration.** `launch_token` is added by
an ordered `1 -> 2` migration step that first verifies the live version-1 `agents` table has
the expected shape (`PRAGMA table_info`), then runs `ALTER TABLE ADD COLUMN` and creates a
partial index, all inside the existing exclusive migration transaction. SQLite appends a new
column after the last existing column (and before the table-level CHECK constraints), so once
both schemas are reduced to the same standard form for comparison, the migrated database is
byte-identical to a freshly created version-2 database — `assertCurrentSchema` passes on both.
If the process crashes before the migration commits, the whole step rolls back, leaving the
database at version 1 with no half-created objects (proven through the real `run()` path using
the Io fault hooks from ADR-0009).

**The token is never displayed.** `launch_token` is not a field on the public `AgentRecord`, so
no human-readable table and no JSON record can ever contain it; the central output redactor is
a second line of defence, not the primary control. The consequence: a failed launch
no longer leaves unused ghost registrations behind, while any row that did real work — exactly
the rows an operator needs to see — still shows up for diagnosis and retry.
