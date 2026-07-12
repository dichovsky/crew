---
status: accepted
---

# Console redesign: five-view IA, one-click confirm, owned-session listing

## Context

[ADR-0012](./0012-optional-local-ui-server.md) established the optional local Console: a web
server that runs in the foreground, is reachable only from your own computer, requires a secret
token on every request, and ships its browser files inside crew. Its first dashboard was one
long scrolling page of panels, each showing state next to its actions. As the number of actions
grew (send, approve, requeue, launch, stop, peek, prune, clean) that single page became crowded,
and the operations side of the story — above all, which crew-owned tmux sessions are currently
live — had no place to live. A redesign reorganized the Console into separate views, one
per concern ("IA" in the title is short for information architecture — how the app's screens are
organized). This ADR records the decisions that reorganization made; it supersedes ADR-0012's
presentation and confirmation specifics while leaving its server, authority, and ownership model
intact.

## Decision

**The Console is a five-view app, not a single page.** A navigation rail fixed to the left side
switches between **Overview**, **Agents**, **Tasks**, **Messages**, and **Operations** (SRS
FR-U34). Each view covers one concern; stored content is still rendered only through the
framework's default text escaping, so nothing an Agent wrote can act as markup. The Tasks board
keeps a real, selectable **Abandoned** column instead of hiding abandoned Tasks, and a
submitted Task appears in its own "In review" column — never in the completed one (FR-U31).

**Confirming a destructive action takes one click, not a typed phrase (re-scopes FR-U25).**
`team stop`, `prune`, and `clean` require an explicit `{ confirm: true }` flag, set by a dialog
that spells out the irreversible effect. This replaces the earlier requirement to type an exact
phrase from the CLI contract. The reasoning: that phrase was a **publicly documented constant**,
not a secret — typing it never proved the request came from the Operator's browser rather than
a forger. The real authorization boundary is unchanged: the secret token issued for this run
plus the fact that the server only accepts connections from the local machine. The flag still
prevents a stray, empty POST request from triggering an irreversible action.

**The owned-session list reuses the same ownership proof as stop (adds FR-U35).** A new
read-only route, `GET /api/sessions` (`src/launcher/sessions.ts` `listOwnedSessions`), goes
through the pane-map files under `.crew/generated/<session>/` and reports only sessions that
are actually running AND whose recorded ownership token matches the live tmux session — exactly
the proof `team stop` and pane peek already rely on. It invents nothing: a row appears only for
a session the Console could genuinely stop; stale, foreign, or malformed pane-maps are left
out. The list is built from tmux plus the pane-map, never from the State Store, so it stays
outside the boundary that guarantees Store reads never consume anything.

**Pane peek moves into Operations.** Peek is about sessions and panes, so it belongs next to
Team launch/stop and the session list rather than in a panel of its own. Its FR-U24 stripping
of terminal control characters is unchanged.

**Two decorative web fonts load from a CDN (re-scopes FR-U08).** The page asks a public font
service for Space Grotesk and IBM Plex Mono purely to look better when a network is available;
the stylesheet declares a fallback to the fonts already on your system. The Console stays fully
usable offline — only the typefaces fall back to the platform defaults — and nothing the
Console needs to function (the dashboard code, the JSON/SSE endpoints) is ever fetched from the
network.

## Consequences

- ADR-0012's "single read-then-act page" and "typed confirmation" specifics are superseded; its
  server lifecycle, token and local-only-access model, Store-domain boundary, never-consuming
  reads, and tmux ownership rules are unchanged.
- The offline guarantee is now "fully usable offline," no longer "makes no network request
  ever"; the font download is the only external request and the Console works without it. A
  follow-up may bundle the fonts into crew to close even that.
- Two features that kept the Console honest slipped during the redesign and were tracked rather
  than lost: the visible notice that history may have gaps (FR-U23 — since restored in
  the Messages view) and — missing even before the redesign — a create-Task form in the browser
  (FR-U15, still open).
