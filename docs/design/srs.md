# crew Software Requirements Specification (SRS)

> **Standard handling.** This SRS is organized and reviewed using **ISO/IEC/IEEE 29148:2011**
> as *guidance only*. A newer edition has since replaced the 2011 edition, and this document
> makes **no formal claim of conformance** to any edition. No rule attributed to the 2018
> edition (or any other edition) is used here. Clause citations below (for example "§9.5.9",
> "§5.2.5") point into the 2011 guidance text.

> **Authority.** This SRS sits at level 2 in the crew [documentation map](../README.md): when
> documents disagree, accepted [ADRs](../adr/README.md) win over this SRS, and this SRS wins
> over the [CLI contract](./cli-contract.md) and [data model](./data-model.md).
> Release status is deliberately **not** repeated in this document; see the product-spec
> [release-gate table](./product-spec.md#release-gates).

## Table of contents

- [1 Introduction](#1-introduction)
- [2 References](#2-references)
- [3 Specific requirements](#3-specific-requirements)
  - [3.1 External interfaces](#31-external-interfaces)
  - [3.2 Functions](#32-functions)
  - [3.3 Usability requirements](#33-usability-requirements)
  - [3.4 Performance requirements](#34-performance-requirements)
  - [3.5 Logical database requirements](#35-logical-database-requirements)
  - [3.6 Design constraints](#36-design-constraints)
  - [3.7 System attributes](#37-system-attributes)
  - [3.8 Supporting information](#38-supporting-information)
- [4 Verification](#4-verification)
- [5 Appendices](#5-appendices)
  - [Appendix A — Assumptions, dependencies, and TBD items](#appendix-a--assumptions-dependencies-and-tbd-items)
  - [Appendix B — Acronyms and abbreviations](#appendix-b--acronyms-and-abbreviations)
  - [Appendix C — Old→new requirement crosswalk](#appendix-c--oldnew-requirement-crosswalk)
  - [Appendix D — Future / out-of-scope requirements](#appendix-d--future--out-of-scope-requirements)
  - [Appendix E — Quality-grading matrix](#appendix-e--quality-grading-matrix)

Each requirement carries a **Verify:** line naming how it is checked — by an *automated test*,
by *inspection* (reading the named document or source file), by *analysis* (a reasoned
argument), or by *demonstration* (running the product by hand) — plus a link to the proof
(usually a test file). Every requirement uses **shall** as
the single word that marks a mandatory rule (§5.2.4). Each requirement states exactly one rule
(§5.2.5 *Singular*): where the former specification packed several rules into one id, that id
is expanded here into consecutive ids, tracked in
[Appendix C](#appendix-c--oldnew-requirement-crosswalk).

---

## 1 Introduction

### 1.1 Purpose (§9.5.1)

crew is a command-line tool that runs on your own machine and coordinates terminal coding
agents (Claude Code, Codex CLI, Gemini CLI, Copilot CLI). This SRS specifies **all v1 software
requirements**, plus the post-v1 additions for the Console and for stopping a Team —
functional and non-functional — in enough detail to design and test against. crew coordinates
Participant CLIs (the AI command-line apps that act as Agents) that are already running; they
share one State Store, an SQLite database file inside the project's Workspace. crew **never
calls a model provider** and runs no AI model itself.

### 1.2 Scope (§9.5.2)

- **Product name:** `crew` (npm package name `@dichovsky/crew`, published; installed executable `crew`).
- **What it does:** Agent identities that survive restarts; a shared Inbox of Messages; a
  Task workflow in which every result is reviewed, protected by Leases (claims that expire on
  their own after a set time, so a crashed agent cannot hold a Task forever) and recorded as
  Task Events that are never edited afterwards; reusable Role and Team configuration; explicit
  setup for Participant CLIs and Model Backends; an optional tmux Launcher and session Relay;
  and safe maintenance commands (`doctor`, `prune`, `clean`). The post-v1 additions include an
  optional local Console that runs in the foreground, stopping a Team that crew itself
  launched, a `task abandon` verb that retires a Task that will never complete, and a
  stale-Lease change signal that alerts a Task's creator and the Console alike instead of
  relying on a human to keep running `doctor`.
- **What it does not do:** call an AI model, check identity or permissions between Agents, run
  a daemon (a background process that keeps running on its own) or any required or background
  server, run a hosted service, guarantee that a Message is delivered exactly once, or launch
  under Windows tmux (see [product-spec Non-goals](./product-spec.md#non-goals)).
- These statements are consistent with the higher-level [product specification](./product-spec.md).

### 1.3 Product overview

#### 1.3.1 Product perspective (§9.5.3)

crew is a standalone command-line program that other software (Participant CLIs) and a human
operator invoke. Its boundaries with the outside world:

- **System interface** — Participant CLIs (Claude Code, Codex CLI, Gemini CLI, Copilot CLI)
  invoke `crew` subcommands; crew never invokes a model provider.
- **User interface** — a text CLI with two equally supported output formats (a human
  table/line format, and `--json` output where each line is one complete JSON object —
  NDJSON), plus an optional local browser Console that runs in the foreground.
- **Hardware/OS interface** — Node.js `>=24.15` on macOS or Linux; local filesystem only.
- **Software interface** — the built-in `node:sqlite` module is the only storage engine; the
  optional Launcher and Relay run `tmux` and `git` as child processes, always passing
  arguments as an array with `shell:false` so no shell ever interprets the values.
- **Memory / operations / site adaptation** — one local SQLite State Store per Workspace at
  `.crew/state/crew.db`; every command runs, does its job, and exits — nothing stays running —
  except the optional Console, which the Operator starts explicitly and which stays in the
  foreground; configuration lives per project under `.crew/`.

#### 1.3.2 Product functions (§9.5.4)

In summary, crew performs: Workspace initialization (§B); the Agent lifecycle (§C); Messaging
(§D); reviewed Tasks (§E); Role/Team configuration (§F); Setup Target generation (§G);
optional tmux launch and Relay (§H); storage and safe concurrent access (§I); the two output
formats and the error-code scheme (§J); and maintenance and trust reporting (§K). The full
list, one rule per requirement, is in [§3.2](#32-functions). The local Console and Team-stop
requirements, added after v1, form group U.

#### 1.3.3 User characteristics (§9.5.5)

- A developer coordinating two or more coding-agent terminals.
- A lead agent acting in the **Manager** Role while **Worker**s implement and an **Inspector**
  reviews.
- A team that wants Role and Team definitions it can keep in version control, without
  committing runtime state.
- A local-model user pointing a supported Participant CLI at Ollama or LM Studio.

All users are assumed to be comfortable with the command line and to work under one
operating-system user account whose processes all trust each other (see
[security.md](./security.md)).

#### 1.3.4 Limitations (§9.5.6)

crew depends on Node `>=24.15` (for `node:sqlite`) and a POSIX shell environment. Launch,
Team stop, and pane peek additionally depend on `tmux`; launching into a worktree (a separate
working copy of the repository that shares the same history) depends on `git`. crew cannot
verify which Agent is really talking to it (there is no authentication between Agents), does
not work on network filesystems, and offers no Windows tmux launch in v1. These limitations
drive the requirements in [§3.6](#36-design-constraints) and [§3.7](#37-system-attributes).

### 1.4 Definitions (§9.2.3)

Terms are **binding** per [CONTEXT.md](../../CONTEXT.md) and are used verbatim throughout: **Crew,
Agent, Participant CLI, Role, Team, Manager, Worker, Inspector, Task, Lease, Submission,
Review, Task Event, Message, Inbox, Workspace, State Store, Launcher, Relay, Setup Target,
Model Backend, Operator, Console, Worktree, Review Worktree.** See
[Appendix B](#appendix-b--acronyms-and-abbreviations) for acronyms.

---

## 2 References (§9.2.4)

**Guidance (informative for this SRS):**

- ISO/IEC/IEEE 29148:2011, *Systems and software engineering — Life cycle processes —
  Requirements engineering* (superseded edition; used as guidance only).
- crew [product specification](./product-spec.md), [architecture](./architecture.md),
  [CLI contract](./cli-contract.md), [data model](./data-model.md),
  [security model](./security.md), [configuration](./configuration.md),
  [setup integration](./setup-integration.md), [testing strategy](./testing-strategy.md),
  [decision index](./decisions.md).
- [CONTEXT.md](../../CONTEXT.md) — binding domain vocabulary.
- Accepted [ADRs](../adr/README.md) (ADR-0001…ADR-0011) and
  [ADR-0012](../adr/0012-optional-local-ui-server.md).

**Compliance (requirements imported by citation):** the CLI contract fixes the exact command
syntax and JSON output shapes; the data model fixes the database schema and the rules the
stored data must satisfy at all times. Where this SRS points to them, they are binding for
that detail.

---

## 3 Specific requirements

Each requirement has a unique id, points back to its source documents, and carries its own
verification information (§9.5.9). How well the requirements meet the §5.2 quality
characteristics is assessed in [Appendix E](#appendix-e--quality-grading-matrix).

### 3.1 External interfaces (§9.5.10)

crew's inputs and outputs cross six boundaries. The exact formats are fixed by the linked
contract documents and are not repeated here.

- **CLI command surface** — subcommands `init`, `join`, `leave`, `agents`, `send`, `receive`,
  `pending`, `history`, `task …`, `roles`/`role …`, `teams`/`team …`, `setup`, `doctor`,
  `prune`, `clean`, `ui`, and the internal `relay`. Purpose, arguments, valid ranges, and
  command formats are defined by [cli-contract.md](./cli-contract.md). Source of input:
  operator arguments and stdin; destination of output: stdout/stderr.
- **Human + NDJSON output contract** — every command that produces records emits either a
  human-readable rendering with terminal control sequences stripped (stdout) or one complete
  JSON object per line (`--json`), each carrying `type` and `schema_version`. Errors render as
  `[CODE] message` (human) or a `{ ok: false, error: {…} }` wrapper object. An ordinary
  command does its work and exits; `crew ui` prints its start result and then keeps serving in
  the foreground until Ctrl-C. See §3.2 groups J and U and [cli-contract.md](./cli-contract.md).
- **`.crew/` file layout** — `roles/`, `teams/`, `launcher.yaml`, `run-task.md` (meant to be
  kept in version control); `state/` and `generated/` (runtime files, ignored by git). Formats
  are defined by [configuration.md](./configuration.md).
- **SQLite State Store** — one local database at `.crew/state/crew.db` opened through
  `node:sqlite`; entities, relationships, and integrity constraints are defined by
  [data-model.md](./data-model.md) and summarized in [§3.5](#35-logical-database-requirements).
- **Local Console HTTP interface** — the optional foreground Console serves its bundled page
  and token-checked requests only on the IPv4 loopback address (reachable only from your own
  computer), and pushes change notifications to the browser as server-sent events; group U
  defines when it runs and what it may do.
- **tmux / git (launched mode)** — the Launcher creates a tmux session and types each
  Participant's start command into its pane; the optional Relay nudges idle panes. Worktree
  isolation (giving the launched Crew its own separate working copy of the repository) runs
  `git` as a child process. Both tools are reached only through adapters that pass arguments
  as an array with `shell:false`, so no shell ever interprets the values.

### 3.2 Functions (§9.5.11)

Functional requirements are grouped A–K, U, and W. Groups A–K are mandatory ("shall") for v1;
groups U and W were added after v1 and are just as mandatory. Behavior requirements for
storage (group I), output (group J), and maintenance (group K) stay here in §3.2 by design;
the quality sections (§3.3–§3.7) add quality-attribute NFRs and point to these functions
rather than restating them.

#### A. Product and execution model

- **FR-A01 — Single executable.** crew shall ship one `crew` executable from a scoped npm
  package. *Verify: automated test — `tests/integration/package/pack-smoke.test.ts`.*
- **FR-A02 — One-shot core.** Every core command shall perform bounded work and then exit
  (it runs, does its job, and stops — nothing stays running). *Verify: analysis —
  architecture.md.*
- **FR-A03 — No resident core process.** No core command shall start a detached process or
  require a daemon, socket, or server. *Verify: inspection — product-spec Non-goals.*
- **FR-A04 — Optional Relay in launched mode.** Launched mode may keep one session-scoped Relay
  alive in tmux. *Verify: automated test — `tests/spawn/tmux-e2e.test.ts`.*
- **FR-A05 — Manual mode needs no Relay.** Manual mode and all data operations shall function
  without a Relay. *Verify: automated test — `tests/integration/commands/*.test.ts` (data
  operations run without tmux).*
- **FR-A06 — No inference.** crew shall never call a model-provider endpoint or embed a model.
  *Verify: analysis — no network/model dependency; security.md Assets.*
- **FR-A07 — Participant Agents are shell-capable.** An Agent representing a Participant CLI
  shall be shell-capable; the plain Operator Agent in FR-U13 has platform `NULL` and is not a
  Participant CLI. *Verify: inspection — CONTEXT.md; `src/participants.ts`.*
- **FR-A08 — Backends are not Agents.** Ollama and LM Studio shall remain Model Backends and
  shall not register as Agents. *Verify: automated test — `tests/integration/commands/setup.test.ts`
  (backend recipe path).*
- **FR-A09 — Runtime floor.** crew shall support Node.js `>=24.15` on macOS and Linux.
  *Verify: automated test — `tests/unit/node-floor.test.ts`, `tests/unit/bin-floor-fail.test.ts`,
  `tests/unit/bin-floor-pass.test.ts`.*
- **FR-A10 — Platform-neutral core.** Core command behavior shall be platform-neutral wherever
  Node and local SQLite are available. *Verify: analysis — CI matrix (Ubuntu + macOS).*
- **FR-A11 — Explicit commands.** Unknown commands shall fail with `USAGE`. *Verify: automated
  test — `tests/integration/program/run.test.ts`.*
- **FR-A12 — No implicit mutation.** No typo or shorthand shall implicitly join or mutate
  state. *Verify: automated test — `tests/integration/program/run.test.ts`.*

#### B. Workspace and initialization

- **FR-B01 — Discovery.** State commands shall use the nearest ancestor directory containing
  `.crew/`. *Verify: automated test — `tests/unit/workspace.test.ts`.*
- **FR-B02 — Resolved Workspace surfaced.** `doctor` shall surface the resolved Workspace.
  *Verify: automated test — `tests/integration/commands/doctor.test.ts`.*
- **FR-B03 — Ambiguity warning.** Documentation shall warn that nested `.crew/` directories or
  a mid-session `cd` can select a different Crew. *Verify: inspection — configuration.md;
  doctor nested-workspace finding.*
- **FR-B04 — Initialization layout.** `init` shall create `.crew/{roles,teams,state,generated}`.
  *Verify: automated test — `tests/integration/commands/init.test.ts`.*
- **FR-B05 — Seed built-ins.** `init` shall seed missing built-in Role and Team files.
  *Verify: automated test — `tests/integration/commands/init.test.ts`, `tests/unit/templates.test.ts`.*
- **FR-B06 — Non-destructive init.** `init` shall never overwrite an existing file. *Verify:
  automated test — `tests/integration/commands/init.test.ts`.*
- **FR-B07 — Trackable configuration.** Roles, Teams, `launcher.yaml`, and `run-task.md` shall
  be eligible for version control. *Verify: inspection — configuration.md;
  `tests/integration/commands/init.test.ts`.*
- **FR-B08 — Selective ignore.** `init` shall idempotently maintain `.crew/.gitignore` —
  running it again changes nothing more — so that the `state/` and `generated/` subtrees
  (entries applied relative to `.crew/`) are ignored.
  *Verify: automated test — `tests/integration/commands/init.test.ts`.*
- **FR-B09 — Never ignore all of `.crew/`.** `init` shall never cause the whole `.crew/`
  directory to be ignored. *Verify: automated test — `tests/integration/commands/init.test.ts`.*
- **FR-B10 — Never touch the repo-root ignore.** `init` shall never edit the repository-root
  `.gitignore`. *Verify: automated test — `tests/integration/commands/init.test.ts`.*
- **FR-B11 — No default home write.** `init` shall not write under `$HOME`. *Verify: automated
  test — `tests/integration/commands/init.test.ts`.*
- **FR-B12 — Artifacts only via setup.** Participant CLI artifacts (the integration files
  crew generates for each CLI) shall be installed only by explicit `setup`. *Verify: automated
  test — `tests/integration/commands/setup.test.ts`.*
- **FR-B13 — Optional guides.** `init --with-guides` shall append a marked section only to
  existing `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`, at most once each, preserving the
  pre-existing bytes verbatim. *Verify: automated
  test — `tests/integration/commands/init.test.ts`.*
- **FR-B14 — Atomic writes.** Workspace writes shall be atomic — a file appears fully written
  or not at all (written to a temporary sibling file, then renamed into place, where the
  filesystem supports it). *Verify: automated test — `tests/unit/fs-safe.test.ts`.*
- **FR-B15 — Reject path escapes.** Workspace writes shall reject symlinks and paths that
  would land a managed file outside the Workspace. *Verify: automated test —
  `tests/unit/fs-safe.test.ts`, `tests/unit/setup-fs.test.ts`.*

#### C. Agent lifecycle

- **FR-C01 — Join.** `join` shall validate id, Role, and optional platform and insert one
  active Agent. *Verify: automated test — `tests/store/agents.test.ts`.*
- **FR-C02 — Atomic suffix.** Concurrent joins of one requested id shall receive distinct ids
  (the requested id, then `-2` through `-99`). *Verify: automated test — `tests/spawn/agents.test.ts`.*
- **FR-C03 — Explicit exhaustion.** Id-space exhaustion under suffixing shall fail explicitly.
  *Verify: automated test — `tests/store/agents.test.ts`.*
- **FR-C04 — Archived reservation.** Archived ids shall remain reserved and shall never be
  inherited by ordinary collision suffixing. *Verify: automated test — `tests/store/agents.test.ts`.*
- **FR-C05 — Explicit resume.** `join --resume` shall reactivate the exact archived id.
  *Verify: automated test — `tests/store/agents.test.ts`.*
- **FR-C06 — Resume preconditions.** `join --resume` shall reject an active id or an explicitly
  conflicting Role. *Verify: automated test — `tests/store/agents.test.ts`.*
- **FR-C07 — Leave archives.** `leave` shall archive the Agent. *Verify: automated test —
  `tests/store/agents.test.ts`.*
- **FR-C08 — Leave preserves history.** `leave` shall preserve the Agent's Messages, Tasks, and
  history. *Verify: automated test — `tests/store/agents.test.ts`.*
- **FR-C09 — List active default.** `agents` shall list active registrations by default.
  *Verify: automated test — `tests/integration/commands/agents.test.ts`.*
- **FR-C10 — List all.** `agents --all` shall additionally include archived registrations.
  *Verify: automated test — `tests/integration/commands/agents.test.ts`.*
- **FR-C11 — Activity labels.** crew shall derive recent/idle/stale labels from `last_seen`
  (the recorded time the Agent last did something). *Verify: automated test —
  `tests/store/agents.test.ts`.*
- **FR-C12 — Never claim online.** crew shall never present a registration as online (crew
  cannot prove a process is alive, so it never says so). *Verify:
  automated test — `tests/integration/commands/agents.test.ts`.*
- **FR-C13 — Staleness is inert for lifecycle.** crew shall never use staleness alone (a long
  time since `last_seen`) to archive or reassign a registration. *Verify: automated test —
  `tests/store/tasks.test.ts` (injected-clock Lease matrix); see also FR-K09.*
- **FR-C14 — Activity update on acting.** Successful acting commands (`send`, `receive`, Task
  mutations) shall update the actor's `last_seen`. *Verify: automated test —
  `tests/store/agents.test.ts`.*
- **FR-C15 — No activity update on observation.** Read-only observation shall not update
  `last_seen`. *Verify: automated test — `tests/store/agents.test.ts`.*
- **FR-C16 — Role grants no privilege.** Store invariants shall be enforced from explicit actor
  ids regardless of Role name. *Verify: automated test — `tests/store/tasks.test.ts`.*
- **FR-C17 — Shared-trust documented.** The shared-trust limitation shall be documented.
  *Verify: inspection — security.md; FR-K08.*

#### D. Messaging

- **FR-D01 — Direct send.** `send` shall require an active sender, an active recipient, and
  non-empty content. *Verify: automated test — `tests/store/messages.test.ts`.*
- **FR-D02 — Exclusive input source.** `send` shall accept either positional content or
  `--file <path|->`, never both. *Verify: automated test — `tests/integration/commands/messages.test.ts`.*
- **FR-D03 — Faithful decode.** `send` shall strictly decode bounded UTF-8 input and preserve
  content exactly. *Verify: automated test — `tests/store/messages.test.ts` (byte-exact).*
- **FR-D04 — Content bounds.** `send` shall enforce a content length of 1–100,000 Unicode code
  points. *Verify: automated test — `tests/integration/commands/messages.test.ts`.*
- **FR-D05 — Broadcast expansion.** `@all` shall expand transactionally to all other active
  Agents (one Message per recipient, all created in one all-or-nothing database step).
  *Verify: automated test — `tests/store/messages.test.ts`.*
- **FR-D06 — Broadcast reporting.** A broadcast shall report the actual recipients in id order.
  *Verify: automated test — `tests/integration/commands/messages.test.ts`.*
- **FR-D07 — Empty broadcast valid.** A broadcast with an empty recipient snapshot shall
  succeed and create no records. *Verify: automated test — `tests/store/messages.test.ts`.*
- **FR-D08 — Reply link.** A direct note may link to an accessible prior Message. *Verify:
  automated test — `tests/store/messages.test.ts`.*
- **FR-D09 — Invalid link fails.** An invalid or unrelated reply link shall fail. *Verify:
  automated test — `tests/store/messages.test.ts`.*
- **FR-D10 — Bounded receive.** `receive` shall atomically (in one indivisible step) mark as
  read and return at most the requested limit of Messages (default 50, maximum 500). *Verify:
  automated test — `tests/store/messages.test.ts`.*
- **FR-D11 — Receive order.** Received Messages shall be ordered by creation time and id.
  *Verify: automated test — `tests/store/messages.test.ts`.*
- **FR-D12 — Receive touches actor.** Even an empty receive shall update the active receiving
  Agent's activity. *Verify: automated test — `tests/store/messages.test.ts`.*
- **FR-D13 — Concurrent receive disjoint.** Two successful concurrent receivers shall never
  return the same Message. *Verify: automated test — `tests/spawn/messages.test.ts`.*
- **FR-D14 — Honest delivery guarantee.** Receive shall be documented as at-most-once — a
  Message is delivered once, or (if the receiving process crashes right after the database
  marks it read but before the Agent sees it) not at all; it is never delivered twice.
  *Verify: inspection — cli-contract.md; product-spec.*
- **FR-D15 — History retention.** Message history shall retain every row, read and unread.
  *Verify: automated test — `tests/store/messages.test.ts`.*
- **FR-D16 — Non-consuming pending.** `pending` shall optionally filter by Agent and shall
  never change `read_at`. *Verify: automated test — `tests/integration/commands/messages.test.ts`.*
- **FR-D17 — Content-free summary.** `pending --summary` shall require an Agent and return only
  the unread count and the highest Message id — a way to watch a whole Inbox without ever
  seeing Message text. *Verify: automated test — `tests/store/security-summary.test.ts`.*
- **FR-D18 — Pending default window.** Full `pending` shall default to the oldest 50 Messages.
  *Verify: automated test — `tests/integration/commands/messages.test.ts`.*
- **FR-D19 — History filters.** `history` shall filter by participant, sender, recipient, and
  time, apply a bounded limit, and include read and unread Messages. *Verify: automated test —
  `tests/store/messages.test.ts`.*
- **FR-D20 — History time formats.** `history` time bounds shall accept inclusive safe epoch
  seconds or exact-second ISO-8601 with an explicit offset. *Verify: automated test —
  `tests/integration/commands/messages.test.ts`.*
- **FR-D21 — History ordering.** `history` shall return the newest bounded window ordered
  oldest-to-newest. *Verify: automated test — `tests/store/messages.test.ts`.*
- **FR-D22 — Notifications from transitions only.** Task-notification kinds shall be emitted
  only by Task transitions in the same transaction and shall never be forged through freeform
  `send` options. *Verify: automated test — `tests/store/tasks.test.ts`.*
- **FR-D23 — Notification recipient set.** Notification target ids shall be deduplicated, the
  acting Agent shall be omitted, and archived recipients shall be skipped (an empty recipient
  set is valid) — except that the assignee's `clear_safe` Sign-off (ADR-0016) shall be
  delivered even when the assignee is the acting Agent, skipping only an archived assignee.
  *Verify: automated test — `tests/store/tasks.test.ts`.*
- **FR-D24 — Notification content is a pointer.** Notification content shall be one short,
  length-limited line naming the Task and actor — a pointer, not the story; the free-text
  Submission/Review/requeue reason shall live in the Task Event detail. *Verify: automated
  test — `tests/store/tasks.test.ts`.*

#### E. Reviewed Tasks

- **FR-E01 — Create preconditions.** Task creation shall require an active creator, assignee,
  and reviewer. *Verify: automated test — `tests/store/tasks.test.ts`.*
- **FR-E02 — Create effect.** Task creation shall insert a `queued` revision-0 Task, append a
  `created` Task Event, and notify the assignee atomically. *Verify: automated test —
  `tests/store/tasks.test.ts`.*
- **FR-E03 — Start authorization.** Only the assignee shall move a Task from `queued` to
  `in_progress`. *Verify: automated test — `tests/store/tasks.test.ts`.*
- **FR-E04 — Start effect.** Start shall grant a 15-minute Lease and append a Task Event.
  *Verify: automated test — `tests/store/tasks.test.ts`.*
- **FR-E05 — Submit authorization.** Only the unexpired Lease owner shall move a Task from
  `in_progress` to `submitted`. *Verify: automated test — `tests/store/tasks.test.ts`.*
- **FR-E06 — Submit effect.** Submit shall store a non-empty Submission, clear the Lease, record
  the event, and notify the reviewer and creator atomically. *Verify: automated test —
  `tests/store/tasks.test.ts`.*
- **FR-E07 — Approve authorization.** Only the reviewer shall move a Task from `submitted` to
  `completed`. *Verify: automated test — `tests/store/tasks.test.ts`.*
- **FR-E08 — Approve effect.** Approve shall record the optional Review summary and event and
  notify the creator and assignee atomically. *Verify: automated test — `tests/store/tasks.test.ts`.*
- **FR-E09 — Rework authorization.** The creator or reviewer shall be able to requeue a
  `submitted` Task. *Verify: automated test — `tests/store/tasks.test.ts`.*
- **FR-E10 — Rework inputs.** Requeue of a submitted Task shall require a mandatory reason and
  accept an optional new active assignee. *Verify: automated test — `tests/store/tasks.test.ts`.*
- **FR-E11 — Lease recovery.** The creator or reviewer shall be able to requeue an
  `in_progress` Task only after Lease expiry. *Verify: automated test — `tests/store/tasks.test.ts`.*
- **FR-E12 — No lease theft.** An active (unexpired) Lease shall not be stolen. *Verify:
  automated test — `tests/store/tasks.test.ts`.*
- **FR-E13 — Clean requeue state.** Requeue shall clear the Lease, Submission, Review, and
  completion fields and increment the revision. *Verify: automated test — `tests/store/tasks.test.ts`.*
- **FR-E14 — Requeue event and notify.** Requeue shall append a Task Event and notify the
  resulting (post-retarget) assignee, creator, and reviewer atomically. *Verify: automated
  test — `tests/store/tasks.test.ts`.*
- **FR-E15 — CAS transition.** Every transition shall be a compare-and-set on the expected
  status and revision plus actor/Lease conditions (the update applies only when all of these
  still match, so two racing writers cannot both win) and shall change exactly one Task row.
  *Verify: automated test — `tests/spawn/tasks.test.ts`, `tests/store/tasks.test.ts`.*
- **FR-E16 — Forward-transition liveness.** The forward transitions (create, start, submit,
  approve) shall require the creator, assignee, and reviewer to all be active. *Verify:
  automated test — `tests/store/tasks.test.ts`.*
- **FR-E17 — Requeue liveness exemption.** Requeue shall require the acting creator/reviewer and
  any `--to` assignee to be active but shall exempt a departed prior assignee so Lease recovery
  stays reachable. *Verify: automated test — `tests/store/tasks.test.ts`.*
- **FR-E18 — Immutable history.** Every successful transition shall have exactly one immutable
  Task Event (a record that is never edited or deleted afterwards) carrying the new revision.
  *Verify: automated test — `tests/store/tasks.test.ts`, `tests/spawn/tasks.test.ts`.*
- **FR-E19 — Read surfaces.** Task show/list shall filter and render the full current Task
  state. *Verify: automated test — `tests/store/tasks.test.ts`.*
- **FR-E20 — Stale Lease visible.** Stale (expired) Leases shall be explicitly computed and
  visible wherever Tasks are shown. *Verify: automated test — `tests/store/tasks.test.ts`.*
- **FR-E21 — Completed immutability.** Completed Tasks shall not be requeued or edited in v1.
  *Verify: automated test — `tests/store/tasks.test.ts`.*
- **FR-E22 — Abandon authorization (additive post-v1).** The creator or reviewer shall
  retire a `queued`, `in_progress`, or `submitted` Task to the terminal `abandoned` status.
  Once both the creator and reviewer are archived, the plain `operator` Agent identity (id
  `operator`, Role `operator`, platform `NULL` — ADR-0012) shall be permitted to abandon on
  their behalf; a row that merely holds the id `operator` but has a different Role or platform
  is not the plain identity and is refused, matching the Console's own operator-identity
  guard. *Verify: automated
  test — `tests/store/tasks.test.ts`, `tests/integration/commands/tasks.test.ts`.*
- **FR-E23 — Abandon effect and terminality (additive post-v1).** Abandon shall clear
  the Lease, stamp `abandonedAt`, append one immutable Task Event, and notify the creator,
  assignee, and reviewer; the assignee's notification shall carry the structured `clear_safe`
  Sign-off kind (ADR-0016) and shall be delivered even when the assignee is the acting Agent,
  while the creator/reviewer copies remain plain `note`s minus the acting Agent.
  `abandoned` is terminal like `completed`: an
  abandoned Task shall not be requeued, approved, or abandoned again. *Verify: automated test —
  `tests/store/tasks.test.ts`.*
- **FR-E24 — Abandon retention (additive post-v1).** `crew prune` shall delete abandoned
  Tasks past the same Task retention window as completed Tasks, using `abandonedAt` as the age
  cutoff. *Verify: automated test — `tests/store/maintenance.test.ts`.*

#### F. Roles and Teams

- **FR-F01 — Built-in Roles.** crew shall package Manager, Worker, and Inspector Role prompts.
  *Verify: automated test — `tests/unit/templates.test.ts`.*
- **FR-F02 — Role override.** A project `.crew/roles/<name>.md` shall override the packaged
  Role. *Verify: automated test — `tests/integration/commands/roles.test.ts`.*
- **FR-F03 — Role source shown.** Role list/show shall identify the source (packaged vs
  project). *Verify: automated test — `tests/integration/commands/roles.test.ts`.*
- **FR-F04 — Role export.** Role export shall copy a packaged Role into the project. *Verify:
  automated test — `tests/integration/commands/roles.test.ts`.*
- **FR-F05 — Export non-destructive.** Role export shall never overwrite an existing file
  without `--force`. *Verify: automated test — `tests/integration/commands/roles.test.ts`.*
- **FR-F06 — Untrusted input as data.** Built-in Roles shall treat Messages, briefs, config
  text, and tool output as untrusted data. *Verify: automated test — `tests/unit/templates.test.ts`.*
- **FR-F07 — Goal-subordinate instructions.** Built-in Roles shall not follow instructions that
  conflict with the user's goal or higher-priority Participant CLI policy. *Verify: automated
  test — `tests/unit/templates.test.ts`.*
- **FR-F08 — Team schema.** A Team shall have a version, a name, and member templates each
  containing an id, a Role, and optional replicas/platform hint. *Verify: automated test —
  `tests/integration/commands/teams.test.ts`.*
- **FR-F09 — Strict Team loading.** Unknown Team keys and unsafe YAML features shall be
  rejected. *Verify: automated test — `tests/unit/yaml-load.test.ts`, `tests/integration/commands/teams.test.ts`.*
- **FR-F10 — Team override.** Project Team files shall override packaged Teams by name.
  *Verify: automated test — `tests/integration/commands/teams.test.ts`.*
- **FR-F11 — Replica expansion.** Replicas (asking for several copies of one member) shall
  expand deterministically — the same Team file always yields exactly the same ids (`worker`,
  `worker-2`, …). *Verify: automated test — `tests/integration/commands/teams.test.ts`.*
- **FR-F12 — Replica collision detection.** Replica id collisions shall be detected before
  launch. *Verify: automated test — `tests/integration/commands/teams.test.ts`.*
- **FR-F13 — Team display invocation.** Team display shall print the exact platform invocation
  and join commands. *Verify: automated test — `tests/integration/commands/teams.test.ts`.*
- **FR-F14 — Display has no side effects.** Team display shall never join Agents or start
  processes. *Verify: automated test — `tests/integration/commands/teams.test.ts`.*

#### G. Setup Targets

- **FR-G01 — Single registry.** Setup, doctor, Team display, and Launcher shall obtain platform
  facts from one authoritative registry. *Verify: automated test — `tests/unit/platforms.test.ts`.*
- **FR-G02 — Detect-only default.** Bare setup shall report detected targets. *Verify: automated
  test — `tests/integration/commands/setup.test.ts`.*
- **FR-G03 — Detect writes nothing.** Bare setup shall write nothing. *Verify: automated test —
  `tests/integration/commands/setup.test.ts`.*
- **FR-G04 — Explicit participant install.** Setup for a Participant CLI shall write exactly one
  global or project artifact at the verified canonical path. *Verify: automated test —
  `tests/integration/commands/setup.test.ts`.*
- **FR-G05 — Managed marker.** Generated setup artifacts shall contain a crew version marker and
  content hash. *Verify: automated test — `tests/integration/commands/setup.test.ts`,
  `tests/unit/platforms.test.ts`.*
- **FR-G06 — Force and backup on drift.** Overwriting a target file that crew did not write,
  or that someone edited since crew wrote it, shall require `--force` and a backup. *Verify:
  automated test — `tests/integration/commands/setup.test.ts`, `tests/unit/setup-fs.test.ts`.*
- **FR-G07 — Actual invocation.** Setup output shall state the real invocation (Claude,
  Gemini, Pi, Little Coder, and opencode `/crew`; Codex `$crew`; Copilot `/agent` selection
  plus prompt). *Verify: automated test — `tests/unit/platforms.test.ts`.*
- **FR-G08 — Scoped permission guidance.** Setup guidance shall prefer permission limited to the
  `crew` command. *Verify: inspection — setup-integration.md; `src/platforms/shared.ts`.*
- **FR-G09 — No automatic bypass flags.** Blunt permission-bypass flags shall never be enabled
  automatically, and their full blast radius — everything such a flag would put at risk —
  shall be stated. *Verify: inspection — security.md Permissions guidance;
  `src/platforms/shared.ts`.*
- **FR-G10 — Backend recipe is read-only.** Ollama/LM Studio setup shall perform read-only
  prerequisite checks and print a Participant CLI recipe. *Verify: automated test —
  `tests/integration/commands/setup.test.ts`.*
- **FR-G11 — No silent backend edits.** Backend setup shall never silently edit third-party
  model configuration. *Verify: automated test — `tests/integration/commands/setup.test.ts`.*
- **FR-G12 — Versioned registry.** Registry entries shall include minimum verified versions and
  a verification date. *Verify: automated test — `tests/unit/platforms.test.ts`.*
- **FR-G13 — Support requires a smoke.** Release shall not claim support for a target without a
  live smoke result (a real end-to-end run against the actually installed tool). *Verify:
  automated test — `tests/unit/platforms.test.ts`; release-gate Participant CLI matrix.*

#### H. Launcher and Relay

- **FR-H01 — Optional tmux adjunct.** Launch shall be an optional Unix/tmux add-on; every
  other part of crew works without it. *Verify: automated test —
  `tests/integration/commands/team-launch.test.ts`.*
- **FR-H02 — Missing-tmux behavior.** When tmux is missing, launch shall return manual commands
  and `DEPENDENCY_MISSING` and create no partial session. *Verify: automated test —
  `tests/integration/commands/team-launch.test.ts`, `tests/integration/commands/team-launch-live.test.ts`.*
- **FR-H03 — Validate before mutating.** The Launcher shall resolve and validate all config,
  paths, roster, executable, Task brief, and generated artifacts before mutating state or tmux.
  *Verify: automated test — `tests/unit/launcher/plan.test.ts`, `tests/unit/launcher/config.test.ts`.*
- **FR-H04 — Side-effect-free print.** `--print` shall produce the full launch plan without
  setup writes, State Store mutation, subprocesses, worktrees, or tmux. *Verify: automated
  test — `tests/unit/launcher/plan.test.ts`; ADR-0007.*
- **FR-H05 — Homogeneous launch.** v1 automatic launch shall use one Participant CLI for all
  panes, resolved `--client` > tracked `runtime.client` > default. *Verify: automated test —
  `tests/unit/launcher/plan.test.ts`.*
- **FR-H06 — Reject mixed hints.** A Team with mixed platform hints and no homogeneous override
  shall be rejected with `USAGE` and a manual-mode instruction. *Verify: automated test —
  `tests/unit/launcher/plan.test.ts`.*
- **FR-H07 — Registry-id executable.** Tracked config shall select a registry id and never an
  arbitrary command or path. *Verify: automated test — `tests/unit/launcher/config.test.ts`,
  `tests/unit/launcher/plan.test.ts`.*
- **FR-H08 — Confirmed custom executable.** A custom executable shall require an explicit CLI
  flag and confirmation output. *Verify: automated test — `tests/unit/launcher/plan.test.ts`.*
- **FR-H09 — Safe spawn.** Subprocesses shall be spawned with argument arrays and `shell:false`.
  *Verify: automated test — `tests/unit/launcher/tmux.test.ts`.*
- **FR-H10 — Worktree containment.** Worktree containment shall be validated and unsafe paths
  rejected. *Verify: automated test — `tests/unit/launcher/worktree.test.ts`, `tests/unit/launcher/ref.test.ts`.*
- **FR-H11 — Registry launch injection.** Pane startup argv and any post-start pane paste shall
  come from the platform registry; post-start input shall use paste-buffer mechanics. *Verify:
  automated test — `tests/unit/launcher/tmux.test.ts`,
  `tests/integration/commands/team-launch-live.test.ts`.*
- **FR-H12 — No shell interpolation.** Pane injection shall never use shell interpolation or a
  hard-coded `/crew`. *Verify: automated test — `tests/unit/launcher/tmux.test.ts`.*
- **FR-H13 — Bounded readiness.** Pane readiness and Agent-registration waits shall be bounded
  with actionable timeout errors. *Verify: automated test — `tests/spawn/tmux-e2e.test.ts`.*
- **FR-H14 — Partial-session cleanup.** A failed launch shall clean up any newly created partial
  session. *Verify: automated test — `tests/spawn/tmux-e2e.test.ts` (owned session teardown and
  SIGINT-during-build recovery via `team stop`).*
- **FR-H15 — Relay observation.** The Relay shall observe only the content-free, non-consuming
  pending summary (it sees unread counts, never Message text, and marks nothing as read).
  *Verify: automated test — `tests/unit/relay.test.ts`, `tests/store/security-summary.test.ts`.*
- **FR-H16 — Relay never consumes.** The Relay shall never call `receive` or read full pending
  records. *Verify: automated test — `tests/unit/relay.test.ts`, `tests/unit/launcher/relay.test.ts`.*
- **FR-H17 — Fixed nudge.** The Relay shall inject only a fixed command nudge containing a
  validated Agent id. *Verify: automated test — `tests/unit/relay.test.ts`, `tests/unit/launcher/relay.test.ts`.*
- **FR-H18 — Nudge carries no content.** The Relay shall never inject Message content, Task
  text, or config text. *Verify: automated test — `tests/unit/relay.test.ts`,
  `tests/store/security-summary.test.ts`.*
- **FR-H19 — Reminder rate limit.** The Relay shall rate-limit reminders. *Verify: automated
  test — `tests/unit/relay.test.ts`, `tests/unit/launcher/relay.test.ts`.*
- **FR-H20 — Relay stop conditions.** The Relay shall exit on session end, SIGTERM, or a missing
  Workspace. *Verify: automated test — `tests/unit/relay.test.ts`.*
- **FR-H21 — Whole-Crew worktree.** Optional worktree isolation shall create or reuse one
  contained worktree — a separate working copy of the repository — shared by the entire Crew.
  *Verify: automated test — `tests/unit/launcher/worktree.test.ts`.*
- **FR-H22 — Argument-safe refs.** Worktree branch and base values shall be safe to pass as
  plain command arguments (nothing in them can be mistaken for a flag or shell syntax).
  *Verify: automated test — `tests/unit/launcher/ref.test.ts`, `tests/unit/launcher/worktree.test.ts`.*
- **FR-H23 — Launch token injection.** A live launch shall generate a per-invocation
  cryptographic token and inject it into each pane's environment as `CREW_LAUNCH_TOKEN`.
  *Verify: automated test — `tests/store/launch-token.test.ts`, `tests/unit/launcher/tmux.test.ts`.*
- **FR-H24 — Create-path stamp.** The launch shall stamp the token onto every Agent the panes
  create (`launch_token`, create-path only). *Verify: automated test — `tests/store/launch-token.test.ts`.*
- **FR-H25 — Scoped teardown reap.** Only after a confirmed session teardown shall the reap
  (the cleanup that deletes launch-created Agent rows) remove the rows carrying that token
  which left no footprint — no Task reference, no attributed Task Event, no Message — freeing
  their ids for immediate relaunch. *Verify: automated test —
  `tests/store/launch-token.test.ts`.*
- **FR-H26 — Reap never over-reaches.** The reap shall never touch an Agent that existed
  before the launch, carries a different launch's token, or has been used in any way. *Verify:
  automated test — `tests/store/launch-token.test.ts`.*
- **FR-H27 — Reap is skip-safe and best-effort.** The reap shall be skipped when teardown cannot
  be confirmed and shall be best-effort otherwise (any failure simply leaves the rows in place
  for `crew agents`/`doctor`/retry). *Verify: automated test — `tests/store/launch-token.test.ts`.*
- **FR-H28 — Token confinement.** The launch token shall exist only in pane environment
  variables and Agent rows and shall never appear in any output (the launcher-side statement
  of FR-J15). *Verify: automated test — `tests/integration/commands/security-redaction.test.ts`.*
- **FR-H29 — Stale-Lease nudge (additive post-v1).** The Relay shall nudge a stale Task's
  creator, not its assignee, using the same fixed-command-only nudge mechanism and per-target
  reminder throttle already established for Inbox nudges (FR-H17/H19), on an independent
  per-Task clock. *Verify: automated test — `tests/unit/launcher/relay.test.ts`,
  `tests/unit/relay.test.ts`.*

#### I. Persistence and concurrency

- **FR-I01 — Single Store owner.** Only the Store Module shall import `node:sqlite`. *Verify:
  automated test — `tests/unit/sqlite-ownership.test.ts`.*
- **FR-I02 — Local State Store.** Shared mutable state shall be the one local State Store.
  *Verify: inspection — data-model.md; ADR-0002.*
- **FR-I03 — No network filesystems.** Network filesystems and remote database servers shall be
  unsupported. *Verify: inspection — security.md; CLAUDE.md.*
- **FR-I04 — Integrity-hardened open.** The Store shall open every connection with foreign-key
  enforcement, defensive mode, and extension-loading denial. *Verify: automated test —
  `tests/store/schema.test.ts`.*
- **FR-I05 — Durability-hardened open.** The Store shall open every connection with WAL
  journaling (write-ahead logging, an SQLite mode that lets readers keep working while one
  writer writes), `synchronous=NORMAL`, and a 5-second busy timeout. *Verify: automated test —
  `tests/store/schema.test.ts`, `tests/unit/store-backoff.test.ts`.*
- **FR-I06 — Version pragma.** The schema version shall be tracked with `PRAGMA user_version`.
  *Verify: automated test — `tests/store/schema.test.ts`.*
- **FR-I07 — Reject newer schema.** A newer-than-supported schema shall be rejected. *Verify:
  automated test — `tests/store/schema.test.ts`.*
- **FR-I08 — Migrate older schema.** A supported older schema shall be migrated transactionally.
  *Verify: automated test — `tests/store/schema.test.ts`, `tests/spawn/tasks.test.ts`.*
- **FR-I09 — Constraints.** The schema shall use STRICT tables and NOT NULL/CHECK/foreign-key
  constraints — the database itself rejects invalid rows instead of trusting the code never to
  write them — plus the indexes specified in the data model. *Verify: automated test —
  `tests/store/schema.test.ts`.*
- **FR-I10 — Bounded contention.** After a busy timeout the Store shall retry once with bounded
  jitter (a short random delay with a fixed upper limit), then return an explicit `CONTENTION`
  error. *Verify: automated test —
  `tests/store/retry-random.test.ts`, `tests/unit/store-backoff.test.ts`,
  `tests/store/read-contention.test.ts` (every plain read accessor surfaces
  `CONTENTION`, not `INTEGRITY`, on a persistent SQLITE_BUSY/LOCKED).*
- **FR-I11 — No silent write loss.** The Store shall never silently drop or falsely confirm a
  write. *Verify: automated test — `tests/spawn/tasks.test.ts`, `tests/spawn/messages.test.ts`.*
- **FR-I12 — Writer lock before invariants.** Multi-statement Task transitions shall acquire
  their writer lock before reading the conditions they depend on (so the conditions cannot
  change between the check and the write). *Verify: automated test —
  `tests/store/tasks.test.ts`, `tests/spawn/tasks.test.ts`.*
- **FR-I13 — Single operation clock.** All rows written by one operation shall share one
  captured timestamp (the operation reads the clock once, not per row). *Verify: automated
  test — `tests/store/tasks.test.ts`.*
- **FR-I14 — Crash integrity.** If the process is killed mid-write, the database shall still
  pass SQLite's quick and foreign-key checks when reopened. *Verify: automated test —
  `tests/spawn/tasks.test.ts`.*

#### J. Output and errors

- **FR-J01 — Dual format.** Every record-producing command shall support human and NDJSON
  output. *Verify: automated test — `tests/integration/commands/*.test.ts`.*
- **FR-J02 — Stable envelope.** JSON records shall include `type` and `schema_version`.
  *Verify: automated test — `tests/integration/commands/init.test.ts`.*
- **FR-J03 — Additive compatibility.** Adding a new JSON field shall be a compatible change;
  removing or renaming one shall require a major contract-version bump. *Verify: inspection —
  cli-contract.md.*
- **FR-J04 — Empty JSON.** An empty successful query shall emit no JSON lines and exit 0.
  *Verify: automated test — `tests/integration/commands/messages.test.ts`.*
- **FR-J05 — Stream separation.** Success shall use stdout and errors shall use stderr in both
  modes. *Verify: automated test — `tests/unit/format.test.ts`, `tests/unit/errors.test.ts`.*
- **FR-J06 — Exit taxonomy.** Exit codes shall follow: 0 success, 1 operational/domain failure,
  2 usage/config failure. *Verify: automated test — `tests/unit/errors.test.ts`,
  `tests/integration/program/run.test.ts`.*
- **FR-J07 — Machine error codes.** Machine-readable error codes shall follow the CLI contract.
  *Verify: automated test — `tests/unit/errors.test.ts`, `tests/unit/format.test.ts`.*
- **FR-J08 — Human sanitization.** Human output shall strip ANSI and control sequences (bytes
  that could manipulate the reader's terminal). *Verify: automated test —
  `tests/unit/format.test.ts`, `tests/integration/commands/doctor.test.ts`.*
- **FR-J09 — Continuation prefixing.** Human output shall visibly prefix continuation lines.
  *Verify: automated test — `tests/unit/format.test.ts`.*
- **FR-J10 — Preview truncation.** Human previews shall be truncated by Unicode code point.
  *Verify: automated test — `tests/unit/format.test.ts`.*
- **FR-J11 — JSON fidelity.** JSON serialization shall escape controls but preserve stored
  content. *Verify: automated test — `tests/unit/format.test.ts`, `tests/integration/commands/roles.test.ts`.*
- **FR-J12 — Redact secrets, dump nothing.** Error and setup output shall redact tokens and keys
  and shall never dump full environment variables or arbitrary config bodies. *Verify: automated
  test — `tests/unit/format.test.ts`, `tests/unit/yaml-load.test.ts`.*
- **FR-J13 — No credential env value.** crew shall emit no credential environment value in any
  output (probes are reported by name; the only environment-derived value shown is the
  non-secret worktree base path). *Verify: automated test —
  `tests/integration/commands/security-redaction.test.ts`.*
- **FR-J14 — Bounded value redactor.** One central value-based redactor (it recognizes the
  secret values themselves, not just variable names) shall mask any secret-looking value in
  error and setup output, and shall finish within a bounded time no matter what the input
  looks like. *Verify: automated test — `tests/unit/format.test.ts`,
  `tests/helpers/security-corpus.ts`.*
- **FR-J15 — Token never rendered.** The launch token shall never be rendered to any surface.
  *Verify: automated test — `tests/integration/commands/security-redaction.test.ts`.*

#### K. Maintenance and trust

- **FR-K01 — Doctor diagnostics.** `doctor` shall provide read-only system, setup, Workspace,
  exported built-in drift, schema, integrity, dependency, expired-Lease, and archived-owner
  diagnostics. *Verify: automated test — `tests/integration/commands/doctor.test.ts`,
  `tests/unit/doctor.test.ts`.*
- **FR-K02 — Prune eligibility.** Prune shall delete only read Messages and completed Tasks
  older than the explicit or default retention cutoffs. *Verify: automated test —
  `tests/integration/commands/prune.test.ts`, `tests/store/maintenance.test.ts`.*
- **FR-K03 — Task prune cascade.** A Task shall be prune-eligible only when all its linked
  Messages are read, and its deletion shall cascade its Task Events and notifications. *Verify:
  automated test — `tests/store/maintenance.test.ts`.*
- **FR-K04 — Prune reporting.** Prune shall report deletion counts before an optional vacuum
  (compacting the database file to reclaim the freed space). *Verify: automated test —
  `tests/integration/commands/prune.test.ts`.*
- **FR-K05 — Vacuum guard.** Vacuum shall be refused while active Agents exist. *Verify:
  automated test — `tests/store/maintenance.test.ts`.*
- **FR-K06 — Clean guard.** `clean` shall refuse State Store deletion while active Agents exist
  unless `--force`. *Verify: automated test — `tests/integration/commands/clean.test.ts`,
  `tests/spawn/maintenance.test.ts`.*
- **FR-K07 — Clean scope.** `clean` shall never remove tracked config or Participant CLI setup
  artifacts. *Verify: automated test — `tests/integration/commands/clean.test.ts`.*
- **FR-K08 — Shared-trust statement.** Documentation and setup output shall state that Agent
  identity is spoofable (can be faked, since crew never verifies who is calling) and that all
  participants must therefore trust each other. *Verify: inspection — security.md;
  `src/setup/index.ts`.*
- **FR-K09 — No auto-destructive liveness.** Stale activity alone shall never archive an Agent,
  requeue a Task, delete data, or kill a process. *Verify: automated test —
  `tests/store/tasks.test.ts`.*
- **FR-K10 — Retention visibility.** README and `doctor` shall explain how long data is kept
  by default and the receive crash window (FR-D14), so users know this before relying on crew
  for irreplaceable records. *Verify: inspection — README; doctor output.*

#### U. Local Console and owned-Team stop

- **FR-U01 — Explicit foreground Console.** `crew ui` shall start a foreground HTTP server only
  when explicitly invoked by the Operator. *Verify: automated test —
  `tests/integration/commands/ui.test.ts`, `tests/integration/commands/ui-cli.test.ts`.*
- **FR-U02 — Loopback-only bind.** The Console server shall bind only to IPv4 address
  `127.0.0.1`, so it is reachable only from your own computer. *Verify: automated test —
  `tests/integration/ui-server.test.ts`.*
- **FR-U03 — Port selection.** `crew ui` shall choose a random available port by default and
  shall permit an explicit port override. *Verify: automated test —
  `tests/integration/commands/ui.test.ts`.*
- **FR-U04 — Per-run request token.** Each `crew ui` run shall generate a new secret token and
  require it on every HTTP request. *Verify: automated test —
  `tests/integration/ui-server.test.ts` (every-request token),
  `tests/integration/commands/ui.test.ts` (per-run token only inside the URL).*
- **FR-U05 — Interrupt shutdown.** Ctrl-C shall shut down the Console server. *Verify:
  automated test — `tests/integration/commands/ui.test.ts`.*
- **FR-U06 — Optional Console.** Every other crew feature shall function without `crew ui` and
  shall never require it to be running. *Verify: automated test — existing command suites run
  without a Console.*
- **FR-U07 — No background Console.** `crew ui` shall never detach or continue as a background
  server. *Verify: automated test — `tests/integration/commands/ui.test.ts`,
  `tests/integration/commands/ui-cli.test.ts`.*
- **FR-U08 — Bundled offline assets.** The Console shall serve browser files bundled into the
  package at build time and shall remain fully operable with no network access. As a purely
  cosmetic extra, the page may request two web fonts (Space Grotesk, IBM Plex Mono) from a
  public CDN; the stylesheet declares a system-font fallback, so when the CDN is unreachable
  the Console renders and operates identically, only in the operator's platform default
  typefaces. No functional file (the dashboard bundle, the JSON/SSE API surface) is ever
  fetched from a remote server. *Verify: automated test —
  `tests/integration/build-web.test.ts` (esbuild bundles `web/` into `dist/ui-assets/`),
  `tests/integration/ui-server-assets.test.ts` (the bundle is served from disk at `GET /`,
  token-required and traversal-safe, with no network fetch of functional assets).*
- **FR-U09 — Console start record.** Successful startup in machine mode shall emit an additive
  `ui_started` record with `schema_version: 1`, `url`, `port`, and `workspace`. *Verify:
  automated test — `tests/unit/format-ui-started.test.ts`,
  `tests/integration/commands/ui.test.ts`.*
- **FR-U10 — Existing error vocabulary.** Console failures shall use the existing `ErrorCode`
  vocabulary. *Verify: automated test — `tests/integration/commands/ui.test.ts`,
  `tests/integration/ui-server.test.ts` (including a request target Node accepts but WHATWG
  `new URL` rejects answered with a `USAGE` 400 envelope, never a destroyed socket).*
- **FR-U11 — Store domain boundary.** Every Console State Store read and write shall use an
  existing Store domain method. *Verify: inspection and automated test — the typed
  read-only Store surface proven by `tests/unit/ui-snapshot.test.ts` and
  `tests/integration/ui-server.test.ts`.*
- **FR-U12 — Non-consuming dashboard reads.** Dashboard pending-summary, history, and Task-view
  reads shall never call `receive` or otherwise consume Inbox rows. *Verify: automated test —
  `tests/unit/ui-snapshot.test.ts`, `tests/integration/ui-server.test.ts`.*
- **FR-U13 — Operator Agent representation.** The human Operator shall be represented as a
  first-class plain Agent row with platform `NULL`, without a schema change or privileged row
  type. *Verify: automated test — `tests/integration/ui-server-actions.test.ts`.*
- **FR-U14 — Operator send authority.** The Operator shall send Messages only under the ordinary
  active-Agent rules. *Verify: automated test — `tests/integration/ui-server-actions.test.ts`,
  `e2e/ui/actions.spec.ts`.*
- **FR-U15 — Operator Task creation.** The Operator shall be able to create a Task with any
  reviewer, subject to the ordinary Task-creation preconditions. *Note: the server route
  (`POST /api/tasks`) is implemented and verified, but the browser Console does not yet surface
  a create-Task form — the Console create surface is deferred. Verify: automated
  test — `tests/integration/ui-server-actions.test.ts`.*
- **FR-U16 — Operator approval authority.** The Operator shall approve a Submission only when
  it is that Task's reviewer. *Verify: automated test —
  `tests/integration/ui-server-actions.test.ts`, `web/components/tasks-view.test.tsx`.*
- **FR-U17 — Operator requeue authority.** The Operator shall send a Task back to the queue only
  when it is that Task's creator or reviewer. *Verify: automated test —
  `tests/integration/ui-server-actions.test.ts`, `web/components/tasks-view.test.tsx`.*
- **FR-U18 — Existing action invariants.** Every Console action shall invoke the corresponding
  existing command or domain operation and preserve its authority and invariants. *Verify:
  automated test — `tests/integration/ui-server-actions.test.ts` (same Store domain operations
  as the CLI; non-consumption re-proven after every POST).*
- **FR-U19 — Console action scope.** The Console action surface shall be limited to sending a
  Message, creating a Task, approving or sending back a Submission, launching a Team, stopping
  a Team, peeking at a pane, running `prune` or `clean`, and archiving or restoring an Agent
  (FR-U36). *Verify: inspection — Console route inventory in
  `src/ui/server.ts`/`src/ui/actions.ts`, unknown routes and methods rejected in
  `tests/integration/ui-server-actions.test.ts`, `tests/integration/ui-server-team.test.ts`.*
- **FR-U20 — Detached browser launch.** A Team launch from the Console shall be detached, and
  attaching to its session shall remain a terminal-only action. *Verify: automated test —
  `tests/integration/ui-server-team.test.ts`,
  `tests/integration/commands/team-launch-live.test.ts` (no-attach seam, zero attach calls).*
- **FR-U21 — Browser change notifications.** The Console shall notify the browser of changes
  with server-sent events (SSE) and shall re-synchronize state on initial connection and after
  reconnect. *Verify: automated test — `tests/integration/ui-server.test.ts` (including connection
  baseline and reconnect sync).*
- **FR-U22 — Monotonic Store polling.** The Console server shall detect changes by polling the
  State Store on monotonic-id cursors (ids that only ever increase, so the server can simply
  ask "anything newer than the last id I saw?"). *Verify: automated test —
  `tests/store/change-signature.test.ts` (including the `agentMutationCursor` cases
  and the schema-v7 `observableMutationCursor` prune-deletion case:
  a launch-teardown reap's row DELETE and a same-clock-second `last_seen` re-stamp each move
  the signature), `tests/integration/ui-server.test.ts`.*
- **FR-U23 — Retention-aware history.** The Console shall permit history gaps after `prune` and
  shall never claim that retained history is gap-free. *Verify: automated test —
  `web/components/messages-view.test.tsx` (message history rendering and the visible "history
  can have gaps" disclosure, restored after the redesign dropped it).*
- **FR-U24 — Sanitized pane peek.** Pane peek shall return tmux `capture-pane` text with
  terminal control bytes stripped, and only after the pane-map launch marker matches the live
  tmux session, targeting the recorded participant or Relay pane id. *Verify: automated test —
  `tests/integration/ui-server-team.test.ts`
  (control bytes stripped on the JSON surface — the deliberate FR-U24 exception to raw-bytes JSON),
  `tests/unit/launcher/tmux.test.ts` (capturePane argv).*
- **FR-U25 — Destructive-action confirmation.** The Console shall require an explicit
  confirmation before invoking `team stop`, `prune`, `clean`, or archiving an Agent (FR-U36): the
  browser shall present a modal that names the irreversible or hard-to-reverse effect, and the
  request shall carry a `confirm: true` flag the server verifies (absent or non-`true` is a USAGE
  failure). A bare, unconfirmed POST shall never run a destructive action. Restoring an archived
  Agent is deliberately NOT gated by this requirement — it is the reversible corrective action,
  offered with no prompt. *Verify: automated test —
  `tests/integration/ui-server-team.test.ts` (missing/non-true confirm rejected; team stop gated
  too), `web/components/confirm-dialog.test.tsx` (including the confirm-path focus restore
  falling back to a usable control when the trigger disables),
  `e2e/ui/maintenance.spec.ts`.*
- **FR-U26 — Stop ownership proof.** `crew team stop <session>` shall refuse a session unless a
  crew-written pane-map exists under `.crew/generated/<session>/` and its random launch marker
  matches the live tmux session; it shall never kill a stale-map or foreign session. *Verify:
  automated test — `tests/integration/commands/team-stop.test.ts`,
  `tests/integration/commands/teams.test.ts`, `tests/unit/format.test.ts`.*
- **FR-U27 — Stop through tmux adapter.** An owned-Team stop shall kill the session through the
  tmux adapter. *Verify: automated test — `tests/integration/commands/team-stop.test.ts`,
  `tests/integration/commands/teams.test.ts`, `tests/unit/format.test.ts`.*
- **FR-U28 — Stop archives mapped Agents.** After the owned session is killed, Team stop shall
  archive the Agents recorded by its pane-map. *Verify: automated test —
  `tests/integration/commands/team-stop.test.ts`, `tests/integration/commands/teams.test.ts`,
  `tests/unit/format.test.ts`.*
- **FR-U29 — Team-stop record.** A record-producing Team stop shall emit an additive
  `stop_result` record with `schema_version: 1`, `session_name`, `killed`, and
  `agents_archived`. *Verify: automated test — `tests/integration/commands/team-stop.test.ts`,
  `tests/integration/commands/teams.test.ts`, `tests/unit/format.test.ts`.*
- **FR-U30 — Honest Agent status.** The Console shall describe registered Agents as active and
  shall never describe them as online. *Verify: automated test — `web/components/agents.test.tsx`.*
- **FR-U31 — Honest Task status.** The Console shall not present a Submission as a completed
  Task before reviewer approval. *Verify: automated test — `web/components/tasks-view.test.tsx`
  (submitted shown as its own "In review" column, distinct from Completed).*
- **FR-U32 — Deleted-Workspace recovery.** If the Workspace or its database is deleted while
  the Console is running, the dashboard shall enter a bounded error/recovery state instead of
  crashing or implicitly recreating state. *Verify: automated test —
  `tests/store/index-edge.test.ts` (read-path STALE_STORE on deletion/replacement),
  `tests/integration/ui-server.test.ts` (workspace-missing once / workspace-restored /
  STALE_STORE envelopes / no-implicit-create), `web/components/recovery-banner.test.tsx`,
  `web/app.test.tsx` (recovery cases, including the team controls keeping their honest idle
  labels — disabled, never "Working…" — while recovering).*
- **FR-U33 — Stale-Lease change signal (additive post-v1).** The Console's change
  signature shall move when a Lease crosses its expiry — a transition caused purely by time
  passing, which no database write would otherwise announce — so the SSE poller notifies
  connected browsers of it like any other change. *Verify: automated test —
  `tests/store/change-signature.test.ts`, `tests/integration/ui-server.test.ts`.*
- **FR-U34 — Six-view Console presentation (extended by FR-U37, ADR-0017).** The Console shall
  present crew state through a persistent left navigation rail over six views, and shall render
  stored content only through the framework's default text escaping (never as HTML). The views
  are:
  - **Now** — a single prioritized worklist of everything needing the Operator, in priority
    order (FR-U37).
  - **Overview** — headline counts (active agents, in-progress Tasks, Tasks awaiting the
    Operator's review, health), the live Agent roster, a "needs attention" list (stale Leases,
    idle Agents, the Operator's review queue), and a merged newest-first Task-event feed.
  - **Agents** — one card per Agent with role, honest activity (FR-U30), platform, last-seen,
    current in-progress Task, and content-free inbox depth, plus Message and archive/restore
    actions (FR-U36).
  - **Tasks** — a board of five honest status columns (`queued`, `in_progress`, `submitted`
    shown as "In review" per FR-U31, `completed`, and a real, selectable `abandoned`
    column) beside a detail panel carrying the FR-U16/FR-U17 approve and requeue controls.
  - **Messages** — the newest-window Message history (unread Operator Messages marked) beside a
    compose form (recipient select + body) that sends under FR-U14.
  - **Operations** — Team launch (FR-U20), the live owned-session list with owned-stop
    (FR-U26–U29, FR-U35), pane peek (FR-U24), workspace health, and the `prune`/`clean`
    maintenance actions gated by FR-U25.
  *Verify: automated test — `web/app.test.tsx` (navigation + per-view rendering),
  `web/view-model.test.ts`,
  `web/components/{now-view,overview,agents,tasks-view,messages-view,operations,message-modal}.test.tsx`.*
- **FR-U35 — Owned-session listing.** The Console shall list the crew-owned tmux Team sessions
  that are live now — and only those — reusing the same pane-map ownership proof as `team stop`
  (a validated pane-map whose ownership token matches the live session). A leftover pane-map
  file, a foreign session with the same name, or a malformed map shall be omitted, never
  reported as owned. The
  read shall emit, per session, `session_name`, `pane_count`, `agent_count`, and `started_at`,
  and nothing that a `team stop` caller does not already need. *Verify: automated test —
  `tests/unit/launcher/sessions.test.ts` (stale/foreign-owner/malformed/tmux-absent omitted,
  ordering), `tests/integration/ui-server-team.test.ts` (`GET /api/sessions`: empty, populated,
  tmux-absent).*
- **FR-U36 — Operator Agent archive/restore authority (additive post-v1, ADR-0017).** Extends
  FR-U19's Console action-scope enumeration to also cover archiving or restoring an Agent. The
  Operator may archive an active Agent through the Console exactly as `crew leave <id>` does, or
  restore (resume) an archived Agent exactly as `crew join <id> --resume` does — the same Store
  domain methods, the same authority and invariants (FR-U18), no new authority invented. The
  Console's own operator Agent row shall never be archivable through this route (archiving it
  would silently break every later Console action in the running session, since the operator row
  is only re-established at `crew ui` startup or FR-U32 Store reopen, not per request) —
  attempting it shall fail as a USAGE error, and the Agents view shall not present an Archive
  control on the operator's own card (a visible control that can only ever fail is dishonest
  presentation, the same principle FR-U30/FR-U31 already apply to activity and Task status).
  Archiving requires the FR-U25 one-click confirmation (`{ "confirm": true }`); restoring does
  not. This is deliberately NOT a permanent-delete capability — crew has no Store operation that
  irreversibly removes a single Agent's row and its Message/Task-event history, and adding one
  was judged out of scope for this change (see ADR-0017). *Verify: automated test —
  `tests/integration/ui-server-actions.test.ts`,
  `web/components/agents.test.tsx`.*
- **FR-U37 — Now triage view (additive post-v1, ADR-0017).** The Console shall present a sixth
  view, "Now" (FR-U34), as the first item in the navigation rail: a single prioritized worklist
  aggregating everything needing the Operator's attention — stale-Lease Tasks, the Operator's
  review queue, idle Agents, and the Operator's unread Messages — each item routing to the same
  underlying action already offered elsewhere (select the Task, message the Agent, or open
  Messages). It introduces no new data or authority; when nothing needs attention it shows an
  explicit "All clear" empty state, never a blank pane. *Verify: automated test —
  `web/components/now-view.test.tsx`, `web/view-model.test.ts`, `web/app.test.tsx`.*
- **FR-U38 — Local theme preference (additive post-v1, ADR-0017).** The Console shall let the
  Operator switch between a light and dark presentation from the header, persisted locally (e.g.
  browser storage) across reloads of the same browser; the default is light. The choice affects
  presentation only — no Store data, authority, or action behavior changes with it. *Verify:
  automated test — `web/app.test.tsx`.*

#### W. Worker and review worktrees

- **FR-W01 — Opt-in gate (ADR-0015, promoting FR-X07).** Per-Worker Task worktrees shall
  be enabled only by an explicit `worker_worktrees.enabled: true` in `.crew/config.yaml`; an
  absent file, an absent key, or `enabled: false` shall change no existing behavior, including
  preserving any previously recorded Task worktree triple. *Verify: automated test —
  `tests/unit/config.test.ts`, `tests/store/tasks.test.ts`,
  `tests/integration/commands/tasks.test.ts` (byte-identical output with the feature disabled).*
- **FR-W02 — Strict config loading.** Unknown `.crew/config.yaml` keys and unsafe YAML features
  shall be rejected, matching the existing `launcher.yaml` discipline; `base_ref` shall be a Git
  branch name and reject revision expressions during config loading. *Verify: automated test —
  `tests/unit/config.test.ts`.*
- **FR-W03 — Base ref resolution.** `worker_worktrees.base_ref` shall default to `HEAD`, resolved
  to a concrete branch name at worktree-creation time, and a Task shall never persist the literal
  `HEAD` as its `worktree_base_ref`. *Verify: automated test — `tests/unit/worktree.test.ts`,
  `tests/unit/config.test.ts`.*
- **FR-W04 — Shared-Store pointer redirect.** Workspace discovery from inside a Task's or
  reviewer's worktree shall follow its `workspace-pointer` file back to the real shared Workspace
  only when the pointed-to root independently passes the same real-`.crew/`-directory check as
  ordinary discovery; a missing or invalid pointer target shall fail as `NOT_WORKSPACE`, never
  silently open a disconnected local Store. *Verify: automated test —
  `tests/unit/workspace.test.ts`.*
- **FR-W05 — Task worktree creation.** `crew task start` shall create or reuse the assignee's
  dedicated worktree when the feature is enabled, persist `worktree_path`/`worktree_branch`/
  `worktree_base_ref` on the Task in the same transition, and print the resulting path. *Verify:
  automated test — `tests/store/tasks.test.ts`, `tests/integration/commands/tasks.test.ts`.*
- **FR-W06 — Worktree persists through review.** A Task's worktree fields shall remain unchanged
  across `submit` and `approve`, so they are still present on a `submitted` or `completed` Task.
  *Verify: automated test — `tests/store/tasks.test.ts`, `tests/integration/commands/tasks.test.ts`.*
- **FR-W07 — Dedicated review worktree.** `crew task review` shall get — or create on first
  use — the reviewing Agent's own persistent, reusable review worktree, distinct from any
  Task's own worktree, deriving its name so that the same Agent id always yields the same
  valid Git name. *Verify:
  automated test — `tests/unit/worktree.test.ts`, `tests/store/review-worktrees.test.ts`,
  `tests/integration/commands/tasks.test.ts`.*
- **FR-W08 — Review preconditions.** Only the Task's reviewer shall run `task review`, and only
  on a `submitted` Task with a non-null `worktree_branch`. *Verify: automated test —
  `tests/integration/commands/tasks.test.ts`.*
- **FR-W09 — Review checkout.** `task review` shall check the reviewer's dedicated worktree out
  to the Task's branch and print the resulting path. *Verify: automated test —
  `tests/integration/commands/tasks.test.ts`.*
- **FR-W10 — Best-effort switch-back.** `crew task approve` and `crew task requeue` shall, as a
  side effect, switch the acting reviewer's dedicated worktree back to its resting base branch
  when it is currently checked out to that Task's branch; a failure to do so shall warn on
  stderr only and never fail the approve or requeue itself. *Verify: automated test —
  `tests/integration/commands/tasks.test.ts`.*
- **FR-W11 — Land preconditions.** Only an active Task creator or reviewer shall run `crew task
  land`, and only on a `completed` Task with a non-null `worktree_path`; a rejected actor shall
  cause no on-disk cleanup. *Verify: automated test — `tests/integration/commands/tasks.test.ts`.*
- **FR-W12 — Unlanded safety check.** `task land` shall refuse, making no changes, when the
  worktree has uncommitted changes or its branch is not yet an ancestor of its base ref, unless
  `--force` is given. *Verify: automated test — `tests/unit/worktree.test.ts`,
  `tests/integration/commands/tasks.test.ts`.*
- **FR-W13 — Force overrides only crew's check.** `--force` shall override only crew's own
  unlanded-changes heuristic; the underlying branch removal shall remain git's own safe delete,
  which independently refuses an unmerged branch. *Verify: automated test —
  `tests/unit/worktree.test.ts`, `tests/integration/commands/tasks.test.ts`.*
- **FR-W14 — Land effect.** On success, `task land` shall remove the worktree and its branch,
  clear the Task's worktree fields, and send the ADR-0014 Sign-off to the assignee in the same
  step, as a structured `clear_safe` Message (ADR-0016). *Verify: automated test —
  `tests/store/tasks.test.ts`, `tests/integration/commands/tasks.test.ts`.*
- **FR-W15 — Abandon worktree cleanup.** `task abandon` shall unconditionally clear the Task's
  worktree fields in the same DB transition regardless of on-disk outcome, then best-effort
  remove the worktree on disk, warning on stderr on failure without blocking the abandon.
  *Verify: automated test — `tests/store/tasks.test.ts`, `tests/integration/commands/tasks.test.ts`.*

### 3.3 Usability requirements (§9.5.12)

Usability is largely enforced by functions in §3.2 (dual output FR-J01, sanitization FR-J08–J10,
visible stale Leases FR-E20, ambiguity warnings FR-B03). The following add measurable criteria
for how usable crew is in practice.

- **NFR-USE-01 — Onboarding time.** A new user shall be able to initialize, join two
  Agents, send and receive a Message, and complete a reviewed Task in under ten minutes from the
  README. Source: [product-spec Success criteria](./product-spec.md#success-criteria).
  *Verify: demonstration — package e2e / README walkthrough (release gate).*
- **NFR-USE-02 — Actionable failures.** Every operational failure shall be reported with a
  stable machine code and a human-readable, control-sanitized message. Enforced by FR-J06,
  FR-J07, FR-J08. *Verify: automated test — `tests/unit/errors.test.ts`, `tests/unit/format.test.ts`.*

### 3.4 Performance requirements (§9.5.13)

- **NFR-PERF-01 — Interactive latency.** v1 commits to **no** response-time threshold. A core
  command runs against a local SQLite database with no network and no model-provider call, so
  most of each command's cost is Node/CLI process startup — which crew does not control — and
  promising a specific millisecond figure would create a pass/fail gate that varies from
  machine to machine, for little user value. A latency budget may be introduced post-v1 if one
  becomes necessary; see
  [Appendix A](#appendix-a--assumptions-dependencies-and-tbd-items).
  *Verify: analysis — latency deliberately unconstrained for v1.*
- **NFR-PERF-02 — Capacity bounds.** Static capacity limits (Message content 1–100,000 Unicode
  code points; receive batch ≤ 500) are enforced by FR-D04 and FR-D10. *Verify: automated
  test — `tests/store/messages.test.ts`.*
- **NFR-PERF-03 — Bounded redaction.** Secret redaction shall complete in time linear in input
  length and shall not become a denial-of-service vector (hostile input must not be able to
  make redaction hang); enforced by FR-J14. *Verify: automated test —
  `tests/unit/format.test.ts` (linear-time ReDoS regression).*

### 3.5 Logical database requirements (§9.5.14)

The one local State Store (`.crew/state/crew.db`) holds Agents, Messages, Tasks, Leases,
Submissions, Reviews, Task Events, and notifications. What is stored, how it is accessed, how
the entities relate, what integrity rules apply, and how long data is kept are all defined by
[data-model.md](./data-model.md) and enforced by the group-I functions: single owner (FR-I01),
locality (FR-I02, FR-I03), hardened open (FR-I04, FR-I05), versioning/migration
(FR-I06–FR-I08), STRICT constraints and indexes (FR-I09), contention handling (FR-I10, FR-I11),
transaction ordering (FR-I12), a single operation clock (FR-I13), and crash integrity (FR-I14).
Retention and deletion are governed by FR-K02–FR-K04. This section points to those
requirements rather than restating them.

### 3.6 Design constraints (§9.5.15)

- **NFR-CON-01 — Node floor and sole SQLite engine.** crew shall require Node `>=24.15`
  and shall use the built-in `node:sqlite` module as its only SQLite engine, with no third-party
  SQLite dependency. Enforced/related: FR-A09, FR-I01. *Verify: automated test —
  `tests/unit/node-floor.test.ts`, `tests/unit/sqlite-ownership.test.ts`.*
- **NFR-CON-02 — Daemonless.** crew shall require no daemon (background process), no required
  or background server, no cloud account, and no remote database; the optional Console —
  started explicitly, running in the foreground, reachable only from the local machine — is
  permitted. Enforced by FR-A02, FR-A03, FR-U01, FR-U06, and FR-U07; see
  ADR-0012 and [product-spec Non-goals](./product-spec.md#non-goals). *Verify: inspection —
  ADR-0012; product-spec.*
- **NFR-CON-03 — No inference.** crew shall never contact a model provider. Enforced by FR-A06.
  *Verify: analysis — no network/model dependency.*
- **NFR-CON-04 — ESM/NodeNext module system.** Source shall be ESM under `NodeNext`
  resolution, importing local files with the `.js` specifier. *Verify: automated — `npm run
  typecheck` / `npm run build`.*
- **NFR-CON-05 — Immutability.** Modules shall return new objects and shall never mutate
  their inputs. *Verify: inspection — code review; `npm run lint`.*

### 3.7 System attributes (§9.5.17)

Attribute-level statements. Where an FR already enforces the attribute, the NFR references it
rather than restating the obligation.

#### Reliability and availability (§9.5.17 a, b)

- **NFR-REL-01 — No silent loss under contention.** Under forced multi-process contention
  (many processes writing to the database at once), no committed Message or Task transition
  shall be silently dropped, and contention failures shall be explicit and machine-readable.
  Enforced by FR-I10, FR-I11, FR-D13. *Verify: automated
  test — `tests/spawn/messages.test.ts`, `tests/spawn/tasks.test.ts`; SQLite-stress release gate.*
- **NFR-REL-02 — Crash recoverability.** After abrupt termination the State Store shall reopen
  passing integrity checks. Enforced by FR-I14. *Verify: automated test — `tests/spawn/tasks.test.ts`.*
- **NFR-REL-03 — Honest delivery.** Receive is at-most-once with a documented crash-after-commit
  loss window; history retains every row. Enforced by FR-D14, FR-D15. *Verify: inspection —
  cli-contract.md; automated test — `tests/store/messages.test.ts`.*

#### Security (§9.5.17 c)

- **NFR-SEC-01 — Single-trust-domain model.** v1 shall assume that everything runs under one
  operating-system user account whose processes all trust each other, and shall perform no
  identity or permission checks between Agents. Enforced/related: FR-C16, FR-C17, FR-K08.
  *Verify: inspection — security.md Trust statement.*
- **NFR-SEC-02 — Untrusted input treated as data.** Cross-Agent and repository-sourced text
  shall be treated as data, never executed or auto-trusted. Enforced by FR-F06, FR-F07, FR-H16,
  FR-H18, FR-J08. *Verify: automated test — security suite (`[security]`-labelled tests).*
- **NFR-SEC-03 — No secret leakage.** No credential environment value or launch token shall
  reach command output, and redaction shall not stall. Enforced by FR-J12–FR-J15, FR-H28.
  *Verify: automated test — `tests/integration/commands/security-redaction.test.ts`,
  `tests/unit/format.test.ts`.*
- **NFR-SEC-04 — Containment and safe spawn.** Files crew manages shall stay within Workspace
  roots (checked again at the moment of writing, and applied to project-scope setup artifacts),
  and every child process shall be started with an argument array and `shell:false`, with
  probe executables run at the exact absolute `PATH` location the presence check found.
  Enforced by FR-B14, FR-B15,
  FR-H07–FR-H12. *Verify: automated test — `tests/unit/fs-safe.test.ts`,
  `tests/unit/setup-fs.test.ts`, `tests/unit/which.test.ts`,
  `tests/integration/commands/setup.test.ts`, `tests/unit/launcher/tmux.test.ts`.*

#### Maintainability (§9.5.17 d)

- **NFR-MNT-01 — Coverage ≥ 95%.** The test suite shall maintain at least 95% coverage on
  statements, branches, functions, and lines over `src/**` and `bin/**`. *Verify: automated —
  `npm run test:coverage`.*
- **NFR-MNT-02 — Strict-typed, linted, formatted.** The codebase shall compile under
  maximally strict TypeScript and pass lint and format checks. *Verify: automated — `npm run
  typecheck`, `npm run lint`, `npm run format:check`.*
- **NFR-MNT-03 — Module boundaries.** SQL/`node:sqlite` shall be confined to the Store Module and
  command handlers shall stay thin. Enforced by FR-I01; see CLAUDE.md Module boundaries.
  *Verify: automated test — `tests/unit/sqlite-ownership.test.ts`.*

#### Portability (§9.5.17 e)

- **NFR-POR-01 — Supported platforms.** crew shall run on macOS and Linux with Node `>=24.15`.
  Enforced by FR-A09, FR-A10. *Verify: analysis — CI matrix.*
- **NFR-POR-02 — Local filesystem only.** The State Store shall be supported only on local
  filesystems. Enforced by FR-I03. *Verify: inspection — security.md; data-model.md.*
- **NFR-POR-03 — Windows launch out of scope.** Windows tmux launch and Relay are
  out of scope for v1; core data operations remain platform-neutral (FR-A10) and launch is an
  optional Unix/tmux adjunct (FR-H01). *Verify: inspection — product-spec Non-goals.*

### 3.8 Supporting information (§9.5.19)

The appendices below are part of this SRS. Sample input/output formats live in
[cli-contract.md](./cli-contract.md); the problem statement and background live in
[product-spec.md](./product-spec.md). The proofs each requirement area must carry follow
from the per-requirement **Verify:** lines and [testing-strategy.md](./testing-strategy.md);
release status is intentionally not repeated here.

---

## 4 Verification (§9.5.18)

Every requirement in §3.2–§3.7 carries its own **Verify:** line naming one of *automated
test*, *inspection*, *analysis*, or *demonstration*, matching the requirement categories
(§9.5.18). The overall verification approach — behavior tests, race tests, packaging tests,
and integration tests — is defined by [testing-strategy.md](./testing-strategy.md); the
release gates are in the product-spec
[release-gate table](./product-spec.md#release-gates). The automated gate is
`npm run typecheck && npm run lint && npm run format:check && npm run build && npm test`, with a
`test:coverage` threshold of 95% on statements, branches, functions, and lines.

---

## 5 Appendices

### Appendix A — Assumptions, dependencies, and TBD items (§9.5.7)

**Assumptions.**

1. All participants run under one operating-system user account whose processes trust each
   other (the basis for NFR-SEC-01). If this changes, authentication requirements would be
   needed (the territory of FR-X02).
2. A POSIX shell, `tmux`, and `git` are available for launched mode; `tmux` is also available
   for Team stop and pane peek. Their absence does not fail core operations (FR-H01, FR-H02,
   FR-U24, FR-U26).
3. The `node:sqlite` module remains available and stable at Node `>=24.15` (basis for
   NFR-CON-01); a change would affect FR-I01–FR-I14.
4. The eight Participant CLIs' canonical paths and permission syntaxes are as recorded in the
   registry at the verification date (FR-G12, FR-G13); setup facts are re-verified per release.

**Dependencies.** Node `>=24.15`; `node:sqlite`; `tmux` (launch, Team stop, and pane peek);
`git` (worktree launch); Participant CLIs (Claude Code, Codex CLI, Gemini CLI, Copilot CLI,
Antigravity CLI, Pi CLI, Little Coder, opencode CLI); optional Model Backends (Ollama,
LM Studio).

**Open TBD items.**

- None. **NFR-PERF-01** (interactive latency) is resolved for v1: crew commits to **no**
  latency threshold. A core command runs against a local SQLite database with no network or
  model-provider call, so most of each command's cost is Node/CLI process startup, which crew
  does not control; a budget may be introduced post-v1 if one becomes necessary.

No requirement carries a TBD; all documented figures (15-minute Lease, receive default
50 / maximum 500, content 1–100,000 code points, 5-second busy timeout, suffixes `-2`…`-99`,
20-plus-character redaction run, `synchronous=NORMAL`) are taken from the source contracts.

### Appendix B — Acronyms and abbreviations (§9.2.5)

| Term | Meaning |
|---|---|
| CAS | Compare-and-set (conditional update on expected status/revision) |
| CLI | Command-line interface |
| HTTP | Hypertext Transfer Protocol |
| NDJSON | Newline-delimited JSON |
| SSE | Server-sent events |
| SRS | Software Requirements Specification |
| WAL | Write-Ahead Logging (SQLite journal mode) |
| FK | Foreign key |
| TBD | To be determined |
| NFR | Non-functional requirement |
| FR | Functional requirement |
| ISO/IEC/IEEE | Standards bodies (guidance edition 29148:2011) |

Domain nouns (Crew, Agent, Task, Lease, Submission, Review, Message, Relay, …) are defined in
[CONTEXT.md](../../CONTEXT.md).

### Appendix C — Old→new requirement crosswalk

Every retired id from the earlier requirement numbering maps to one or more single-rule
ids here. A "split" means one old id became several new ids (§5.2.5 *Singular*). Deferred
`FR-X*` ids are unchanged (see
[Appendix D](#appendix-d--future--out-of-scope-requirements)). This table is the authoritative
record of the renumbering; if you search for where a retired id went, this is the only place
that says so.

| Old id | New id(s) | Split? |
|---|---|---|
| FR-A01 | FR-A01 | — |
| FR-A02 | FR-A02, FR-A03 | split |
| FR-A03 | FR-A04, FR-A05 | split |
| FR-A04 | FR-A06 | — |
| FR-A05 | FR-A07, FR-A08 | split |
| FR-A06 | FR-A09, FR-A10 | split |
| FR-A07 | FR-A11, FR-A12 | split |
| FR-B01 | FR-B01 | — |
| FR-B02 | FR-B02, FR-B03 | split |
| FR-B03 | FR-B04, FR-B05, FR-B06 | split |
| FR-B04 | FR-B07 | — |
| FR-B05 | FR-B08, FR-B09, FR-B10 | split |
| FR-B06 | FR-B11, FR-B12 | split |
| FR-B07 | FR-B13 | — |
| FR-B08 | FR-B14, FR-B15 | split |
| FR-C01 | FR-C01 | — |
| FR-C02 | FR-C02, FR-C03 | split |
| FR-C03 | FR-C04 | — |
| FR-C04 | FR-C05, FR-C06 | split |
| FR-C05 | FR-C07, FR-C08 | split |
| FR-C06 | FR-C09, FR-C10 | split |
| FR-C07 | FR-C11, FR-C12, FR-C13 | split |
| FR-C08 | FR-C14, FR-C15 | split |
| FR-C09 | FR-C16, FR-C17 | split |
| FR-D01 | FR-D01 | — |
| FR-D02 | FR-D02, FR-D03, FR-D04 | split |
| FR-D03 | FR-D05, FR-D06, FR-D07 | split |
| FR-D04 | FR-D08, FR-D09 | split |
| FR-D05 | FR-D10, FR-D11, FR-D12 | split |
| FR-D06 | FR-D13 | — |
| FR-D07 | FR-D14, FR-D15 | split |
| FR-D08 | FR-D16, FR-D17, FR-D18 | split |
| FR-D09 | FR-D19, FR-D20, FR-D21 | split |
| FR-D10 | FR-D22, FR-D23, FR-D24 | split |
| FR-E01 | FR-E01, FR-E02 | split |
| FR-E02 | FR-E03, FR-E04 | split |
| FR-E03 | FR-E05, FR-E06 | split |
| FR-E04 | FR-E07, FR-E08 | split |
| FR-E05 | FR-E09, FR-E10 | split |
| FR-E06 | FR-E11, FR-E12 | split |
| FR-E07 | FR-E13, FR-E14 | split |
| FR-E08 | FR-E15, FR-E16, FR-E17 | split |
| FR-E09 | FR-E18 | — |
| FR-E10 | FR-E19, FR-E20 | split |
| FR-E11 | FR-E21 | — |
| FR-F01 | FR-F01 | — |
| FR-F02 | FR-F02, FR-F03 | split |
| FR-F03 | FR-F04, FR-F05 | split |
| FR-F04 | FR-F06, FR-F07 | split |
| FR-F05 | FR-F08, FR-F09 | split |
| FR-F06 | FR-F10 | — |
| FR-F07 | FR-F11, FR-F12 | split |
| FR-F08 | FR-F13, FR-F14 | split |
| FR-G01 | FR-G01 | — |
| FR-G02 | FR-G02, FR-G03 | split |
| FR-G03 | FR-G04 | — |
| FR-G04 | FR-G05, FR-G06 | split |
| FR-G05 | FR-G07 | — |
| FR-G06 | FR-G08, FR-G09 | split |
| FR-G07 | FR-G10, FR-G11 | split |
| FR-G08 | FR-G12, FR-G13 | split |
| FR-H01 | FR-H01, FR-H02 | split |
| FR-H02 | FR-H03 | — |
| FR-H03 | FR-H04 | — |
| FR-H04 | FR-H05, FR-H06 | split |
| FR-H05 | FR-H07, FR-H08 | split |
| FR-H06 | FR-H09, FR-H10 | split |
| FR-H07 | FR-H11, FR-H12 | split |
| FR-H08 | FR-H13, FR-H14 | split |
| FR-H09 | FR-H15, FR-H16 | split |
| FR-H10 | FR-H17, FR-H18 | split |
| FR-H11 | FR-H19, FR-H20 | split |
| FR-H12 | FR-H21, FR-H22 | split |
| FR-H13 | FR-H23, FR-H24, FR-H25, FR-H26, FR-H27, FR-H28 | split |
| FR-I01 | FR-I01 | — |
| FR-I02 | FR-I02, FR-I03 | split |
| FR-I03 | FR-I04, FR-I05 | split |
| FR-I04 | FR-I06, FR-I07, FR-I08 | split |
| FR-I05 | FR-I09 | — |
| FR-I06 | FR-I10, FR-I11 | split |
| FR-I07 | FR-I12 | — |
| FR-I08 | FR-I13 | — |
| FR-I09 | FR-I14 | — |
| FR-J01 | FR-J01 | — |
| FR-J02 | FR-J02, FR-J03 | split |
| FR-J03 | FR-J04 | — |
| FR-J04 | FR-J05 | — |
| FR-J05 | FR-J06, FR-J07 | split |
| FR-J06 | FR-J08, FR-J09, FR-J10 | split |
| FR-J07 | FR-J11 | — |
| FR-J08 | FR-J12, FR-J13, FR-J14, FR-J15 | split |
| FR-K01 | FR-K01 | — |
| FR-K02 | FR-K02, FR-K03, FR-K04 | split |
| FR-K03 | FR-K05 | — |
| FR-K04 | FR-K06, FR-K07 | split |
| FR-K05 | FR-K08 | — |
| FR-K06 | FR-K09 | — |
| FR-K07 | FR-K10 | — |

Counts: **98** old v1 ids → **183** new v1 single-rule ids; **66** old ids were split. The
additive post-v1 ids `FR-U01`–`FR-U38`, `FR-E22`–`FR-E24`, `FR-H29`, and `FR-W01`–`FR-W15` did
not exist in the retired v1 set and are intentionally excluded from those counts. Deferred
`FR-X01`–`FR-X08` are unchanged, except `FR-X07`, which is promoted to the group W contract
(`FR-W01`–`FR-W15`, ADR-0015); see Appendix D.

### Appendix D — Future / out-of-scope requirements

These are **deferred** and **not part of v1**. They are kept for planning only; promoting one
into scope requires a documentation and plan update (see
[product-spec Non-goals](./product-spec.md#non-goals) and [decisions.md](./decisions.md)). Ids
are unchanged from the former specification.

- **FR-X01 — Claim/ack Messages.** Add delivery claims, expiry, and consumer acknowledgement for
  at-least-once behavior if field evidence demands it.
- **FR-X02 — Session displacement.** Bind an Agent session token to one terminal to detect reuse;
  this remains displacement detection, not authorization.
- **FR-X03 — Task dependencies.** Add dependency edges and ready/phased queries.
- **FR-X04 — Memory and brief.** Add durable Agent memory and a no-inference briefing assembler.
- **FR-X05 — Human approval.** Add durable approval requests with a distinct pending exit status.
- **FR-X06 — Heterogeneous launch.** Launch multiple Participant CLI types in one session.
- **FR-X07 — Per-Agent worktrees.** Share one State Store while assigning distinct worktrees.
  *Note: promoted — built as the opt-in group W contract (FR-W01–FR-W15, §3.2) under
  ADR-0015. This id is retained here only as the historical source citation; it is no longer
  deferred or unscheduled.*
- **FR-X08 — Cleanup setup artifacts.** Remove generated Participant CLI artifacts by marker.

### Appendix E — Quality-grading matrix

Each in-scope requirement is graded against **all nine** individual-requirement characteristics of
ISO/IEC/IEEE 29148:2011 **§5.2.5**: **N** Necessary, **IF** Implementation free, **U**
Unambiguous, **C** Consistent, **Cm** Complete, **S** Singular, **F** Feasible, **T** Traceable,
**V** Verifiable. Cell values: **P** = Pass, **NE** = Needs evidence, **F** = Fail. (The
§5.2.5 names are used verbatim; "Correct" and "Conforming" are deliberately **not** used.)

**Convention.** To keep the full matrix readable, each section has one default row saying that
every requirement in that section grades **P** on all nine characteristics, followed by
explicit override rows for any requirement with a non-P cell. A requirement's grade is its
override row if it has one, otherwise its section default. Every v1 and additive post-v1
requirement is therefore graded.

#### Section defaults (all nine = P unless overridden below)

| Section | Requirements | Default grade |
|---|---|---|
| A | FR-A01–FR-A12 | all nine P |
| B | FR-B01–FR-B15 | all nine P |
| C | FR-C01–FR-C17 | all nine P |
| D | FR-D01–FR-D24 | all nine P (except FR-D23) |
| E | FR-E01–FR-E24 | all nine P |
| F | FR-F01–FR-F14 | all nine P (except FR-F01) |
| G | FR-G01–FR-G13 | all nine P (except FR-G07) |
| H | FR-H01–FR-H29 | all nine P (except FR-H11) |
| I | FR-I01–FR-I14 | all nine P (except FR-I04, FR-I05, FR-I09) |
| J | FR-J01–FR-J15 | all nine P |
| K | FR-K01–FR-K10 | all nine P (except FR-K01) |
| U | FR-U01–FR-U38 | all nine P |
| W | FR-W01–FR-W15 | all nine P |
| NFR | all NFR-\* | all nine P |

#### Override rows (non-P cells)

| Id | N | IF | U | C | Cm | S | F | T | V | Note |
|---|---|---|---|---|---|---|---|---|---|---|
| FR-D23 | P | P | P | P | P | NE | P | P | P | Bundles deduplication + omit-the-actor + skip-archived; could split into three. |
| FR-F01 | P | P | P | P | P | NE | P | P | P | Packages three Role prompts; could split per Role. |
| FR-G07 | P | P | P | P | P | NE | P | P | P | Lists eight per-platform invocations; could split per platform. |
| FR-H11 | P | NE | P | P | P | P | P | P | P | Names the paste-buffer mechanism; state as outcome, cite architecture/ADR-0007 as the constraint. |
| FR-I04 | P | NE | P | P | P | P | P | P | P | Specifies pragmas; justified by data-model but not solution-neutral. |
| FR-I05 | P | NE | P | P | P | P | P | P | P | Specifies WAL/`synchronous`/timeout values; justified by data-model. |
| FR-I09 | P | P | P | P | P | NE | P | P | P | Bundles STRICT + constraint kinds + indexes; could split. |
| FR-K01 | P | P | P | P | P | NE | P | P | P | Enumerates nine diagnostics; could split per diagnostic. |

All other in-scope requirements grade **P** on all nine per their section default. Deferred
`FR-X*` requirements are out of scope and are not graded here.

#### Set-level assessment (§5.2.6)

| Set characteristic | Status | Evidence and rationale |
|---|---|---|
| Complete | Needs evidence | The set covers the declared v1 and additive post-v1 scope (product-spec capability list) with no open TBx (NFR-PERF-01 is resolved as a deliberate non-constraint); completeness against unstated domain needs cannot be proven from the supplied material. |
| Consistent | Pass | Terminology is stabilized by CONTEXT.md; no contradictions found. Two intentional cross-references exist and are **not** accidental duplicates: FR-H28 states FR-J15 from the launcher side, and FR-C13 is the activity-label-scoped case of the global FR-K09. |
| Affordable | Needs evidence | No life-cycle cost/effort evidence is in scope; the v1 implementation exists and the additive post-v1 work is planned, but affordability is not established by this text. |
| Bounded | Pass | The set stays within the declared v1 and additive post-v1 solution scope; deferred items are fenced off in Appendix D. |

#### Flagged requirements — one-line fixes

- **FR-D23** (S): split into deduplicate-targets / omit-actor / skip-archived if finer-grained
  rules are wanted; currently one "compute the recipient set" rule.
- **FR-F01** (S): optionally split into FR for each of the Manager, Worker, and Inspector prompts.
- **FR-G07** (S): optionally split into one requirement per Participant invocation.
- **FR-H11** (IF): restate as the required outcome (registry-sourced, non-interpolating
  injection) and cite ADR-0007/architecture as the mechanism constraint.
- **FR-I04 / FR-I05** (IF): restate as the required integrity/durability outcome and cite
  data-model.md as the source of the specific pragma values.
- **FR-I09** (S): split STRICT-tables / constraint-kinds / indexes if per-rule tests are wanted.
- **FR-K01** (S): split the nine `doctor` diagnostics into individual requirements if desired.
- **NFR-PERF-01** (Cm, U, V): **resolved** — latency is declared out of contract for v1 (a
  deliberate non-constraint with rationale), rather than committing a measurable figure.
