---
status: accepted
---

# Structured clear_safe Sign-off and relay-delivered context reset

## Context

ADR-0014 decided *when* a Worker's conversation context is safe to clear — only once a Task it
worked on has fully landed (or been abandoned, which is final) — and left the *how* to the
Worker itself: a free-text Sign-off `note` from the Manager gave the Worker permission to run
its own CLI's clear or compact command. Two assumptions behind that ADR have since turned out
to be wrong:

1. **A Worker cannot clear its own context.** Research across all five supported engines
   (Claude Code, Codex CLI, Gemini CLI, Copilot CLI, Antigravity CLI, verified mid-2026) found
   that every one exposes its reset only as a slash command the human user types (`/clear`),
   and none lets the model inside the session trigger it — not as a tool, not as a command the
   model can emit. ADR-0014's instruction "use your own CLI's clear/compact mechanism" does
   nothing on every engine crew supports.
2. **A free-text convention gives tooling nothing to act on.** If crew itself must deliver the
   reset (see below), it needs a signal a machine can recognize, not wording an LLM recognizes.
   ADR-0014 explicitly deferred a structured Message kind.

A launched crew already has exactly one actor that can type into a Worker's pane:
the Relay (ADR-0008), which pastes fixed wake-up lines that carry no Message content
(FR-H15–H19).

## Decision

**The Sign-off becomes a structured `clear_safe` Message kind (schema v6), created only by Task
transitions.** The `messages.kind` column gains `clear_safe` in its CHECK constraint — the
database rule that lists the allowed kinds. Changing a CHECK on a STRICT table means the
`messages` table is rebuilt in the v5 → v6 migration. `task land` sends its existing Sign-off
text (`Task <id>: landed, safe to clear your context.`) with `kind: 'clear_safe'`, and
`task abandon`'s notification to the ASSIGNEE does the same (ADR-0014's abandon exception, now
built into the data); abandon's copies to the creator and reviewer stay plain `note`s. Unlike
every courtesy notification, the assignee's Sign-off is delivered even when the assignee IS the
Agent performing the action (one Agent can be creator, assignee, and reviewer at once): the
Sign-off is the durable unread signal the Relay's reset watches for, so suppressing it for the
acting Agent would leave a Worker that lands or abandons its own Task permanently without a
reset. A freeform `crew send` still cannot fake any notification kind (FR-D22), so a
`clear_safe` Message always reflects a real land or abandon. This supersedes ADR-0014's "the
Sign-off rides the existing `note` kind; it does not add a new one". ADR-0014's expected
sequencing (a structured kind only after a worktree-teardown policy) is bypassed deliberately:
the signal is tied to the `task land` transition, not to any worktree-teardown policy.

**crew's Relay delivers the reset, not the Worker.** Since no engine lets its own model trigger
a reset, the Relay's ability to type into a pane is the only channel that can do it. In a
launched session, when a Worker has an unread `clear_safe` Message and no Task in progress, the
Relay types the engine's reset command into the pane, followed by a fixed re-introduction
(`You are crew agent <actual-id> (role <role>) in this workspace. Run: crew receive
<actual-id>`) — both fixed templates whose only variable parts are ids, added to the FR-H15/H17
list of allowed pane injections. The platform registry gains a per-engine reset command that
may be null (for all five current engines it is `/clear`), superseding ADR-0014's "the registry
tracks no per-CLI context-clear/compact command"; when it is null, the Relay types nothing and
the Worker simply continues with its full history. The Relay delivery, the registry field, and
their requirements land in a follow-up change to this one; the schema signal ships first so a
real crew can verify it.

**ADR-0014's *when* stands unchanged.** The Sign-off comes only after landing, never right
after a Submission; abandoning is the immediate exception; and crew still cannot observe
"merged", so the Manager (through `crew task land`) remains the authority on whether a Task has
landed.

**Crews joined manually keep the documentation-only convention.** Without `--launch` there is
no Relay; the `clear_safe` Message still arrives as a readable note, and a watching human types
the reset.

## Consequences

- Schema v6 rebuilds the `messages` table; older databases migrate forward the first time they
  are opened, and — as with every earlier version bump — there is no way back to the older
  schema.
- A Sign-off a Manager types by hand with `crew send` (the no-worktree case) is advisory only:
  it is a `note`, and crew will never act on it. Only `task land` and `task abandon` create the
  structured signal.
- The Worker Role no longer tells Workers to clear their own context (proven impossible); it
  now says that crew performs the reset in launched crews, and the Worker just runs
  `crew receive` when nudged.
- Until the follow-up Relay change lands, a `clear_safe` Message behaves exactly like the old
  Sign-off note (a readable Inbox entry that also triggers the ordinary Relay nudge); nothing
  gets worse in the window between the two changes.
- Each engine's reset facts (commands, aliases, caveats) will be recorded in the platform
  registry and `docs/design/setup-integration.md` in the follow-up change; Antigravity releases
  weekly, so its `/clear` must be re-verified then.

## Update 2026-07-14 — reset facts for the `pi-cli` and `opencode-cli` engines

The `pi-cli` and `opencode-cli` engines were added (registry revision 4). Their reset
commands are **not** uniformly `/clear`, so the follow-up per-engine reset field must not
assume it: **opencode** resets with `/new` (documented alias `/clear`), but **pi** has
**no `/clear` and no `/reset`** — its only context reset is `/new`. Record `/new` for both
when the Relay-delivered reset lands.
