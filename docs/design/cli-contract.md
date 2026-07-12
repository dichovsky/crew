# crew CLI Contract

This is the binding ("normative") contract for version 1 of the crew command line: what each
command accepts, what it prints, and how it fails. The `crew ui` and `crew team stop` commands
were added after v1; they only add to the contract and take nothing away from it. Examples use
the `crew` executable regardless of the final npm package name.

## General rules

- Running `crew` with no command does not fall back to showing help; it is an error.
- The same holds for command groups that require a subcommand: bare `crew role` and
  `crew task` are `USAGE` errors. Help appears only when asked for with an explicit `--help`.
- An unknown command is a usage error; it never changes stored state and is never treated as
  an implicit `join`.
- `--help`/`-h` is accepted for every command; `--version`/`-V` works at the top level.
- Commands that use shared state find their Workspace by walking up from the current
  directory to the nearest folder containing a `.crew/` directory; `init`, `setup`, `doctor
  --system`, help, and version work without one.
- Every command that outputs records accepts `--json`; list output is then NDJSON — each
  line is one complete JSON object. An empty list prints no JSON at all and exits 0.
- Human success output goes to stdout. Errors go to stderr. With `--json`, the error is one
  JSON object on stderr.
- Files and standard input are decoded as strict UTF-8. Bodies of Messages and Tasks (the
  durable notes and reviewed work items crew stores), summaries, and reasons are limited to
  100,000 Unicode code points; Task titles are limited to 500.
- Whether an error renders as JSON is decided by parsing the options properly, not by
  scanning for the text `--json`: a literal `--json` used as another option's value does not
  switch errors to JSON, and tokens after a `--` separator are plain argument data.

## Command catalogue

### Workspace and setup

```text
crew init [--with-guides] [--json]
crew setup [--list] [--json]
crew setup <claude-code|codex-cli|gemini-cli|copilot-cli|antigravity-cli|ollama|lmstudio>
           [--project] [--force] [--json]
crew doctor [--system] [--json]
```

- `init` creates the `.crew/{roles,teams,state,generated}` directories, writes any missing
  built-in Role and Team files (a Role is a behavioral prompt an Agent works under; a Team is
  a reusable roster template naming Agents and their Roles), and writes a `.gitignore` that
  ignores only `.crew/state/` and `.crew/generated/`.
- `--with-guides` appends a clearly marked crew section to `CLAUDE.md`, `AGENTS.md`, and
  `GEMINI.md`, but only when those files already exist; it never creates them, and it leaves
  their existing content byte-for-byte unchanged. Without the flag, `init` touches nothing
  outside the Workspace.
- `setup` with no argument only detects which Setup Targets (the tools `crew setup` knows how
  to configure) are installed and prints their status; it writes nothing.
- `setup <participant>` writes one generated configuration file for that platform — a
  Participant CLI is a terminal AI tool, such as Claude Code, that acts as an Agent by running
  crew commands. If the file already exists but crew did not write it, or it was edited
  locally, crew refuses unless `--force` is given, and it backs the file up before replacing
  it.
- `--project` writes the file inside the project; the default is your user-wide ("global")
  location. It is invalid for Ollama/LM Studio, because setting up those backends prints a
  checked recipe (instructions plus the results of local checks) instead of writing a command
  file. Before writing, crew verifies the project file path truly stays inside the workspace
  root: if a symlinked component of the repository would carry it outside, the command fails
  with `UNSAFE_PATH` and nothing is written.
- `doctor --system` checks the machine itself — Node, the Participant CLIs, tmux (a terminal
  multiplexer: a tool that splits one terminal into several independent panes), git, and the
  setup files crew wrote at global scope — and works outside a Workspace. A Participant CLI,
  tmux, or git that is simply not installed is an `info`-level `DEPENDENCY_MISSING` finding. A
  setup file that was edited, was not written by crew, or is out of date — or one missing
  entirely for a CLI that is installed — is a `SETUP_DRIFT` finding. `--system` looks only at
  executables and global files; the default (Workspace) mode also checks the setup files
  inside the project. A missing project file is not flagged, because project setup is opt-in.

### Workspace configuration

```yaml
# .crew/config.yaml (optional; absent file or key = feature off, no behavior change)
version: 1
worker_worktrees:
  enabled: false
  base_ref: HEAD
```

- `.crew/config.yaml` is an optional Workspace-level settings file. It is separate from the
  existing `.crew/launcher.yaml`, which applies only to `--launch`: `config.yaml` governs
  every Worker (the built-in Role that carries out a Task and submits the result) no matter
  how it joined — a pane created by a live `--launch`, or a `crew join` run by hand — not just
  launched Crews.
- The file is entirely optional; if absent, every feature below stays off. When present,
  `version: 1` is required (the only accepted value).
- `worker_worktrees.enabled` (default `false`) switches on per-Worker Task worktrees
  (ADR-0015, promoting FR-X07). A worktree is a separate working copy of the git repository
  that shares the same history, so one Task's file changes cannot disturb another's. When
  `true`, `task start`/`task review`/`task land` create, check out, and remove one worktree
  per Task and one per reviewer (see Reviewed Tasks). This setting is separate from, and does
  not affect, the whole-Crew `--worktree`/`--no-worktree` launch flags (ADR-0011, under Roles
  and Teams), which create a single worktree shared by an entire launched Crew.
- `worker_worktrees.base_ref` (default `HEAD`) names the branch each new Task or review
  worktree branches from. It is resolved to a concrete branch name when the worktree is
  created and is never stored as the literal `HEAD`. A git revision expression (anything that
  is not a plain branch name) is rejected up front as invalid configuration, instead of
  surfacing later as a failed `task start` or `task review`.
- The file is parsed as strictly as `launcher.yaml`: it must be a single YAML mapping; YAML
  aliases, merge keys, and custom tags are not allowed; unknown keys are rejected. A document
  that breaks any of these rules is `INVALID_CONFIG`.

### Agent lifecycle

```text
crew join <id> [--role <role>] [--platform <platform>] [--resume] [--json]
crew leave <id> [--json]
crew agents [--all] [--json]
```

- An Agent is one named registration in the Crew, usually a single terminal AI session. Agent
  ids match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`; `@all` is reserved.
- The Role defaults to the requested id. The platform is optional and, when given, must be a
  Participant CLI id.
- If the requested id is taken, crew reserves the first free suffixed id from `-2` through
  `-99` in a single database step, so two joins racing each other cannot claim the same id.
- The suffix logic never hands out an archived id. `--resume` targets that exact archived id;
  it fails if the id is currently active, or if an explicitly supplied Role differs from the
  stored one. Omit the Role and the stored Role is kept; omit the platform and the stored
  platform is kept, while an explicitly supplied platform replaces it.
- `leave` works only on an active Agent: it marks the row archived (sets `archived_at`) and
  keeps `last_seen` and all linked history. Running leave again on the same Agent returns
  `AGENT_INACTIVE`.
- `agents` lists active registrations by default. The human-readable status labels are
  `recent`, `idle`, `stale`, and `archived`; the output never claims an Agent is online,
  because crew cannot prove a process is alive. An active row is `recent` when last seen
  under 5 minutes ago, `idle` from 5 minutes up to (but not including) 30 minutes, and
  `stale` at 30 minutes or more. Archived rows always show `archived`.

### Messaging

```text
crew send <from> <to> <message...> [--reply-to <message-id>] [--json]
crew send <from> <to> --file <path|-> [--reply-to <message-id>] [--json]
crew receive <id> [--limit <1..500>] [--json]
crew pending [--agent <id>] [--summary] [--limit <1..500>] [--json]
crew history [--agent <id>] [--from <id>] [--to <id>]
             [--since <timestamp>] [--limit <1..1000>] [--json]
```

- A Message is a durable note stored for exactly one Agent. Sending to `@all` broadcasts it
  to every other active Agent; `--reply-to` cannot be combined with a broadcast.
- A broadcast picks up the recipient list once, inside a single database transaction, writes
  one Message per recipient in recipient-id order, and still succeeds — producing no records
  — when no other active Agent exists.
- `--file` and Message text on the command line are mutually exclusive. `--file -` reads the
  Message from standard input.
- Input content is preserved exactly, including leading/trailing whitespace and final newlines.
- `receive` returns at most 50 Messages by default and marks exactly the returned rows as
  read, in the same database step that fetches them. Limits are integers from 1 through 500;
  a receive that finds nothing still refreshes the active Agent's activity timestamp.
- `pending` only looks; it never marks anything read. `--summary` requires `--agent` and
  returns just two facts computed over the complete Inbox (the unread Messages addressed to
  one Agent): the unread count and the highest unread Message id, which is `null` when the
  Inbox is empty. Without `--summary`, pending returns the oldest 50 unread rows by default.
  `--summary` and `--limit` cannot be combined.
- `history --agent x` matches Messages where `x` is the sender or the recipient; every other
  filter narrows the result further (they combine with AND).
- Agent filters on pending and history must name an existing Agent, but that Agent may be
  archived.
- `--since` is inclusive. It accepts either a plain integer count of seconds since 1970 (an
  epoch second, within JavaScript's safe-integer range) or an ISO-8601 timestamp with whole
  seconds and either `Z` or a numeric UTC offset. History returns the newest 100 by default,
  ordered oldest-to-newest within that window; its limit range is 1 through 1000.

### Reviewed Tasks

```text
crew task create <creator> <assignee> --reviewer <agent>
                 --title <text> [--body <text>] [--json]
crew task start <agent> <task-id> [--json]
crew task submit <agent> <task-id> --summary <text> [--json]
crew task review <agent> <task-id> [--json]
crew task approve <reviewer> <task-id> [--summary <text>] [--json]
crew task requeue <actor> <task-id> --reason <text> [--to <agent>] [--json]
crew task abandon <actor> <task-id> [--reason <text>] [--json]
crew task land <actor> <task-id> [--force] [--json]
crew task show <task-id> [--events] [--json]
crew task list [--assignee <id>] [--reviewer <id>]
               [--status <status>] [--stale-lease] [--json]
```

- A Task is a durable unit of assigned work that must pass a Review before it counts as done.
  Task ids are UUIDv4 strings (randomly generated universally unique identifiers); an id not
  shaped like a UUID is `USAGE`, and a well-formed id that matches no Task is `NOT_FOUND`.
- `create` puts a Task in `queued`. `start` moves it to `in_progress` and grants a 15-minute
  Lease — a claim that expires on its own after that time, so a crashed Agent cannot hold a
  Task forever. `submit` moves it to `submitted`, and `approve` to `completed`.
- `submit --summary` is required and must be 1–100,000 Unicode code points; `approve
  --summary` is optional and, when supplied, must be non-empty.
- `review` (ADR-0015) checks out a `submitted` Task's branch into the reviewer's own
  review worktree, so the reviewer can inspect the work in place. Only the Task's assigned
  reviewer may do this. That worktree is created the first time the reviewer runs the command
  (on branch `crew/review-<agentId>`) and is then reused — checked out again — on every later
  review. Calling it as anyone else, on a Task that is not `submitted`, or on a Task with no
  worktree is `TASK_CONFLICT`. The command does not change the Task's status, so it emits no
  `task` record — with `--json` it emits one `task_review` record instead, and the human
  output prints the resulting path.
- `requeue` always requires an actor and a reason. The Task's creator or reviewer may send a
  Submission (a Worker's finished result waiting for Review) back for rework; they may reclaim
  an `in_progress` Task only after its Lease has expired. `--to` reassigns the Task to a
  different Agent.
- `abandon` retires a `queued`, `in_progress`, or `submitted` Task into the final
  `abandoned` status without it ever completing. It is the exit for a Task that will never be
  finished — a worker that was meant to run once and exit but hung instead, or a Lease nobody
  will ever reclaim. The creator or reviewer may abandon; once **both** are archived, the
  plain `operator` Agent identity (id `operator`, Role `operator`, platform `NULL` —
  ADR-0012, the same identity the Console's own startup guard recognizes) may abandon on
  their behalf — a row that merely holds the id but does not match that exact shape is
  refused. `--reason` is optional (unlike `requeue`, where a reason is required); an
  unauthorized actor, or a Task already in a final state (`completed` or `abandoned`), is
  `TASK_CONFLICT`. `abandoned` is as final as `completed` — there is no un-abandon. `abandon`
  also unconditionally clears the Task's worktree fields in the same status change, then
  makes a best-effort attempt to remove the worktree from disk (ADR-0015; a failed
  removal only warns on stderr and never blocks the abandon). The notification sent to the
  assignee carries the structured `clear_safe` Sign-off kind (ADR-0016 — an abandoned Task is
  final, so the notification doubles as the Sign-off, the signal that the Worker may safely
  clear its own context) and is delivered even when the assignee is the Agent doing the
  abandoning; the creator/reviewer copies stay `note`s and skip the acting Agent as usual.
- `land` (ADR-0015) lets the Task's creator or reviewer remove a `completed` Task's
  worktree and branch once the change has genuinely landed; a wrong actor, a non-`completed`
  Task, or a Task with no worktree is `TASK_CONFLICT`. crew knows nothing about GitHub or any
  remote server, so it judges "landed" from the local repository alone: if the worktree has
  uncommitted changes, or its branch is not yet contained in ("an ancestor of") its recorded
  base branch, the work looks unlanded and `land` refuses (also `TASK_CONFLICT`) unless
  `--force` is given. `--force` overrides only that local judgement — it never forces git's
  own `branch -d`, which independently refuses to delete an unmerged branch and so acts as a
  second safety net. On success `land` removes the worktree and branch, clears the Task's
  three worktree fields, and automatically sends the ADR-0014 Sign-off (`Task <id>: landed,
  safe to clear your context.`, a structured `clear_safe`-kind Message — ADR-0016) to the
  assignee — even when the assignee is itself the Agent doing the landing — so a Manager (the
  built-in Role that assigns and monitors Tasks) no longer needs a separate `crew send` for a
  Task that used a worktree; output follows the same convention as the other Task mutations,
  `approve` and `requeue`.
- Every mutation prints the Task's new status and revision. Internally the Store always
  applies the change as a compare-and-set — the write succeeds only if the Task is still at
  the revision the operation read — even though the CLI never asks for a revision argument.
- When `worker_worktrees.enabled` is set (opt-in, see Workspace configuration), `start` also
  creates or reuses the assignee's own worktree and prints its path (human output gains a
  `Worktree <path>` line; `--json` and `show` add `worktree_path`/`worktree_branch`/
  `worktree_base_ref`, all `null` when the feature is off or the Task hasn't started).
  `approve` and `requeue` then try to switch the acting reviewer's own review worktree back
  to its resting branch when it is checked out to this Task's branch — a failed switch-back
  only warns on stderr, it never fails the command.
- `show --events --json` emits one Task record followed by its Task Event records (a Task
  Event is the permanent record of one Task transition and who performed it). Both are read
  from a single consistent view of the database, so a transition happening at the same moment
  cannot make the Task and its Events disagree.
- `list` filters must name existing Agents (archived is permitted; a missing Agent is
  `NOT_FOUND`). `--stale-lease` only applies to running Tasks, so combining it with a
  `--status` other than `in_progress` is `USAGE`.

### Roles and Teams

```text
crew roles [--json]
crew role show <name> [--json]
crew role export <name> [--force] [--json]
crew teams [--json]
crew team <name> [--client <platform>] [--json]
crew team <name> --launch [--client <platform>] [--workers <n>]
          [--task-file <path>] [--worktree <branch>] [--no-worktree]
          [--no-relay] [--no-attach] [--print] [--json]
crew team stop <session> [--json]
crew team resume <session> [--json]
```

- `role export` copies a Role that ships inside the crew package to `.crew/roles/<name>.md`;
  when a project file and a packaged Role share a name, the project file wins.
- `team` expands replicas (how many copies of each member to start) and prints, per resulting
  Agent, the exact command to run in its terminal and the `crew join` step.
- `--launch` uses one Participant CLI for every pane; mixing platforms in one launch is not
  supported. The client is chosen in this order: `--client` on the command line, then the
  tracked `runtime.client` setting, then the default. A Team whose members hint at different
  platforms, with neither of the first two set, is a `USAGE` error that points the operator
  to `--client`, `runtime.client`, or manual mode.
- `--print` changes nothing: it writes no setup files, does not touch the State Store (the
  SQLite database in `.crew/state/` that the whole Crew shares), starts no subprocess, and
  creates no worktree or tmux session. It validates the full launch plan and prints it — as
  a single JSON object under `--json` (byte-identical to `launch-plan.json`; a deliberate
  exception to the one-object-per-line list convention), or as a compact human summary
  otherwise. In the JSON plan, task-brief metadata is limited to `task_brief.present` plus
  `target_role`; the human summary may additionally show the resolved brief path and line
  count from the plan assembled in memory.
- Bare `--launch` (no `--print`) builds the live tmux session. The steps: validate the plan,
  create the panes, wait for each Participant CLI to become ready and for the whole roster to
  register, start the Relay window (unless `--no-relay`) — the Relay is an optional helper
  that notices new unread Messages and nudges idle panes awake without reading anything
  itself — paste the brief into the Manager pane, and attach the terminal to the session
  (unless `--no-attach`). Failures: missing tmux is `DEPENDENCY_MISSING`, with guidance for
  launching manually and **no** half-built session left behind (FR-H02). A tmux session that
  already has the derived name is `ALREADY_EXISTS` — crew never builds on top of one. A tmux
  child process that is killed or times out before it can prove its outcome either way — the
  `tmux -V` availability probe and every control command alike — is the generic operational
  `ERROR`, never "tmux missing" and never a launch-shaped failure, because the same tmux
  operations also serve `team stop`, listing owned sessions, pane peek, the Relay, and
  checking resume eligibility. A tmux control command that runs but exits non-zero remains
  `LAUNCH_FAILED`. A timeout while waiting for readiness or registration tears down only the
  session this invocation created and reports `LAUNCH_FAILED`.
- A live launch sets `CREW_LAUNCH_TOKEN` — a cryptographically random token generated fresh
  for each launch — in each pane's environment. This variable is **reserved**: `crew join`
  reads it to record which launch created the new Agent, and operators must not set it
  themselves. The token never appears in any output. Only after a session teardown that crew
  could **confirm** does crew delete the untouched Agent rows carrying that token (rows with
  no Task, Task Event, or Message attached — safe to remove because nothing else refers to
  them). Deleting them frees their ids, so the same team can be launched again immediately;
  crew never touches an Agent that existed before the launch, carries a different launch's
  token, or was actually used. This cleanup is best-effort and is **skipped** when the
  teardown could not be confirmed (the panes may still be live, so their rows stay active).
  Rows that were used, and rows a skipped or failed cleanup leaves behind, remain active and
  listed by `crew agents`; remove them with `crew leave`, or reset the workspace with
  `crew clean`.
- `--worktree <branch>` creates or reuses one worktree shared by the whole Crew.
  `--no-worktree` overrides any tracked configuration. This is independent of the opt-in
  per-Worker Task worktrees switched on by `worker_worktrees` in `.crew/config.yaml` (see
  Workspace configuration and Reviewed Tasks, ADR-0015); a Workspace may use either
  feature, both, or neither. A **live** launch with a worktree resolves (creates or reuses)
  that single worktree as its last preparation step — after every read-only check has passed,
  before anything touches tmux — and then runs the whole launched Crew inside it: the Store,
  the generated files, and every pane's working directory (ADR-0011). If the worktree
  cannot be set up, the failure surfaces before any tmux session exists.
  `crew team stop <session>` needs no `--worktree` flag: run it with the worktree as (or
  under) the current directory, and the normal upward `.crew/` discovery finds that
  worktree's own pane-map and Store. If the launch fails partway, a worktree this launch
  newly created is removed once tmux teardown is confirmed; a reused (pre-existing) worktree,
  or any worktree from a successfully launched session, is left untouched (a stop-time
  policy for the latter is deferred).
- `--workers <n>` overrides how many Worker copies to start (range 1–32); every other Team
  member keeps its declared replica count.
- `--no-relay` starts no Relay; `--no-attach` creates the session without attaching the
  terminal to it. Both are independent of `--print`.
- `team stop` acts only when it can prove crew owns the session. It requires a pane-map file
  crew itself wrote under `.crew/generated/<session>/`, and the random launch marker in that
  file must match the marker on the live tmux session. If the map is missing or stale, or a
  session with the same name carries a different or missing marker, nothing is killed. Once
  ownership is proven, crew kills the session through its tmux layer, archives the Agents
  named by the pane-map, and retires the pane-map. Human output summarizes the stopped
  session and the number of Agents archived; `--json` emits one `stop_result` record.
- `team stop` failures use the existing error codes and follow the General rules for stdout,
  stderr, and exit status; the command introduces no new error code.
- `team resume` re-creates a crew-owned session that was stopped cleanly. It requires tmux
  (`DEPENDENCY_MISSING` otherwise) and is strict about its preconditions: the session's
  clean-stop marker and its stored `launch-plan.json` must both exist under
  `.crew/generated/<session>/`; no tmux session of that name may currently be live
  (`ALREADY_EXISTS`); the stored plan must still match a plan built fresh from the current
  Team and configuration (`TEAM_DRIFT` otherwise); and every Agent in the plan must still
  exist as exactly the archived row it left behind (`TEAM_DRIFT`). On success it relaunches
  the session from the matching plan, reactivates the archived Agents, and retires the
  clean-stop marker. Like `team stop`, it introduces no new error code.
- Every literal verb that follows `crew team` — today `stop` and `resume` — is a reserved
  word: a Team cannot carry such a name, because `crew team <verb> <session>` would be
  parsed first and hide `crew team <name>` for it. Team validation rejects a reserved name
  with a `USAGE` error, and `crew teams` never lists a project file whose filename stem is a
  reserved word.

### Local Console (post-v1)

```text
crew ui [--port <n>] [--no-open] [--json]
```

- `ui` starts the Console — a small web dashboard for the Operator, the human working
  alongside the Agents — as a foreground HTTP server reachable only from your own computer
  (it binds to `127.0.0.1`). It never detaches and is not a daemon (a background process that
  keeps running on its own); Ctrl-C shuts it down. Every other crew feature works without
  this server and never requires it.
- Without `--port`, crew chooses a random available port. `--port <n>` requires a decimal TCP
  port from 1 through 65535 and uses that port instead; an invalid or unavailable explicit
  port makes the command fail — crew never silently falls back to a different port.
- Every run generates a new secret token, includes it in the authenticated Console URL, and
  requires it on every HTTP request. The token is not emitted as a separate field or record.
- The authenticated URL is a secret: anyone on the same machine who obtains it can act as the
  Operator until the server stops. Do not paste or share it; it can persist in browser history
  and terminal scrollback, and restarting `crew ui` invalidates it by generating a new token.
- Human output prints the authenticated local URL after successful startup. By default crew
  then opens that URL in the browser; `--no-open` skips the browser opening without changing
  how long the server runs. With `--json`, successful startup emits exactly one `ui_started`
  line after the server is listening and before it continues serving in the foreground.
- The browser-side source lives under `web/`; `npm run build` uses esbuild to bundle it into
  `dist/ui-assets/`, which ships with the package so the Console works with no internet
  access. A Team launched from the Console never attaches a terminal; attaching to that
  session remains terminal-only.
- The Console performs Operator actions — send a Message, create a Task, approve a
  Submission, requeue a Task — over the same token-protected HTTP surface. The acting Agent
  is always the plain Operator row, and the server decides that by itself; a request body
  cannot name a different actor, and every action goes through the same Store operations
  (with the same authority checks) as the equivalent CLI command. `crew ui` makes sure the
  Operator row exists at startup.
- The Console's actions additionally cover launching a Team (always detached — attaching
  stays terminal-only), stopping a Team crew owns, peeking at a pane, and running `prune` or
  `clean` — and nothing else. Pane peek returns the pane's `capture-pane` text with terminal
  control characters stripped, even on the JSON surface (the deliberate FR-U24 exception to
  the rule that JSON output keeps raw bytes). Team stop, `prune`, and `clean` each require an
  explicit confirmation: the browser shows a dialog naming the irreversible effect, and the
  request must carry a `confirm: true` flag the server checks before acting (a bare,
  unconfirmed POST is rejected).
- For reading, the Console additionally exposes `GET /api/sessions` — the crew-owned tmux
  Team sessions that are live right now. It reuses the same pane-map ownership proof as
  `team stop`, so only sessions crew could actually stop are listed; stale, foreign, or
  malformed entries are left out. Each row carries `session_name`, `pane_count`,
  `agent_count`, and `started_at` (in epoch seconds — seconds since 1970). The browser app
  itself has five views (Overview, Agents, Tasks, Messages, Operations), as specified in SRS
  FR-U34.
- A successful `clean` run from the Console shuts that `crew ui` process down after the
  response has been sent. While winding down, the server rejects further requests, closes the
  Store connection it opened at startup, and never serves data from the deleted database or
  quietly recreates it.
- `ui` failures use the existing error codes and follow the General rules for stdout, stderr,
  and exit status; the command introduces no new error code.

### Maintenance

```text
crew prune [--messages-before <duration>] [--tasks-before <duration>]
           [--vacuum] [--json]
crew clean [--force] [--json]
```

- Durations use `<integer><s|m|h|d|w>`, for example `30d`.
- By default, prune deletes Messages that have been read and are older than 30 days, and
  Tasks that are completed or abandoned and older than 90 days (measured by
  `completed_at` and `abandoned_at` respectively). A Task is kept as long as any notification
  linked to it is still unread.
- `--vacuum` refuses to run while any active Agent exists.
- `clean` also refuses while active Agents exist; with `--force` it deletes the State Store
  files and nothing else.

## Exit status

| Exit | Meaning |
|---:|---|
| 0 | command completed successfully, including an empty query |
| 1 | operational/domain failure |
| 2 | usage or configuration validation failure |

A future polling command must not reuse exit status 2 for anything else. A future approval
check may use a documented status >=10 for “pending.”

## Error codes

| Code | Exit | Meaning |
|---|---:|---|
| `USAGE` | 2 | malformed command, unknown flag/command, invalid combination |
| `INVALID_CONFIG` | 2 | invalid Team/Role/launcher/setup document |
| `NOT_WORKSPACE` | 1 | no `.crew/` ancestor |
| `NOT_FOUND` | 1 | Agent, Message, Task, Role, Team, or file absent |
| `ALREADY_EXISTS` | 1 | exact resource exists and overwrite/resume was not requested |
| `AGENT_INACTIVE` | 1 | acting sender/recipient/Task participant is archived |
| `TASK_CONFLICT` | 1 | status, revision, actor, Lease, or worktree-state predicate rejected the operation |
| `TEAM_DRIFT` | 1 | a requested Team/session launch or stop invariant no longer matches live state |
| `CONTENTION` | 1 | SQLite remained busy after timeout and bounded retry |
| `INTEGRITY` | 1 | State Store health or foreign-key check failed |
| `UNSUPPORTED_SCHEMA` | 1 | State Store is newer/too old for this binary |
| `UNSUPPORTED_PLATFORM` | 1 | Setup Target or Launcher participant is unsupported/unverified |
| `UNSAFE_PATH` | 1 | configured path escapes its allowed root |
| `DEPENDENCY_MISSING` | 1 | tmux, git, Participant CLI, or backend prerequisite absent |
| `ACTIVE_AGENTS` | 1 | maintenance (`prune --vacuum` / `clean`) refused because active Agents exist |
| `STALE_STORE` | 1 | the State Store was removed/replaced (e.g. by a concurrent `clean`) while an operation held it open; the write fails detectably instead of orphaning data |
| `ERROR` | 1 | unexpected throwable outside the `CrewError` taxonomy, or a tmux child (the `tmux -V` probe or any control command) killed/timed out before it could prove its outcome either way |
| `LAUNCH_FAILED` | 1 | a live launch step failed (a non-zero tmux op, pane readiness, or roster registration); the owned session is torn down |

Human errors use `[CODE] message`. JSON errors use:

```json
{"ok":false,"error":{"code":"TASK_CONFLICT","message":"Task is submitted, expected in_progress","details":{"task_id":"..."}}}
```

Some specific conditions map as follows: an Agent id of `@all`, or any id that does not match
the id pattern, is `USAGE`; combining `--reply-to` with an `@all` broadcast is `USAGE`; and
running out of the `-2`..`-99` collision suffixes for a requested id is `ALREADY_EXISTS`, with
a message naming the id that ran out.

## JSON record envelopes

Every success record includes `type` and `schema_version: 1`. Field names use snake_case.
A consumer must ignore any new field it does not recognize — fields may be added at any time
— while removing or renaming a field requires a major version of the CLI contract.

### Agent

```json
{"type":"agent","schema_version":1,"id":"worker","role":"worker","platform_id":"codex-cli","status":"active","activity":"recent","joined_at":0,"last_seen":0,"archived_at":null,"stale_lease_count":0}
```

### Message

```json
{"type":"message","schema_version":1,"id":1,"sender_id":"manager","recipient_id":"worker","content":"Inspect X","kind":"note","task_id":null,"reply_to":null,"created_at":0,"read_at":null}
```

The record printed by receive carries the `read_at` value that was actually committed to the
database. The JSON serializer escapes control characters as part of normal JSON encoding; the
stored content itself is never rewritten.
A direct send emits one record. A broadcast emits one record per actual recipient, and a
broadcast that reached nobody emits no JSON lines.
`kind` is one of `note`, `task_assigned`, `task_submitted`, `task_approved`, `task_requeued`,
or `clear_safe` (the structured Sign-off sent on land/abandon, ADR-0016); every kind other
than `note` is created only by its Task transition, never by `send`.

### Inbox state

```json
{"type":"inbox_state","schema_version":1,"agent_id":"worker","unread_count":2,"max_unread_id":17}
```

This is the only record the Relay ever reads; it contains no Message content and no
information about senders.

### Task

```json
{"type":"task","schema_version":1,"id":"uuid","title":"Add X","body":"","creator_id":"manager","assignee_id":"worker","reviewer_id":"inspector","status":"submitted","revision":2,"lease_owner_id":null,"lease_expires_at":null,"submission_summary":"Implemented X","submitted_at":0,"review_summary":null,"completed_at":null,"abandoned_at":null,"worktree_path":null,"worktree_branch":null,"worktree_base_ref":null,"created_at":0,"updated_at":0,"stale_lease":false}
```

`worktree_path`/`worktree_branch`/`worktree_base_ref` (ADR-0015) are always either all
`null` or all set together: they are filled in when `task start` creates a worktree under
`worker_worktrees.enabled` (see Workspace configuration), stay recorded even if the feature is
later switched off, and are cleared only by `task land` or `task abandon`.

### Task Event

```json
{"type":"task_event","schema_version":1,"id":3,"task_id":"uuid","revision":2,"event_type":"submitted","actor_id":"worker","from_status":"in_progress","to_status":"submitted","detail":"Implemented X","created_at":0}
```

### Task review

`crew task review --json` (ADR-0015) emits one `task_review` record after checking out
the Task's branch in the reviewer's own worktree; it is not a `task` record, because the Task's
status does not change.

```json
{"type":"task_review","schema_version":1,"task_id":"uuid","agent_id":"inspector","path":"/home/user/.local/share/crew/worktrees/<repo-hash>/review-696e73706563746f72","branch":"crew/review-696e73706563746f72","base_ref":"main"}
```

### Health finding and summary

`doctor` emits zero or more `health_finding` records (most noteworthy first) followed by
exactly one `health_summary`. `severity` is one of `info`, `warn`, `error`; `details` is an
optional object. The finding `code` reuses the error-code vocabulary, so findings and errors
speak one language (`DEPENDENCY_MISSING`, `STATE_PATH`, `NETWORK_FILESYSTEM`,
`NESTED_WORKSPACE`, `NO_STATE_STORE`, `UNSUPPORTED_SCHEMA`, `INTEGRITY`, `SCHEMA_DRIFT`,
`STALE_LEASE`, `ARCHIVED_OWNER`, `ROLE_DRIFT`, `TEAM_DRIFT`, `SETUP_DRIFT`, `INVALID_CONFIG`,
`UNSAFE_PATH`). `SETUP_DRIFT` reports a Participant setup file that was edited locally or not
written by crew (`warn`), or that came from an older registry revision, or that is missing at
global scope for a CLI that is installed (`info`). Its `details` carry the `target` to fix,
all affected `targets` when several targets deliberately share one project file path, plus
`scope`, `path`, and `drift`; the message includes the exact command that fixes it
(`crew setup <target> [--project] [--force]`). A project Role or Team config file that cannot
be read does not abort `doctor`: it becomes a `warn` finding (`INVALID_CONFIG` or
`UNSAFE_PATH`) instead, and this softening is per file — each unreadable or invalid project
file produces its own finding (with the file's `name` in `details`) while every remaining
valid Role/Team config is still listed and checked for drift. If the whole listing fails
(e.g. the `roles/` or `teams/` directory itself cannot be read), that becomes a single
finding the same way.

```json
{"type":"health_finding","schema_version":1,"severity":"warn","code":"STALE_LEASE","message":"Task lease expired","details":{"task_id":"uuid"}}
```

`health_summary.workspace` is the resolved `.crew` path, or `null` under `doctor --system`.
`ok` is `true` exactly when the `error` count is 0. Any `error`-severity finding makes
`doctor` exit 1, but only after every record has been written out (the error code used is
`UNSUPPORTED_SCHEMA` when such a finding is present, otherwise `INTEGRITY`); findings that
are only `warn` or `info` exit 0.

```json
{"type":"health_summary","schema_version":1,"workspace":"/repo/.crew","ok":true,"info":1,"warn":2,"error":0}
```

### Prune and clean results

`prune` always emits exactly one `prune_result`, even when nothing was deleted.
`messages_deleted` is the total number of Messages removed (Task-linked ones plus standalone
read Messages); `tasks_deleted` counts the deleted completed Tasks. With `--vacuum`,
`vacuumed` is `true` only when the space-reclaiming `VACUUM` actually ran; if active Agents
block it, the record is still emitted with `vacuumed:false` and the command then exits 1
(`ACTIVE_AGENTS`).

```json
{"type":"prune_result","schema_version":1,"messages_deleted":12,"tasks_deleted":3,"vacuumed":false}
```

`clean` emits exactly one `clean_result` whenever it acts: after a successful removal, and
also when there was nothing to remove because the store is absent (`removed:[]`, exit 0).
When active Agents block the deletion and `--force` was not given, the command exits 1 with
`ACTIVE_AGENTS` and emits no record — the refusal appears only on the error channel, so
seeing a `clean_result` always means clean acted. `removed` lists the State Store file names
that existed and were deleted (`crew.db`, `crew.db-wal`, `crew.db-shm` — the last two are
extra helper files SQLite creates next to the database). Removing only those helper files
still goes through the normal guarded opening of the Store, which may briefly create a
`crew.db`, so that file can also appear in `removed`. `forced` reflects `--force`.

```json
{"type":"clean_result","schema_version":1,"removed":["crew.db","crew.db-wal","crew.db-shm"],"forced":true}
```

### Role

`roles` emits one record per Role; `role show` adds the `body` field, exactly as stored (the
human output strips control characters from it; JSON does not — FR-J08/J11). `source` is
`packaged` for a built-in Role or an unmodified seeded copy, and `project` for an edited or
custom file.

```json
{"type":"role","schema_version":1,"name":"manager","source":"packaged","builtin":true,"version":1}
```

`role export` emits a result record:

```json
{"type":"role_export","schema_version":1,"name":"manager","path":".crew/roles/manager.md","forced":false}
```

### Team

`teams` emits one record per Team. `team <name>` emits one `team_member` record per Agent
after replicas are expanded, carrying the exact `crew join` step for that Agent. The record
also carries the platform registry's `invocation(role, id)` output as the
`invocation` field (FR-F13); it is present only when a platform can be determined
(from a member hint or `--client`).

```json
{"type":"team","schema_version":1,"name":"dev","source":"packaged"}
```

```json
{"type":"team_member","schema_version":1,"team":"dev","agent_id":"worker-2","role":"worker","replica_base":"worker","platform":"codex-cli","join_command":"crew join worker-2 --role worker --platform codex-cli","invocation":"$crew worker worker-2"}
```

`team <name> --launch --print` instead emits the single `launch-plan.json` object (its schema is
in [configuration.md](./configuration.md#generated-artifacts)). The `--print` output is
byte-identical to the generated file and is kept stable so tests can rely on it as a
compatibility fixture.

A live `team <name> --launch` (no `--print`) emits one `launch_result` after the session is
built, before attaching. `attached` says whether crew attached the terminal (it reflects
`--no-attach`); `relay` says whether a Relay was started (it reflects `--no-relay` and
configuration).

```json
{"type":"launch_result","schema_version":1,"session_name":"crew-demo","panes":4,"relay":true,"attached":true}
```

`crew team stop <session> --json` emits exactly one `stop_result` after an owned session is
killed and the Agents named in the pane-map are archived. `killed` is a boolean and
`agents_archived` is the number of Agents that were archived.

```json
{"type":"stop_result","schema_version":1,"session_name":"crew-demo","killed":true,"agents_archived":3}
```

`crew relay --internal --session <name>` is an internal, hidden command that crew starts
automatically as the `crew-relay` tmux window; it is not meant to be run by users and refuses
(`USAGE`) when invoked without `--internal`.

### Local Console startup

`crew ui --json` emits exactly one `ui_started` record after a successful start. The numeric
`port` is the port the server is listening on, `workspace` is the resolved `.crew` path, and
`url` is the authenticated local-only URL — it includes the per-run token that every request
needs. There is no separate token field or token record.

```json
{"type":"ui_started","schema_version":1,"url":"http://127.0.0.1:43127/?token=example-per-run-token","port":43127,"workspace":"/repo/.crew"}
```

### Init

```json
{"type":"init","schema_version":1,"workspace":"/repo/.crew","seeded":[".crew/roles/manager.md"],"skipped":[],"gitignore_updated":true,"guides_appended":["CLAUDE.md"]}
```

### Setup

`setup` / `setup --list` emits one `setup_target` per Setup Target (this is detection only;
nothing is written). `present` records whether the executable was found on PATH; `version` is
the first `\d+.\d+.\d+` pattern found by running the tool's `--version` with a time limit, or
null when the tool is absent or its output cannot be parsed. For a Participant,
`global_state`/`project_state` classify how the written file has drifted (`absent`,
`managed-current`, `managed-outdated`, `managed-edited`, `unmanaged`); `project_state` is null
outside a Workspace. Backend rows carry null path and state fields.

```json
{"type":"setup_target","schema_version":1,"id":"claude-code","category":"participant","executable":"claude","present":true,"version":"2.1.195","global_path":"~/.claude/skills/crew/SKILL.md","global_state":"absent","project_path":".claude/skills/crew/SKILL.md","project_state":"absent"}
```

`setup <participant>` emits one `setup_result`. `action` is `written` (a new file, or an
overwrite under `--force`), `noop` (the file was already `managed-current`), or `regenerated`
(an outdated file refreshed in place). `backup_path` is non-null only when a `--force`
overwrite first backed up an edited or unmanaged file to `<name>.bak.<epoch>`; a refusal
without `--force` is an `ALREADY_EXISTS` error, not a record. `state` is the drift state as
it was before the write; `path` is written relative to `~` (global scope) or relative to the
Workspace (project scope). `registry_revision` is the integer revision of the platform
registry that produced the file.

```json
{"type":"setup_result","schema_version":1,"id":"claude-code","scope":"global","path":"~/.claude/skills/crew/SKILL.md","action":"written","backup_path":null,"state":"absent","registry_revision":2}
```

`setup <backend>` (Ollama/LM Studio) writes no file and emits one `setup_recipe`: the results
of read-only `checks` plus the `recipe_lines` it printed. `--project` and `--force` are usage
errors for a backend. The recipe text is fixed and never embeds values taken from the
machine's environment (FR-J13).

```json
{"type":"setup_recipe","schema_version":1,"id":"ollama","checks":[{"name":"executable","ok":true,"detail":"ollama found on PATH"}],"recipe_lines":["Ollama serves a Participant CLI; crew never contacts it. Pick your CLI:"]}
```

## Human output layout

Human output is for people; the `--json` form (one JSON object per line) is the contract for
machines. The conventions below are stable enough for snapshot tests, but the exact column
widths are pinned by the snapshot fixtures, not promised as an API.

- Lists render a header row plus one aligned row per record; an empty list prints a single
  `No <things>.` line to stdout and exits 0.
- Timestamps render as UTC ISO-8601 in human output even though they are stored as epoch
  seconds.
- Detail/`show` views render labeled fields, one per line.
- Activity and status use the words `recent`, `idle`, `stale`, `archived`; never `online`.
- Multi-line Message/Task text is indented, and each continuation line gets a prefix so
  stored text cannot pass itself off as a crew header (see Human rendering safety below).
- Send and receive show the full Message content, with control characters stripped. Pending
  and history show a preview of at most 200 Unicode code points, stripped the same way and
  followed by `…` only when something was cut off.
- A broadcast that reached nobody prints `Broadcast reached 0 recipients.` in human output
  and emits no JSON lines.
- `crew ui` prints the authenticated local-only URL and whether it opened the browser, then
  stays in the foreground until Ctrl-C. `--no-open` reports that the browser was not opened.
- Successful `crew team stop` output names the stopped session and how many Agents were
  archived, for example `Stopped crew-demo; archived 3 Agents.`

Representative examples (the whitespace shows the idea; it is not part of the contract):

```text
$ crew agents
ID        ROLE       PLATFORM   ACTIVITY  LAST SEEN
manager   manager    codex-cli  recent    2026-06-29T10:00:00Z
worker    worker     codex-cli  idle      2026-06-29T09:40:00Z

$ crew receive worker
#12  manager -> worker  2026-06-29T10:00:00Z
  Inspect the auth module and report findings.

$ crew task show <uuid>
Task    <uuid>
Title   Add X
Status  submitted (revision 2)
Roles   creator=manager assignee=worker reviewer=inspector
Lease   none

$ crew agents   # when none exist
No agents.
```

## Human rendering safety

- Strip terminal escape sequences (ANSI CSI/OSC) and control characters (C0/C1) except
  newline and tab, so stored content cannot manipulate the terminal.
- Prefix continuation lines so stored content cannot visually pass itself off as a crew
  header.
- Never paste stored Message content through the Relay.
- Shell quoting in examples is for display only; the implementation passes subprocess
  arguments as arrays with `shell: false`, so no shell ever interprets them.
- Preview truncation cuts on whole Unicode code points (never in the middle of a character)
  and adds an ellipsis only when something was actually cut off.
