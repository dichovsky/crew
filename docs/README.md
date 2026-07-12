# crew Documentation Map

This directory is the implementation contract for crew — it defines what the code must
do. When documents disagree, follow the authority order below and fix the
lower-authority document in the same change.

## Authority order

1. Accepted [ADRs](./adr/README.md) — Architecture Decision Records, which capture decisions that would be hard to reverse.
2. [Software Requirements Specification (SRS)](./design/srs.md) for required behavior (functional and non-functional).
3. [CLI contract](./design/cli-contract.md) and [data model](./design/data-model.md) for what the commands promise to the outside and what the database promises to keep.
4. [Architecture](./design/architecture.md) for what each module is responsible for and how data flows between them.

The domain vocabulary in [CONTEXT.md](../CONTEXT.md) applies everywhere.

## Build packet

| Document | Question it answers |
|---|---|
| [Product specification](./design/product-spec.md) | Who is this for, what outcome does v1 promise, and what is left out? |
| [Architecture](./design/architecture.md) | Which Modules exist, where are the seams (the boundaries where one part can be swapped or tested on its own), and how does data move? |
| [Software Requirements Specification (SRS)](./design/srs.md) | What behavior is mandatory and testable (functional FR-\* + non-functional NFR-\* requirements), written following the ISO 29148:2011 guidance? |
| [CLI contract](./design/cli-contract.md) | What commands, outputs, errors, and compatibility guarantees exist? |
| [Data model](./design/data-model.md) | What data is stored, and which rules must still hold after every transaction? |
| [Configuration schemas](./design/configuration.md) | Exactly which YAML/Markdown input files may a project commit? |
| [Setup integration](./design/setup-integration.md) | How does each Participant CLI or Model Backend plug in? |
| [Security](./design/security.md) | What is trusted, what can go wrong, and which protections are required? |
| [Testing strategy](./design/testing-strategy.md) | How are behavior, race conditions, packaging, and integrations verified? |
| [Decision index](./design/decisions.md) | Which decisions are accepted, which are provisional, and which are still tied to a release gate? |

## Change discipline

- A change to CLI behavior updates the requirements, the CLI contract, and the tests together.
- A schema change updates the data model, the migration tests, and `PRAGMA user_version` together.
- A decision that would be hard to reverse gets an ADR; do not bury it in a commit message.
- Facts about third-party setup go out of date quickly. Re-check the official sources
  before every release and update the `Verified` date in the integration matrix.

## Current readiness

This section is the single source of truth for release status; `AGENTS.md` and
`CLAUDE.md` summarize it and defer here.

The design remains the implementation contract, and the code is feature-complete
against it: Workspace/Role/Team configuration, the State Store (crew's shared SQLite
database, with a versioned schema), the Agent lifecycle, Messaging, reviewed Tasks
(including `task abandon` and the stale-lease change signal), the
`doctor`/`prune`/`clean` maintenance commands, the platform registry with an explicit
`setup` command, deterministic launch planning (the same input always produces exactly
the same plan), the live tmux Launcher and Relay with per-Worker isolated git worktrees
([ADR-0015](./adr/0015-per-worker-task-worktrees.md)), hardening against hostile
concurrent use and security attacks, and the `crew ui` Console — a dashboard reachable
only from your own computer, with live updates (SSE) and Operator actions.

Nothing has been published yet: the package is at `0.1.0`, unreleased — there are no
git tags, `@dichovsky/crew` does not exist on the npm registry, and `CHANGELOG.md`
lists the feature set under its first entry. The canonical
[release-gate table](./design/product-spec.md#release-gates) records the six gates that
block that first publish; every part of them that can be automated is already done.
What remains are the maintainer's manual steps — run the live smoke test (the hands-on
check that needs real credentials) and commit its evidence files,
`npm publish --access public`, and tag `v0.1.0` — and the npm publishing token never
enters CI. `1.0.0` is reserved for a later milestone, once the CLI and store contracts
are declared stable.
