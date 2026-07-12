# crew Decision Index

This index summarizes current decisions. Choices that would be hard to reverse are recorded
canonically in the [ADRs](../adr/README.md) (Architecture Decision Records); the requirements
and contract documents carry the detailed behavior.

Status: **accepted**, **provisional**, or **deferred**.

Decision ids use the `DEC-` prefix so they never collide with `FR-` requirement ids
(a `DEC-*` number and an `FR-*` number never correspond, even when the numbers happen to
match).

## Structural decisions

The hard-to-reverse structural choices are recorded as ADRs. See the
[ADR index](../adr/README.md) for the current set (ADR-0001…ADR-0015), their status, and
one-line summaries; the ADR bodies carry the reasoning and consequences. This index does not
restate them.

## Product and implementation decisions

### DEC-7 — Naming and distribution

The executable is `crew`, the Workspace directory `.crew/`, and the State Store
`.crew/state/crew.db`. The unscoped npm package name `crew` is taken, so the package
publishes under the maintainer's namespace as `@dichovsky/crew`
(`npm install -g @dichovsky/crew`; the installed command is still `crew`). Nothing has
been published yet. The remaining steps for the first publish are running the live
smoke test with real credentials, `npm publish --access public`, and tagging `v0.1.0`.
(`1.0.0` is reserved for a later stability milestone.)

### DEC-8 — Runtime and build

Use ESM TypeScript compiled to JavaScript, Node.js `>=24.15`, and stable TypeScript. The
installed executable never relies on Node's ability to run TypeScript directly. Runtime
dependencies are `commander` and `yaml`; `node:sqlite`, UUID generation, and
filesystem/process primitives come from Node itself.

Node 24.15 was chosen over the earlier 22.13 floor because of how Node rates its built-in
`node:sqlite` module: at 24.15 the module is a release candidate, while at 22.13 it was still
under active development. It is still not at Node's highest stability rating (stability 2),
so the package and migration tests remain load-bearing.

### DEC-9 — Command parsing and output

Use commander with thin command handlers behind `run(argv, io)`. An unknown command is a
usage error; the earlier convenience where an unknown first word was treated as joining an
Agent is removed, because typos were changing state. Human-readable and NDJSON output (one
JSON object per line) are equally supported. Exit codes 0/1/2 mean success, operational
failure, and usage/config failure respectively; future polling states will use codes of 10 or
higher.

### DEC-10 — Participant and backend support

v1 supports four Participant CLI targets (Claude Code, Codex CLI, Gemini CLI, Copilot CLI)
and two Model Backend recipes (Ollama, LM Studio). “All six first-class Agents” is rejected:
the two model servers cannot run crew commands themselves, so they are Setup Targets only.
The current paths and invocations are in [setup-integration.md](./setup-integration.md) and
must be verified by the release smoke test.

### DEC-11 — Roles and Teams

Manager, Worker, and Inspector are Role prompts shipped with the package; they grant no
privileges. Teams are strictly validated YAML roster templates, and expanding a Role into
several copies (replicas) always produces the same ids from the same input. Project Role and
Team files are tracked in version control; the packaged definitions remain the fallback and
the source for export.

### DEC-12 — Launcher scope

Manual display can show a roster that mixes different Participant CLIs. The automatic v1
launch runs one Participant CLI for every pane and works only on Unix with tmux, with
optional isolation of the whole launched Crew in one git worktree (a separate working copy of
the repository sharing the same history). Repo config selects a registry id, never an
executable or shell arguments. Launching mixed Participant CLIs and per-Agent worktrees are
deferred.

### DEC-13 — Setup safety

Running setup with no target only detects what is installed — it writes nothing. Explicit
participant setup writes exactly one generated file carrying a crew marker; a file that was
edited or lacks the marker is replaced only with force plus a backup. Backend setup checks
the environment and prints recipes, but never silently edits model configuration. Flags that
broadly bypass a Participant CLI's permission prompts are never enabled.

### DEC-14 — Testing

Use Vitest against the Program and Store interfaces, a real SQLite database, spawned tests
that force several processes to compete at once, a Launcher adapter that records every
process call instead of running it, real tmux with a fake Participant, live Participant smoke
tests at release time only, and installation from the packed tarball. Proving every state
transition edge and the concurrency behavior matters more than raw line coverage.

## Superseded design statements

These appeared in the original package and must not return:

| Superseded statement | Replacement |
|---|---|
| “No long-lived process anywhere” while promising automatic wake-up | no required daemon; optional tmux Relay (ADR-0001) |
| watcher runs `receive` in each pane | one Relay uses content-free pending summary and fixed nudges |
| ignore all of `.crew/` | ignore only `.crew/state/` and `.crew/generated/` |
| unknown command means `join` | unknown command = `USAGE` |
| worker marks Task completed before review | worker submits; reviewer completes |
| three tables only | Agents, Messages, Tasks, immutable Task Events |
| SELECT then UPDATE receive is “lost-message-free” | one bounded UPDATE/RETURNING, at-most-once crash window |
| Codex skills live in `.codex/skills` | current locations are `.agents/skills` |
| Codex local providers may use Chat Completions | current supported wire is Responses |
| `init` refreshes global setup files | init is Workspace-only by default; setup is explicit |
| `crew` is available as an unscoped npm name | publishes as scoped `@dichovsky/crew`; `crew` unavailable |
| binary exit 0/1 and reserve 2 | 0/1/2 = success/operational/usage; polling >=10 |

## Provisional release decisions

These do not block core implementation; they block publication. The authoritative
list, with the evidence that closes each gate, is the canonical
[release-gate table](./product-spec.md#release-gates) — npm name ownership, the Participant
CLI matrix (including the Copilot scoped shell-rule syntax confirmed against the installed
version), Model Backend recipes, Relay proof, SQLite stress, and security review.

## Console decisions

The hard-to-reverse choices for the optional `crew ui` Console live in ADRs:
[ADR-0012](../adr/0012-optional-local-ui-server.md) (a foreground server, reachable only from
your own computer, requiring a token on every request, and working only through the Store's
domain reads and actions) and [ADR-0013](../adr/0013-console-redesign.md) (the five-view
redesign: the one-click destructive confirmation that re-scoped FR-U25, the owned-session
listing FR-U35, and the CDN-font re-scope of FR-U08). Two honesty features were lost in the
redesign: the visible note about gaps in Message history (since restored) and the browser
create-Task form (still open as deferred work).

## Worker context-clear decisions

A Worker's long-lived context is only safe to clear once its work has fully landed:
[ADR-0014](../adr/0014-worker-context-clear-signoff.md) allows clearing only after a Sign-off
sent once the Review approved the work and any merge or worktree cleanup finished — never
right after Submission, because a Requeue can still send the Task back for rework.
[ADR-0016](../adr/0016-structured-clear-safe-signoff-and-relay-reset.md) amends the
mechanics: the Sign-off is now the structured `clear_safe` Message kind (schema v6),
minted only by `task land`/`task abandon`, and the context reset is delivered by
crew's Relay typing the engine's reset command into the pane — no supported engine lets the
model inside the session reset itself (the Relay-delivery half lands in a follow-up change).

## Deferred product decisions

Claim/acknowledge Messages, session displacement, memory/brief, approvals, Task dependencies,
launching mixed Participant CLIs, and per-Agent worktrees remain candidates. See requirements
FR-X*.
