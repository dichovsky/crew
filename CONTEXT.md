# crew Coordination Context

crew coordinates terminal coding agents — AI coding tools that each run in their own
terminal session — inside one local workspace. The vocabulary below defines the concepts
used across the requirements, the architecture, the commands, and the tests. Each term is
used with exactly the meaning given here.

## Language

### Collaboration

**Crew**:
The set of Agent registrations that share one Workspace's State Store — in plain terms, all
the agents coordinating through the same local database.
_Avoid_: cluster, swarm

**Agent**:
A named registration that stands for one actor in a Crew — usually one AI CLI session
running in a terminal.
_Avoid_: process, model, provider

**Operator**:
The human user. In the database the Operator is the ordinary Agent row named `operator`
with no platform set; it acts under the same State Store rules as every other Agent, not
as a privileged identity.
_Avoid_: administrator, superuser

**Participant CLI**:
An AI application that can run shell commands and takes part as an Agent by running crew
commands itself.
_Avoid_: provider, backend

**Role**:
A behavioral prompt assigned to an Agent — instructions on how to act. Assigning a Role
grants no privileges.
_Avoid_: permission, capability

**Team**:
A roster template, suitable for keeping under version control, that declares which Agent
ids exist and which Role each one has.
_Avoid_: Crew, session

**Manager**:
The built-in Role that breaks goals down into Tasks, assigns each Task and its reviewers,
and keeps watch on Reviews.
_Avoid_: controller, orchestrator process

**Worker**:
The built-in Role that starts a Task and produces a Submission.
_Avoid_: executor process

**Inspector**:
The built-in Role that either accepts a Submission or sends its Task back for rework.
_Avoid_: approver, tester

### Work

**Task**:
A unit of assigned work. It is stored durably and moves through a lifecycle that includes
a review step.
_Avoid_: job, ticket

**Lease**:
A claim an Agent holds while a Task is in progress. The claim expires on its own after a
set time, so a crashed Agent cannot hold on to a Task forever.
_Avoid_: lock

**Submission**:
A Worker's summary of its result, waiting for a Review.
_Avoid_: completion, result

**Review**:
An Inspector's decision that either completes a submitted Task or puts it back in the
queue for more work.
_Avoid_: validation message

**Task Event**:
A record of one Task transition and the actor who caused it. Once written, it is never
changed.
_Avoid_: log line

### Messaging and runtime

**Message**:
A note, stored durably, addressed to one Agent and consumed (read and removed) from that
Agent's Inbox.
_Avoid_: event, task

**Sign-off**:
A structured Message of the `clear_safe` kind, sent to a Worker to confirm that a Task's
work has fully landed: it was Reviewed and Approved, merged if there was anything to
merge, its worktree cleaned up if it had one — and no further rework will be requested.
It is the signal that the Worker's conversation context is safe to reset. Only
`task land` creates one, plus `task abandon` for the Task's assignee (ADR-0016); a `note`
typed by hand with the same wording is advice only, not a real Sign-off.
_Avoid_: approval, notification

**Inbox**:
The set of Messages addressed to one Agent that it has not read yet.
_Avoid_: queue when discussing the user-facing concept

**Workspace**:
The directory crew works in: starting from the current directory and walking upward, the
nearest one that contains a `.crew/` directory.
_Avoid_: repository, working tree

**State Store**:
The SQLite database file at `.crew/state/crew.db`. Every Agent in a Crew shares this one
database.
_Avoid_: server, message bus

**Worktree**:
A separate working copy of the git repository, managed by crew and checked out on its own
branch. It keeps one Task's — or one launched Crew's — file changes apart from the
Workspace.
_Avoid_: clone, sandbox, checkout

**Review Worktree**:
A persistent Worktree owned by one Inspector. Instead of getting a fresh copy for every
Task, the Inspector reuses this one across Reviews by switching branches.
_Avoid_: task worktree, review copy

**Launcher**:
The setup path that builds a tmux session (tmux splits one terminal into several panes),
creates a pane for each participant, and types each platform's start command into its
pane. It runs once, does its job, and exits — nothing stays running.
_Avoid_: orchestrator, daemon

**Relay**:
An optional helper tied to one tmux session. It notices when an Inbox has changed and
types a short, fixed wake-up nudge into the matching pane; it never consumes the Messages
themselves.
_Avoid_: watcher, daemon

**Console**:
The optional web interface served by `crew ui`. You start it explicitly, it runs in the
foreground of your terminal, and it is reachable only from your own computer. No other
crew feature needs it; it is neither a background process that keeps running on its own
nor a remote dashboard.
_Avoid_: daemon, remote dashboard

**Setup Target**:
Something `crew setup` knows how to configure: either a customization for a Participant
CLI or a recipe for a local Model Backend.
_Avoid_: participant when referring to Ollama or LM Studio

**Model Backend**:
A server that runs an AI model and answers a Participant CLI's requests. crew itself
never contacts it.
_Avoid_: Agent, participant

## Relationships

- A **Workspace** owns exactly one **State Store**.
- A **Crew** contains zero or more **Agents**; each **Agent** has exactly one **Role**.
- A **Team** declares one or more intended **Agents** and their **Roles**.
- A **Manager** creates a **Task** for one **Worker**.
- A **Worker** holds at most one **Lease** per in-progress **Task** and produces one current **Submission**.
- An **Inspector** performs a **Review** of a **Submission**.
- A **Manager** may send a **Sign-off** to a **Worker** once a **Task** has fully landed.
- A **Task** may have one **Worktree**, created when its **Worker** starts it and removed when it lands.
- An **Inspector** reviews a **Submission** inside its own **Review Worktree**.
- A **Task** has one or more **Task Events**, none of which ever change once written.
- An **Agent** owns one **Inbox** containing zero or more **Messages**.
- A **Launcher** may start one **Relay** for its tmux session.
- A **Participant CLI** may use one **Model Backend**; crew does not.

## Example dialogue

> **Dev:** "Did the Worker complete the Task when it submitted the patch?"
> **Domain expert:** "No. The Worker created a Submission. The Task becomes completed only after the Inspector's Review accepts it."
>
> **Dev:** "Does the Relay receive the Worker's Messages?"
> **Domain expert:** "No. It only notices that the Inbox changed and nudges the pane. The Agent runs `crew receive` itself."

## Flagged ambiguities

- The word "online" used to mean an active row in the database. Resolved: say **active Agent**, because crew cannot prove a process is actually alive.
- The word "completed" used to mean both "the worker finished" and "the review accepted". Resolved: the worker's output is a **Submission**; only review acceptance completes the **Task**.
- The "watcher" used to consume Messages without waking a model turn. Resolved: the **Relay** performs a check that consumes nothing and injects only a fixed nudge.
- The phrase "first-class platform" used to include servers that are not agents. Resolved: Ollama and LM Studio are **Setup Targets** and **Model Backends**, never Participants.
