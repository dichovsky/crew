# crew Product Specification

> Part of the crew [documentation package](../README.md). This document defines who crew is
> for, what v1 promises, what is out of scope, and — in [Release gates](#release-gates) — the
> canonical list of what blocks publication.

## Product promise

crew lets several terminal coding agents that are already running coordinate their work in one
local Workspace — the project directory that contains a `.crew/` folder. There is no hosted
service behind it, and crew never talks to a model provider. What it provides: a named
identity for each agent that survives restarts, an Inbox of notes for each agent, Tasks whose
completion always passes through a review, a shared view of who is doing what, reusable Role
prompts, and optional help with starting agents inside tmux and waking them when new work
arrives. (tmux is a terminal tool that runs several shell panes inside one session.)

The promise is **coordination**, not autonomous model hosting. Each Participant CLI — a
shell-capable AI application, such as Claude Code, that takes part by running crew commands —
keeps its own model, authentication, permissions, context, and tool execution.

## Users

- A developer coordinating two or more coding-agent terminals by hand.
- A lead agent acting in the Manager Role (handing out Tasks) while Workers implement them and
  an Inspector reviews the results.
- A team that wants Role and Team definitions they can commit to version control, without
  committing runtime state.
- A local-model user who points a supported Participant CLI at Ollama or LM Studio.

## Primary jobs

1. Start or display a Crew from a Team definition that lives in version control.
2. Assign a durable Task and know whether it is queued, in progress, submitted, or accepted.
3. Exchange direct notes between agents without wiring the Participant CLIs to one another.
4. Recover from an idle or crashed Worker without guessing from chat history.
5. Inspect the roster, the Inbox backlog, Task history, and integration health.
6. Tear down or prune local state without losing anything by accident.

## v1 modes

### Manual mode

You start each Participant CLI yourself, invoke the installed crew skill or command, and
prompt an Agent to check its Inbox when needed. This mode needs no tmux and no long-lived
crew-owned process — nothing keeps running in the background.

### Launched mode

`crew team <name> --launch` creates a tmux session for the whole Team. An optional Relay — a
small helper tied to that tmux session — may run in a dedicated tmux window; when an Agent's
Inbox changes, it types a fixed wake-up line into that Agent's pane. The nudge carries no
Message content. The woken Agent then runs `crew receive` itself; the Relay never consumes
Messages. `--no-relay` keeps launched mode fully manual.

This split is deliberate: the core needs no background process at all, while hands-off wake-up
requires one process that stays alive for as long as the tmux session does.

## v1 capability scope

- Workspace initialization: config files you can commit, state files that stay ignored.
- Agent join, explicit resume, leave, listing, and last-activity timestamps.
- Direct Messages, broadcast, a bounded receive that runs once and exits, a pending count, and
  history.
- A reviewed Task lifecycle: Leases (claims that expire on their own, so a crashed agent
  cannot hold a Task forever), transitions that apply only if the Task is still in the
  expected state, recorded reasons, and an immutable Task Event log.
- Built-in Manager, Worker, and Inspector Roles, plus per-project overrides.
- Team definitions and manual command rendering.
- An optional tmux launch (all panes running the same Participant CLI) and a session Relay.
- Explicit setup generators for Claude Code, Codex CLI, Gemini CLI, and Copilot CLI.
- Checked setup recipes for Ollama and LM Studio as Model Backends (inference servers that a
  Participant CLI may use; crew itself never contacts them).
- Human-readable output and JSON output where each line is one complete JSON object, stable
  error codes, `doctor`, prune, and a guarded clean.

## Non-goals

- Calling an LLM API, choosing models, metering tokens, or owning agent context.
- Any required or background daemon (a process that keeps running on its own), cloud accounts
  or services, remote databases, or remotely hosted dashboards. The optional `crew ui`
  Console — started explicitly by the Operator, kept in the foreground, and reachable only
  from your own computer — is in scope as an additive, optional surface; no other crew feature
  ever requires it.
- Authentication or authorization between agents that do not trust each other.
- Exactly-once Message delivery (a guarantee that every Message arrives exactly one time).
- Windows tmux launch/Relay support in v1.
- Per-Agent worktrees, or mixing different Participant CLIs in one automatic launch.
- Automatic lease reassignment without an explicit Task transition.

## Success criteria

- A new user can initialize, join two Agents, send and receive a Message, and complete a
  reviewed Task in under ten minutes, working only from the README.
- When several processes are forced to compete for the database, no committed Message or Task
  transition is dropped without a trace; contention failures are explicit and
  machine-readable.
- Two receivers running at the same time never return the same Message.
- A Worker's Submission can never be reported as accepted before a Review transition.
- The Relay can nudge an idle launched pane without consuming Messages and without typing any
  Message content into the pane.
- Package contents, templates, the shebang line, and the required Node version are verified
  from the output of `npm pack`.

## Release gates

This is the **canonical release-gate list**. Other documents reference it and must not keep a
separate copy. The first publish (`0.1.0`) has shipped to npm. Because npm's OIDC Trusted Publishing
can only attach to a package that already exists, `0.1.0` was published once by hand;
from `0.1.1` on, a published GitHub Release runs `.github/workflows/publish.yml`, which
publishes via OIDC with provenance and no stored npm secret (see
[publishing.md](../release/publishing.md)). The
SQLite-stress and Security-review gates are closed, and the Relay-proof gate's full
end-to-end test — a launch against real tmux with a fake Participant standing in for a real
CLI — is in place. Every part of the remaining gates that a machine
can run has landed: a green `npm publish --dry-run` (the rehearsal half of the npm-name gate), plus the
recorder and guided checklist for the maintainer-run live smoke test and the `doctor` version
floor (for the Participant-CLI-matrix and Model-Backend gates). Each release re-runs the
credentialed live smoke and commits `docs/release/artifacts-<date>.json`; no long-lived
npm token ever enters CI.
`1.0.0` is reserved for a later milestone, once the CLI and store contracts are declared
stable.

| Gate | Why it blocks release | Evidence required |
|---|---|---|
| npm name ownership | `crew` is not available as an unscoped package name on npm, so the package publishes as scoped `@dichovsky/crew` | a successful `npm publish --dry-run` (the first real publish uses `npm publish --access public`) |
| Participant CLI matrix | the CLIs' install paths and permission models change quickly | a live smoke test in a clean home directory for each of the seven Participant CLIs at their pinned minimum versions, including the Copilot scoped shell-rule syntax (`--allow-tool='shell(crew:*)'`) confirmed against the installed version |
| Model Backend recipes | the Ollama and LM Studio integration paths change independently and are unverified until actually run | an Ollama and an LM Studio tool-call smoke test through a supported Participant CLI |
| Relay proof | launched autonomy depends on wake-up actually working | a tmux end-to-end test with an idle pane, a nudge, a receive, and proof that no Message is consumed twice |
| SQLite stress | the product depends on staying correct when several processes write at once | a repeatable forced-contention suite on Linux and macOS proving the documented contention and delivery behavior |
| Security review | repo config and text from other agents are untrusted inputs | all controls in [security.md](./security.md) covered by tests |

## Post-v1 direction

The optional local `crew ui` Console and the ability to stop an owned Team already ship in the
codebase as an additive slice — nothing else depends on them — and are included from the first
release. The Console is an interactive five-view browser app (Overview, Agents, Tasks,
Messages, Operations) that both observes crew state and drives it, acting under the same
ordinary Store authority as any other caller — send a Message, approve or requeue a Task,
launch or stop a Team, list the live sessions it owns, peek at a pane, and run maintenance
behind an explicit confirmation. Later candidates include durable briefing (Agent memory plus
`crew brief`) and Task dependencies. Message receive today is at-most-once: a Message is
delivered once, or — if the process crashes at exactly the wrong moment — not at all, never
twice. A claim/acknowledge Message protocol should be added only if real use shows that this
documented crash-loss window is unacceptable.
