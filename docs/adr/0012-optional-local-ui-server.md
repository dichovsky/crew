---
status: accepted
---

# Optional local UI server

## Context

crew's terminal workflow is the authoritative way to use it, but watching several Agents and
doing routine Operator work through separate terminal commands is tedious. A Console — a local
web page in the browser — can make that easier, without changing the one-shot command model from
ADR-0001 and without making a server a requirement for any existing feature. The design must
also preserve the State Store's rules about who may do what, the Relay's watch-without-consuming
model from ADR-0008, and crew's rule of only ever touching tmux sessions it created.

## Decision

**`crew ui` is an HTTP server the Operator starts explicitly, and it runs only in the
foreground.** It is reachable only from your own computer (it binds to `127.0.0.1`), picks a
random port by default, generates a fresh secret token on every start, and requires that token
on every request. Ctrl-C shuts it down. It is optional, no other crew feature ever needs it, and
it never runs as a background service. Its browser files are packed into crew at build time, so
the Console works without internet access.

**Updates are notifications, not a second copy of the state.** The server polls the State Store
using row ids that only ever increase, so it always knows where it left off, and tells the
browser something changed using server-sent events (SSE) — a standard way for a server to push
notifications to an open page. All reads and writes go through the existing Store domain
methods. Read paths use pending summaries, history, and Task reads; they never call `receive`
and never take Messages out of anyone's Inbox.

**The human is the plain, ordinary Agent `operator`.** The Operator is just a normal Agent row
whose platform column is `NULL`; there is no schema change and no privileged identity. The
Store's existing rules apply unchanged: the Operator may approve only a Task it is the reviewer
of, may send a Task back to the queue only if it created the Task or is its reviewer, and may
pick any reviewer when creating a Task.

**The Console offers only the approved Operator actions.** These are: send a Message, create a
Task, approve a Submission or send it back, launch a Team without attaching to it, stop a Team,
peek at a pane's text (with terminal control characters stripped out), and run `prune` or
`clean` behind a typed confirmation. Attaching to a launched Team stays terminal-only.

**`crew team stop <session>` acts only on sessions crew can prove it owns.** A pane-map file
written by crew must exist under `.crew/generated/<session>/`, and the random marker it recorded
at launch must match the marker stored on the live tmux session. A stale pane-map, or someone
else's session that happens to share the name, does not count as ownership. For a proven
session, the command kills it through the tmux adapter, archives the Agents the pane-map names,
and retires the pane-map.

**Machine output extends the existing contract of one JSON object per line (NDJSON).** Two new
`schema_version: 1` record types are added: `ui_started`, with `url`, `port`, and `workspace`;
and `stop_result`, with `session_name`, `killed`, and `agents_archived`. Failures reuse the
existing `ErrorCode` vocabulary.

**The Console shows Store facts together with their real limits.** History can have gaps after
`prune`; an Agent is described as "active", never "online", because crew cannot prove a process
is actually alive; and a Submission is not a completed Task until its reviewer approves it. The
Console also keeps working sensibly if its Workspace or database is deleted while it runs.

## Alternatives considered

**A terminal UI** would keep everything in the terminal, but its pane management and drawing
would compete with the Participant CLIs for the same screen, and it could not match the
browser's practical overview of many Agents at once.

**A separate npm package** would keep the Console out of the core CLI, but would create a second
thing to install and a second compatibility surface against the Store and command contracts.
Shipping the offline browser files inside crew keeps one versioned product boundary.

**Having the browser poll instead of using SSE** would make the server endpoints simpler, but
every open browser tab would then fire its own repeated state requests and only update on its
own polling schedule. One server-side poll over ever-increasing row ids, with SSE
notifications, puts the watching in one place and avoids duplicated work.

## Consequences

NFR-CON-02's "no daemon" constraint means crew must never require a background server — and it
does not: this Console is optional, started explicitly, runs in the foreground, and is reachable
only from the local machine. The one-shot CLI and every other crew feature keep working without
`crew ui`; while it runs, the server is visible to and controlled by the Operator and ends on
Ctrl-C.

The Console adds a local-only HTTP security boundary and one long-lived Store watcher, but it
gains no new authority over the Store and never consumes Inbox state. Session teardown stays
limited to what the crew-written pane-map proves, and attaching remains a deliberate action in
the terminal.
