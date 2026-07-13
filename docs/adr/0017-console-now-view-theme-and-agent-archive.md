---
status: accepted
---

# Console v2: Now view, light/dark theme, and Operator Agent archive/restore

## Context

[ADR-0013](./0013-console-redesign.md) reorganized the Console into the five-view IA
(Overview, Agents, Tasks, Messages, Operations) built from the first Crew Console design
handoff. A second handoff (`Crew Console.dc.html`, superseding an intermediate `Crew Console
v1.dc.html` that matches what ADR-0013 shipped) layers three further changes onto that same
implementation: a triage-first "Now" view, a light/dark presentation toggle, and Agent
archive/restore actions on the Agents view. This ADR records the decisions made while
implementing that second handoff; it extends ADR-0013 rather than superseding it — the
five-view IA, one-click confirm, and owned-session listing it established are all unchanged.

## Decision

**"Now" becomes the first view, aggregating existing signals only (adds FR-U37).** The Console
gains a sixth view — Now — presenting a single prioritized worklist: stale-Lease Tasks, the
Operator's review queue, idle Agents, and unread Operator Messages, in that order. Every item
routes to an action the Console already offers elsewhere (select the Task, message the Agent,
open Messages); Now introduces no new data source and no new authority, it is purely a
higher-priority front door onto what Overview's "needs attention" list and the Messages inbox
already surface separately. An empty worklist renders an explicit "All clear" state rather than
a blank pane, matching the honest-presentation principle ADR-0012/ADR-0013 already established
for Agent activity and Task status.

**Light/dark theming is a pure CSS custom-property system, toggled locally (adds FR-U38).** A
header control flips a `data-theme` attribute on the document root; `web/styles.css` gains a
`html[data-theme='dark']` block re-pointing the existing structural custom properties (surface,
border, text, and three new tokens — `--subtle`, `--chip`, `--input-border`, `--strong` — needed
to fully cover the design's light-mode literals) at the design's dark palette. Semantic tints
(accent, status, role, engine, and danger colours) are deliberately left unchanged between
themes, matching the design; only pill *backgrounds* re-tint in dark mode, via a
`color-mix(in srgb, fg 20%, transparent)` formula applied at the point of use
(`web/view-model.ts`'s `pillBg`/`rolePillBg` helpers) rather than as a second hard-coded palette.
The preference is stored in the browser only (`localStorage`) and never reaches the server: the
Console's wire protocol, authority model, and Store are completely unaffected. Default is light.

**Operator archive/restore is a deliberate, narrow widening of the Console's action surface
(amends FR-U19, adds FR-U36).** The design's Agents view offers Archive/Restore per Agent card.
crew already has both operations — `crew leave <id>` (archive) and `crew join <id> --resume`
(restore) — so the Console routes (`POST /api/agents/:id/archive`, `POST /api/agents/:id/restore`)
call the exact same Store domain methods (`leaveAgent`, and a restore-only `joinAgent` typed to
accept nothing but `{ id, resume: true }`) with the exact same authority and invariants (FR-U18):
no new Store capability, no schema change. Archive is gated by the same FR-U25 one-click
confirmation as `team stop`/`prune`/`clean`; restore is not, since it is the reversible corrective
action. The Console's own `operator` Agent row is explicitly excluded from archive: it is
re-established only at `crew ui` startup or FR-U32 Store reopen, not per request, so an
Operator-archived operator row would silently break every later Console action for the rest of
that running session.

**Permanent Agent delete was considered and explicitly dropped.** The design mockup also
includes a red "Delete agent" button whose confirmation copy claims it "removes it from the
roster and its lease/messages. This cannot be undone." crew has no Store operation that
irreversibly deletes a single Agent row plus its Message and Task-Event history — only `leaveAgent`
(archive, reversible) and the whole-Workspace `clean` exist. Building real permanent delete would
mean a new cascading Store mutation, schema/trigger changes, a CLI-contract and SRS FR of its
own, and materially higher data-loss risk than the rest of this change — that was judged
out of scope here. The button is omitted from the Console entirely rather than wired to archive
under a misleading "Delete" label; a future ADR can pick this up as its own decision if the need
is confirmed.

**The quick-message modal replaces the previous "jump to Messages tab" flow.** Clicking an Agent
(from the Overview roster, an Agents card, or a Now worklist item) now opens an inline compose
modal pre-addressed to that Agent, matching `web/components/confirm-dialog.tsx`'s accessibility
pattern (focus trap, Escape, backdrop click, focus restore) rather than navigating away. The
Messages view's own compose form is unchanged and still reachable directly from the nav rail.
This is a presentation-only change — `POST /api/messages` and its FR-U14 authority are unaffected.

## Consequences

- ADR-0013's five-view IA, one-click confirm mechanism, and owned-session listing are unchanged;
  Now is additive as the new first view (six views total, FR-U34 updated accordingly).
- The Console's action surface is no longer limited to Message/Task/Team/maintenance operations
  (FR-U19 amended); reviewers of future Console changes should treat FR-U19's enumeration, not
  "whatever's already wired," as the actual boundary — anything beyond it needs its own FR.
- Permanent single-Agent delete remains unbuilt. If field usage shows Operators actually need it
  (not just archive/restore), it should land as its own ADR with a proper cascading-delete design,
  not be backed into this change's archive route.
- Dark-mode coverage follows the design's own scope: it re-themes the Console chrome and cards,
  but a few pre-existing, design-independent surfaces (the pane-peek terminal panel, which is
  intentionally always-dark to read as a terminal; the FR-U32 recovery banner and boot/error
  states, which have no design reference) were adapted by inspection using the same
  `color-mix` idiom rather than to an exact design-specified value.
