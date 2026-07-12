# crew Architecture

> This document describes how crew is built for v1. What the product must do is defined
> in the [software requirements specification](./srs.md); how data is stored is
> defined in the [data model](./data-model.md). Structural choices that have been
> accepted are recorded as [ADRs](../adr/).

## 1. System shape

crew is a tool that runs on your own machine and helps terminal coding agents — AI
assistants that each run in their own terminal session — coordinate their work. The
`crew` executable never calls an AI model provider itself. Every core command does a
fixed amount of work and then stops: it finds the Workspace (the nearest directory
containing a `.crew/` folder), opens that Workspace's State Store (the shared SQLite
database that holds all coordination data), does its job, prints the result, closes the
database, and exits.

There are two operating modes:

- **Manual mode:** the Operator — the human running crew — starts each Participant CLI
  (an AI terminal application that takes part by running crew commands) and prompts it
  by hand. Between commands, no crew process keeps running.
- **Launched mode:** the Launcher — a setup step that runs once, builds a tmux session
  (a terminal split into several panes), and exits — creates the session. An optional
  Relay may keep running in its own tmux window for as long as that session lives. It
  nudges an idle participant pane when the pane's Inbox (its unread Messages) changes,
  or when a Task that pane created has a stale Lease — a time-limited claim on the Task
  that expired without the work finishing. The Relay is optional and stops when
  the session ends; crew never requires a background process that runs on its own.

The core commands leave nothing running in the background. Hands-off wake-up in launched
mode, however, does need one process that stays alive for as long as the tmux session
does. So: crew has no required always-on background process, but automatic wake-up in
launched mode is not completely process-free.

## 2. Architectural principles

- **One-shot core.** Every core command runs, does a bounded amount of work, and exits —
  nothing stays running, and any command can safely be run again on its own.
- **One local source of truth.** All shared state that changes lives in one SQLite
  database and nowhere else.
- **Track config, ignore state.** Files people edit together are committed to git; files
  crew generates at runtime are git-ignored. The two never share one ignore rule.
- **Deep domain interfaces.** Callers use meaningful operations such as `submitTask` and
  `receiveMessages`, never raw SQL or generic create/read/update/delete calls.
- **One SQLite owner.** Only the Store Module imports `node:sqlite`.
- **One platform registry.** Setup, doctor, display, and launch all read the same facts
  about each supported AI tool from one shared registry.
- **Explicit semantics.** An active Agent is only a database registration — not proof
  that a live process exists. A Submission (a Worker's finished result) is not a
  completed Task; only an accepting Review completes a Task.
- **Shared trust.** Role prompts guide an Agent's behavior, but they never grant or
  withhold permissions.

## 3. Module map

| Module | Interface and leverage | Implementation locality |
|---|---|---|
| Program | `run(argv, io): Promise<number>` — one consistent entry point for argument parsing, output mode, and errors | builds the commander CLI and maps top-level exceptions to exit codes |
| Workspace | find or initialize the `.crew/` paths and load validated project config | walks up the directory tree, writes files safely, maintains the Git-ignore file, keeps every path inside the workspace |
| Store | named operations for Agents, Messages, Tasks, history, prune, and health | the only module that imports SQLite; owns the schema, migrations, SQL, transactions, and retries |
| Roles | resolve/list/export a Role | packaged templates, with project files taking precedence over them |
| Teams | resolve/list/render a Team | safe YAML parsing, schema validation, and expanding replicas (how many copies of a member to start) |
| Platforms | look up a Setup Target and produce its generated files and start command | canonical paths, executable names, version probes, permission guidance |
| Setup | install or inspect one Setup Target | asks Platforms for platform-specific facts; writes files behind guard checks |
| Launcher | show a launch plan or create a tmux session | resolves worktrees, maps panes, waits for readiness, injects prompts, cleans up |
| Relay | watch unread Message ids and stale Leases, type fixed reminders into panes | a polling loop over a tmux adapter; never sees Message content and never marks anything read |
| Console | serve the optional interactive browser dashboard (five views: Overview, Agents, Tasks, Messages, Operations) and Store snapshots, and perform Operator actions with no authority beyond what the Store already allows | a foreground HTTP/SSE server reachable only from your own computer, plus page assets bundled at build time so it works offline |
| Format | render records for humans or as NDJSON (one complete JSON object per line) | strips terminal control sequences from human output; keeps the JSON envelopes stable |
| Commands | parse one command and call a deeper Module | thin handlers containing no SQL and no hard-coded platform paths |

A seam is a boundary where one part of the program can be swapped out or tested on its
own. crew keeps them deliberately few:

1. `run` is the seam for testing commands.
2. The Store's domain operations are the seam for testing persistence.
3. The platform definitions are the seam for third-party integration.
4. A small process runner is the seam for testing the Launcher: real tmux is one
   implementation and a recording fake is the second, which is what makes this a genuine
   seam. The capture-only half landed early as `Io.runProcess` (async, `shell:false`),
   used by the registry's version probes; the Launcher added its opposite,
   `Io.runInteractive` (inherited stdio, no timeout), for the one process that must own
   the terminal in the foreground — `tmux attach` (ADR-0008).

The Store may have internal files for Agents, Messages, Tasks, migrations, and queries,
but it exposes one domain interface. Wrapping each SQL statement in its own public
function would create many thin Modules and spread the rules that must always hold
across every caller.

### Why these Modules earn their depth

Each substantial Module gathers one concern into one place. Without it, that concern
would have to be handled separately by every caller:

- **Platforms** replaces four separate copies of the same path tables (for setup, launch,
  display, and doctor). Without it, every platform change would have to be repeated in
  every caller, so it earns its place as the one authoritative registry.
- **Store** keeps the rules that must always hold for Task transitions, notifications,
  and events behind one boundary, instead of leaking SQL coordination into command
  handlers.
- **Launcher plan** turns configuration into a plan as a pure step — the same input
  always produces exactly the same plan, and nothing else is touched. That makes it
  testable before the tmux adapter even exists, concentrates the safety checks in one
  place, and makes `--print` genuinely free of side effects.
- **Format** handles output sanitization for humans and JSON envelope compatibility
  once, on behalf of every command.
- **Workspace** owns which files are tracked or ignored and keeps every path inside the
  workspace, so no command has to re-invent filesystem policy on its own.

## 4. Repository and on-disk layout

### 4.1 Source layout

```text
bin/crew.ts                     executable shim -> run()
src/
  run.ts                        Program interface and error mapping
  cli.ts                        command registration
  commands/*.ts                 thin command handlers
  workspace.ts                  discovery, initialization, paths
  store/
    index.ts                    Store interface
    schema.ts                   versioned schema and migrations
    agents.ts                   internal Agent queries
    messages.ts                 internal Message queries
    tasks.ts                    internal Task queries/transitions
    maintenance.ts              doctor/prune/clean queries
  roles.ts
  teams.ts
  platforms/
    registry.ts                 authoritative Setup Target lookup
    shared.ts                   record types, shared workflow, marker/hash, version probe
    claude.ts
    codex.ts
    gemini.ts
    copilot.ts
    ollama.ts
    lmstudio.ts
  setup/
    index.ts                    setup detection/install/recipe flow + records
    fs.ts                       setup-owned guarded writes (home/project, outside .crew/)
  process.ts                    real Io.runProcess (capture-only) + runInteractive (tmux attach)
  which.ts                      PATH executable lookup (doctor + registry)
  relay.ts                      internal `crew relay` Relay loop (tick-driver + reducer wiring)
  launcher/
    index.ts
    config.ts
    plan.ts
    tmux.ts                     semantic TmuxAdapter over the process seams
    session.ts                  live launch orchestration + owned-session teardown
    relay.ts                    pure relayStep throttle reducer
    artifacts.ts                generated-artifact writer (fs-safe)
    sessions.ts                 live owned-session listing (pane-map proof + tmux) for GET /api/sessions
  ui/
    server.ts                   token-guarded loopback HTTP/SSE server + static assets; routes GET /api/snapshot,/api/health,/api/sessions,/api/peek and the action POSTs
    snapshot.ts                 bounded, non-consuming Store snapshot projection
    actions.ts                  Operator action handlers (send/create/approve/requeue, launch/stop, prune/clean, listSessions)
  format.ts
  errors.ts
web/                            Preact + TypeScript dashboard source
  main.tsx                      browser entry point
  view-model.ts                 pure selectors + colour vocabularies (relative time, status/role/activity, review queue, attention, activity feed)
  app.tsx                       sidebar shell + five-view router + toasts + one-click confirm modal
  components/                  the five views + sidebar, toasts, confirm-dialog, health, peek, recovery-banner
  index.html                    build-time page shell (loads two CDN fonts with a system fallback)
templates/
  roles/{manager,worker,inspector}.md
  teams/dev.yaml
tests/{unit,integration,spawn,e2e,fixtures}/
```

### 4.2 Workspace layout

```text
<workspace>/
└── .crew/
    ├── roles/                  tracked Role overrides
    ├── teams/                  tracked Team definitions
    │   └── dev.yaml
    ├── launcher.yaml           optional tracked launch configuration
    ├── run-task.md             optional tracked Task brief
    ├── state/                  ignored mutable state
    │   ├── crew.db
    │   ├── crew.db-wal
    │   └── crew.db-shm
    ├── generated/              ignored launch plans/prompts/maps
    └── .gitignore              ignores state/ and generated/ (relative to .crew/)
```

`init` never git-ignores the whole `.crew/` directory, and it never writes anything into
your home directory. Changing a Participant CLI's global configuration is a separate,
explicit `setup` action.

### 4.3 Workspace discovery

Discovery starts in the current directory and walks up through its parents until it
finds one containing `.crew/`. Every pane in a Crew must arrive at the same root. Be
aware that a `.crew/` directory nested inside another, or changing directory mid-session,
can silently select a different State Store; `crew doctor` prints which root was
resolved.

In v1 no environment variable can override which State Store is used. Tests pass the
current directory in through the Program interface instead of changing the process's
global working directory. A Crew launched inside a git worktree (a separate working copy
of the repository that shares the same history) finds the worktree's own `.crew/` by
this same upward walk — a fresh, short-lived Store local to that worktree. This is
deliberate: it is not an override that points back at the main repository's Store
(ADR-0011).

## 5. State Store and concurrency

The Store opens `.crew/state/crew.db` with Node.js's built-in `DatabaseSync` class,
using a 5-second busy timeout and with foreign keys and defensive mode enabled. On open
it applies:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
```

The Workspace must live on a local disk. WAL is write-ahead logging, an SQLite mode that
lets readers keep working while one writer writes; it needs a shared-memory helper file
that does not work on NFS, SMB, or other network mounts that lack the required file
locking.

This section is a summary of runtime behavior. The binding open parameters, the full
table definitions, and the migration contract are in [data-model.md](./data-model.md),
and the local-disk-only requirement is recorded in
[ADR-0002](../adr/0002-local-sqlite-state-store.md).

### 5.1 Versioning and migration

- SQLite's `PRAGMA user_version` value records the schema version.
- Migrations run inside one exclusive transaction and move the version forward one step
  at a time.
- If the database's schema is newer than the installed crew understands, crew refuses it
  with `UNSUPPORTED_SCHEMA`; it never opens such a database for writing with only a
  warning.
- Whether a column or table exists is checked by asking SQLite's own metadata, never by
  matching error message text.
- Every migration is tested two ways: upgrading from the previous supported version, and
  reopening an already-migrated database to prove the second run changes nothing.

### 5.2 Contention behavior

Short writes use whichever transaction type fits the operation. Task transitions that
need several statements use `BEGIN IMMEDIATE`, which takes the write lock up front — so
if another process is holding the database, crew finds out before it reads any state it
depends on. If SQLite's 5-second timeout expires, crew waits a random 25-100 ms and
retries once. If the retry also fails, the command returns `CONTENTION`. A write is
never reported as successful unless it was actually committed.

### 5.3 Message receive

Receiving Messages claims a limited batch of rows with one write inside a short
`BEGIN IMMEDIATE` transaction; the same transaction also checks that the receiving Agent
exists and updates its last-seen time:

```sql
UPDATE messages
SET read_at = :now
WHERE id IN (
  SELECT id
  FROM messages
  WHERE recipient_id = :agent_id AND read_at IS NULL
  ORDER BY created_at, id
  LIMIT :limit
)
RETURNING *;
```

The rows are sorted again by `(created_at, id)` before printing, because SQLite does not
guarantee the order of `RETURNING` rows. Two Agents receiving at the same time can never
get the same row. The delivery guarantee is at-most-once, not exactly-once: a Message is
delivered once, or — if the process crashes at exactly the wrong moment, after the
commit but before the caller sees the output — not at all; it is never delivered twice.
A Message lost this way can still be found through history queries. The default batch is
50 Messages and the maximum is 500. The claim never reads first and writes later: the
transaction takes its write lock before reading anything it depends on, so what it
checked cannot change underneath it.

### 5.4 Task transitions

Every Task carries a whole-number `revision` counter. A transition is an update whose
conditions check the Task id, the revision, the expected current status, the acting
Agent, and — where relevant — the Lease. The update must change exactly one row; the
same transaction then appends a Task Event (an unchangeable record of what happened and
who did it) and any notification Messages. An update that matched zero rows fails with
`TASK_CONFLICT` — never a vague not-found, and never a false success.

Full tables and constraints are specified in [data-model.md](./data-model.md).

## 6. Domain flows

### 6.1 Agent lifecycle

`join` inserts a new active Agent row. An id held by any Agent — active or archived —
stays reserved; joining with a taken id normally gets a suffix from `-2` through `-99`
instead. Picking up an archived Agent's work requires saying so explicitly with
`join <id> --resume`, which keeps the stored Role and rejects the command if a supplied
Role differs from it. Resume also keeps the stored platform when `--platform` is
omitted, and replaces it only when the flag is given explicitly.

`last_seen` is updated whenever an Agent successfully runs a command that acts on the
Store, but it is only a hint about activity — crew cannot prove a process is alive. The
`agents` command labels each row `recent`, `idle`, `stale`, or `archived`. Looking stale
triggers nothing automatically: crew never archives or reassigns anything just because
an Agent appears stale. An active row is `recent` when it last acted under 5 minutes
ago, `idle` from 5 minutes up to (but not including) 30 minutes, and `stale` at 30
minutes or more. Archived rows always show `archived`. Leaving changes only the
lifecycle status and `archived_at`; the Agent's `last_seen`, Messages, Tasks, and
history all remain.

### 6.2 Messaging

A direct send checks that both the sender and the recipient are active Agents. A
broadcast writes one Message row for every other active Agent, all inside one
transaction. Messages are plain data; the Role prompts explicitly forbid treating
incoming text as instructions that outrank an Agent's own.

When rendered for a human, text is stripped of ANSI escape codes and invisible control
characters, so stored content cannot manipulate your terminal. JSON output uses ordinary
JSON escaping and keeps the stored text exactly as written. Every value goes into SQL
through bound parameters, never through string building.

### 6.3 Reviewed Task lifecycle

```text
 create                     start                    submit
   |                          |                         |
   v                          v                         v
 queued ----------------> in_progress ------------> submitted
   ^                          |                         |
   |                          | expired lease           | approve
   |                          | + requeue                v
   +--------------------------+--------------------- completed
   ^
   | reviewer requeue with reason
   +-------------------------- submitted
```

- `create` requires an active creator, assignee, and reviewer; it notifies the assignee.
- `start` may only be run by the assignee. It grants a 15-minute Lease — a claim that
  expires on its own, so a crashed Agent cannot hold a Task forever.
- `submit` may only be run by the holder of an unexpired Lease. It records the
  Submission and notifies the reviewer and the creator.
- `approve` may only be run by the reviewer. It completes the Task and notifies the
  creator and the assignee.
- `requeue` requires a named actor and a reason. The creator or the reviewer may requeue
  a Submission; either may recover an `in_progress` Task only after its Lease has
  expired. It notifies the assignee and the other Agents involved in the Task.
- Every transition increments `revision` and writes a Task Event.

Roles are not authentication: nothing technically verifies that an Agent is who it says
it is. The v1 trust model assumes all Agents name themselves and one another honestly.
The database conditions still catch honest mistakes — a command run as the wrong actor
fails instead of succeeding.

## 7. Launcher and Relay

### 7.1 Launch plan

`crew team <name> --launch` performs:

1. Load and validate the Team, the launcher config, the Task brief, and any
   command-line overrides.
2. Resolve one Participant CLI from the platform registry and show the exact executable
   it will run.
3. Optionally create or reuse one git worktree shared by the whole Crew.
4. Generate the plan and its files under `.crew/generated/<session>/` — the same input
   always produces exactly the same plan.
5. With `--print`, stop here: no setup, no state changes, no subprocesses, no tmux.
6. Check that explicit setup is healthy; never silently rewrite a Participant CLI's
   files.
7. Create the panes, wait until each pane's known executable is running and shows its
   readiness pattern, and paste the correct start command for the platform.
8. Wait for every Agent in the expanded Team roster to join.
9. Start one Relay in its own tmux window, unless `--no-relay` was given.
10. Paste the Task brief into the Manager's pane and attach the terminal to the session,
    unless `--no-attach` was given.

In v1 the automatic launcher starts every pane with the same single Participant CLI. The
`team` display output can still show the manual commands for running a mixed Crew by
hand.

### 7.2 Untrusted configuration

The tracked `.crew/launcher.yaml` is treated as untrusted input — anyone who can commit
to the repository can edit it.

- It can only choose a platform id from the registry; it can never supply an arbitrary
  shell command.
- A custom executable is accepted only from an explicit command-line flag, and crew
  prints it for you to confirm before running it.
- Child processes are started with argument arrays and `shell: false`, so no shell ever
  parses any of the values.
- Worktree paths are resolved and checked to stay inside their allowed location; branch
  and base values are passed to git as plain arguments, never spliced into shell text.
- YAML aliases and custom tags are disabled; a document with unknown keys fails
  validation.
- Task briefs, focus paths, constraints, and Messages are data, not instructions to
  execute. The Role prompts say so explicitly.

### 7.3 Relay behavior

The Relay is an internal node subcommand (`crew relay --internal --session <name>`)
started as the `crew-relay` window's command (ADR-0008); it is not a shell script. It
holds one long-lived read-only Store connection and, on each poll, calls the shared
`getPendingSummary` query — the same one behind `crew pending --summary` — which returns
only the unread count and the highest unread Message id, and never marks a row as read.
The decision to nudge is made per Agent by a pure function: given the last unread id it
observed and when it last reminded (both kept only in memory), the same inputs always
produce the same decision. How often it polls and how often it reminds
(`relay.poll_seconds`, `relay.reminder_seconds`) are set in
[launcher configuration](./configuration.md#launcher-schema-v1). When the Inbox changes,
and again at the configured reminder interval while unread Messages remain, it pastes
exactly:

```text
Crew inbox changed. Run: crew receive <agent-id>
```

The Agent id is validated before the plan is generated, and Message content is never
pasted into a pane. The Relay stops when the tmux session ends, when it receives
SIGTERM, or when its workspace disappears. Only the target Agent itself ever runs
`receive`. The Relay must never run `receive` on an Agent's behalf: printing text into a
terminal does not make an AI model take a turn, so a watcher that consumed Messages
would mark the whole Inbox as read and pour it into terminal output that no model would
ever see.

Each poll also lists the `in_progress` Tasks whose Lease has gone stale, along with each
Task's creator. A Lease crossing its expiry time writes nothing to the database
— it is a silent fact — so without this check, the only way anyone would notice is a
human running `doctor`. A second pure decision function, `staleLeaseStep`, handles this.
It is fully independent of the inbox logic: it keeps its own per-Task memory of when it
last reminded and shares no state with the inbox decision. It picks out the Tasks that
have just become stale or are past their reminder interval and pastes, into the
**creator's** pane (not the pane of the assignee whose Lease went stale):

```text
Task <task-id>'s Lease is stale. Run: crew task requeue <you> <task-id> --reason <text> (or abandon it).
```

## 8. Participant CLI integration

For each Setup Target — a supported AI tool that `crew setup` can configure — the
Platforms Module records:

- whether the target is a Participant CLI or a Model Backend;
- its executable name and the lowest version verified to work;
- where its global and project configuration files live, and in what format;
- the exact text used to start it interactively;
- the process names that show it is up and ready;
- guidance for granting it permission to run crew commands and nothing broader;
- for local model backends, a health check and a printed setup recipe.

The start command is not a literal `/crew` everywhere. Claude and Gemini use `/crew`,
Codex uses `$crew`, and in Copilot you run `/agent`, pick crew, and then type the prompt.
Ollama and LM Studio are Model Backends — local model servers a Participant CLI may use,
which crew itself never contacts — not Agents. The exact current facts and their
official sources are in [setup-integration.md](./setup-integration.md).

## 9. Runtime, dependencies, and distribution

- Written in TypeScript, using ES modules only, and compiled with a stable TypeScript
  release to plain JavaScript in `dist/`.
- Node.js `>=24.15` is required. That is the first release in the Node 24 line where the
  built-in `node:sqlite` module is rated release-candidate rather than still in active
  development
  ([Node SQLite docs](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)).
- The only runtime dependencies are `commander` and `yaml`; SQLite and UUID generation
  come from Node's own core modules.
- Development dependencies include TypeScript, Vitest, coverage, ESLint, `execa`, Preact,
  esbuild, jsdom, and Playwright. `npm run build` compiles the CLI and bundles the `web/`
  sources into self-contained assets under `dist/ui-assets/` that need no network
  connection; Preact is inlined into that bundle and is not a runtime dependency.
- The npm package is `@dichovsky/crew`; the installed executable is `crew`.
- The published package contains `dist/` (including `dist/ui-assets/`), the README, and
  the LICENSE. The Relay ships inside `dist/` as the internal `crew relay` subcommand
  (ADR-0008), so no separate launcher script needs to be packaged.
- The installed executable is compiled JavaScript; no TypeScript source runs directly.

The plain npm name `crew` was already taken, so the package publishes under the
maintainer's namespace as `@dichovsky/crew` while the command you type stays `crew`.
Publishing it is a release gate. The package name changes
nothing about command syntax or the workspace format. The naming and runtime decisions
are recorded as [DEC-7 and DEC-8](./decisions.md); the release gate itself is defined in
[product-spec.md](./product-spec.md#release-gates).

## 10. Maintenance behavior

- `doctor` only reads; it never changes anything. It checks tool versions, paths,
  whether exported built-in Roles or Teams have drifted from their packaged versions,
  State Store integrity, schema support, whether the filesystem looks local where that
  can be detected, tmux and git readiness, and stale Leases.
- `prune` deletes old already-read Messages and completed Tasks with their Task Events,
  keeping whatever the explicit retention flags say to keep. `VACUUM` (SQLite's
  reclaim-disk-space rebuild) is opt-in and requires that no Agents are active.
- `clean` refuses to run while active Agents exist. Deleting the State Store despite
  active registrations requires `--force`. This guard prevents an accidental split: a
  process that still holds the old database file open would keep writing to it (and its
  WAL helper files) while new commands create and write a fresh one.
- `clean` never removes setup files, Roles, Teams, launcher config, or Task briefs.

## 11. Deferred seams

- Claim-and-acknowledge Message delivery, so a Message is redelivered until confirmed
  (at-least-once) instead of the current at-most-once.
- Session tokens that detect when a newer session has displaced an older one (this is
  not authentication).
- Task dependencies, and queries for which Tasks are ready or grouped into phases.
- Durable Agent memory and assembling briefings from it.
- Approval records, and gates where a human must approve before work proceeds.
- Automatically launching a mix of different Participant CLIs, and one worktree per
  Agent.
- ~~Browser write actions, pane peek, maintenance controls, and deleted-Workspace recovery~~ —
  since built (recovery is FR-U32). If the
  Workspace is deleted out from under it, the Console's poller broadcasts
  `workspace-missing` exactly once and keeps polling on its normal interval. It attempts
  to reopen only once the database file genuinely exists again at the same path — the
  attempt is gated on `existsSync`, so recovery can never create a new database — and
  then broadcasts `workspace-restored`.

None of these exist as empty placeholder interfaces in v1. A new seam is added only when
a second implementation or a shipped use case actually needs it. The matching deferred
requirements are FR-X01–X08 in the [software requirements specification](./srs.md).
