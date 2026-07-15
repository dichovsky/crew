# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`crew` is a local coordination CLI for terminal coding agents (Claude Code, Codex CLI,
Gemini CLI, Copilot CLI, Antigravity CLI, Pi CLI, opencode CLI). It gives independently running sessions a shared inbox, a
reviewed task workflow, and an optional tmux launcher. **crew never calls a model
provider itself** — it only coordinates via a workspace-local SQLite database.

The package publishes as `@dichovsky/crew` but the installed executable is `crew` (the
unscoped npm name was unavailable — see DEC-7 in `docs/design/decisions.md`).

The code is feature-complete: Workspace/Role/Team config, the schema-versioned State
Store, the Agent lifecycle, Messaging, reviewed Tasks (including `task abandon` and the
stale-lease change signal), `doctor`/`prune`/`clean` maintenance, the platform registry
with explicit `setup`, deterministic launch planning, adversarial concurrency + security
hardening, and the `crew ui` Console (loopback dashboard with SSE and Operator actions,
`crew team stop`, deleted-workspace recovery). Bare `team --launch` builds a real tmux
session through a semantic tmux adapter (two-stage readiness, owned-session teardown,
`tmux attach` via the `runInteractive` Io seam) and starts an internal `crew relay`
subcommand that nudges idle panes from the content-free Inbox summary without consuming
Messages (ADR-0008). The live launch is worktree-enabled, with per-Worker isolated Task
worktrees (ADR-0015).

`0.1.0` is published to npm. The first publish was a one-time manual `npm publish`
(npm OIDC Trusted Publishing can only attach to a package that already exists); from
`0.1.1`, a published GitHub Release runs `.github/workflows/publish.yml` and publishes
via OIDC with provenance — no long-lived npm secret ever enters CI. `docs/README.md`
("Current readiness") is the single source of truth for release status, and
`docs/release/publishing.md` is the runbook. `1.0.0` is reserved for a later milestone,
once the CLI and store contracts are declared stable.

## Branch discipline (HARD RULE — never violate)

Each unit of work ships as its own branch via its own PR, started from the latest
`main`. **Before writing ANY code, establish the correct branch baseline — do this
BEFORE the first edit, not after:**

1. **Confirm the prior work is merged.** Check `gh pr view <n>` (state `MERGED`).
2. **Branch off the latest `main`:**
   `git checkout main && git pull && git checkout -b feat/<slug>`.
3. **Verify before editing:** `git branch --show-current` must name the work you are
   implementing.

**NEVER start new work on a completed/merged branch, and never assume the branch the
session happens to open on is the right one.** A merged feature branch is finished — new
work does not continue on it. If you ever find yourself "restoring" a session to a merged
branch, stop: branch off `main` instead.

## Commands

```sh
npm run build          # tsc -p tsconfig.build.json → dist/ (the publishable artifact)
npm run typecheck      # tsc -p tsconfig.json (noEmit, includes tests)
npm run lint           # eslint . (type-checked rules; lint:fix to autofix)
npm run format         # prettier --write . (format:check in CI)
npm test               # vitest run
npm run test:coverage  # vitest run --coverage (95% threshold: statements/branches/functions/lines)
npm run test:watch     # vitest

# Run a single test file or a named test:
npx vitest run tests/unit/format.test.ts
npx vitest run -t "rejects a non-empty version-0 database"
```

CI (`.github/workflows/ci.yml`) runs typecheck → lint → format:check → build → test:coverage
on GitHub-hosted runners at Node `24.18.0`. All five must pass — the test step enforces the
95% coverage thresholds — so match them locally (`npm run test:coverage`, not plain
`npm test`) before pushing.

**Node `>=24.15` is a hard floor.** The Store uses the built-in `node:sqlite` module,
which only exists in Node 24+. There is no SQLite dependency in `package.json`.

## Architecture

### The seams (read these first)

The whole CLI is testable in-process because the process environment is injected, not
reached for directly:

- **`src/io.ts`** — the `Io` interface: `cwd`, `env`, `stdin`, `stdout`, `stderr`, and
  `clock` (epoch seconds, the single source of "now" for an operation). Everything crew
  touches in the environment is one of these fields. Tests use `tests/helpers/io.ts`
  (`captureIo`) to capture output and control the clock.
- **`src/run.ts`** — `run(argv, io): Promise<number>` is the single Program seam. It
  drives commander and maps every outcome to an exit code plus crew-owned output. It
  **never calls `process.exit`** (the bin shim sets `process.exitCode` so Node can drain
  buffered stdout, e.g. piped NDJSON).
- **`src/store/index.ts`** — the `Store` class exposes deep domain operations
  (`joinAgent`, `leaveAgent`, `listAgents`, …), not generic CRUD. This is the
  persistence-test seam.

### Execution flow

`bin/crew.ts` (the installed executable shim) → `assertNodeFloor()` **before importing
the app graph** → dynamic `import('../src/run.js')` → `run(argv, io)`.

The Node-floor-then-dynamic-import ordering is deliberate and load-bearing: ESM evaluates
static imports before any module body, and the app graph imports `node:sqlite` (Node 24+
only). A static import would make a too-old runtime fail with an opaque linking error
instead of the clear floor message. **Do not convert that dynamic import to a static
one.**

`src/cli.ts` builds **two** commander programs from one command registration: the live
program (with version/help and a bare-invocation USAGE action) and a silent validator
(no-op actions). `run.ts` parses through the validator to enforce FR-A11 — help/version
is honored only when the surrounding command/option sequence is otherwise valid (so
`crew bogus --help` is a USAGE error, not a masked success).

### Module boundaries (enforced rules)

- **Only `src/store/` imports `node:sqlite`.** All other modules go through the `Store`
  domain interface. Keep SQL out of command handlers.
- **Command handlers (`src/agents.ts`, `src/init.ts`, `src/roles.ts`, `src/teams.ts`)
  stay thin**: validate input, call a deeper module, render output. No SQL, no platform
  path literals.
- **`src/workspace.ts`** owns workspace discovery (walk up for the nearest `.crew/`
  directory) and path derivation; **`src/fs-safe.ts`** owns path-contained safe writes.
  Commands don't rediscover filesystem policy.
- **`src/format.ts`** owns all output rendering. Human output is run through
  `sanitizeHuman` (strips ANSI/control sequences so stored content can't manipulate the
  terminal); **JSON/NDJSON output keeps raw bytes** and never rewrites stored content.
- **`src/participants.ts`** is the shared Participant CLI id vocabulary (`ParticipantId`).
  Invocation, setup, executable, and version facts live in the authoritative platform registry
  (**`src/platforms/`**): `registry.ts` resolves targets; `shared.ts` owns the record types,
  canonical workflow, marker/content-hash, and version probe; one module per target. `setup`,
  `doctor`, Team display, and the Launcher read the registry — no parallel path tables.
- **`src/setup/`** owns `crew setup`: `index.ts` is the detect/install/recipe flow; `fs.ts`
  does setup's guarded writes to global/project paths *outside* `.crew/` (a deliberately
  separate, narrower policy than the workspace-scoped `fs-safe.ts`).
- **`src/process.ts`** is the real `Io.runProcess` (capture-only, `shell:false`) for version
  probes; **`src/which.ts`** is the shared PATH executable lookup.

### Errors and exit codes

All operational/usage failures are a `CrewError` (`src/errors.ts`) carrying an
`ErrorCode`. Exit mapping: `USAGE` / `INVALID_CONFIG` → exit **2**; every other code and
any unknown throwable → exit **1**; success → **0**. Errors render as `[CODE] message`
(human) or a `{ ok: false, error: {...} }` envelope (`--json`).

### State Store invariants

`src/store/schema.ts` defines schema-v1 as `STRICT` tables with extensive `CHECK`
constraints — task-status transitions, lease consistency, and event ordering are
enforced **in the database**, not just in code. `assertCurrentSchema` canonicalizes and
compares the live schema against the released SQL on every open. When changing the
schema, bump `CURRENT_SCHEMA_VERSION` / `PRAGMA user_version`, add a `SchemaMigration`,
and update the data-model doc and migration tests together.

The Store opens connections defensively (WAL, `foreign_keys=ON`, `trusted_schema=OFF`,
`defensive=true`, no extension loading) and retries `SQLITE_BUSY`/`LOCKED` with bounded
backoff (`CONTENTION` after two timeouts). **Local filesystem only** — WAL's
shared-memory sidecars make NFS/SMB-backed workspaces unsupported.

## Conventions

- **ESM throughout**, `"type": "module"`, `NodeNext` resolution. Import local files with
  the `.js` extension (e.g. `from './errors.js'`) even though sources are `.ts`.
- **Immutability**: return new objects; never mutate inputs.
- **Two output surfaces are both first-class contracts**: the human table/line format
  and `--json` NDJSON. Every command supports both; keep them in sync.
- TypeScript is maximally strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`). Conditional spreads like
  `...(role !== undefined ? { role } : {})` are the idiom for optional fields under
  `exactOptionalPropertyTypes`.

## Tests

Vitest, organized by layer under `tests/`: `unit/` (pure modules), `integration/`
(`commands/`, `program/`, `package/` pack-smoke), `store/` (schema + persistence),
`spawn/` (subprocess). Coverage gate is **95%** (statements, branches, functions, and
lines) over `src/**` and `bin/**`.

## Docs are the contract

`docs/` is the implementation contract, not just background. When sources and docs
disagree, the authority order (`docs/README.md`) is: accepted **ADRs**
(`docs/adr/`) → the **Software Requirements Specification (SRS)** (`docs/design/srs.md`;
functional FR-\* + non-functional NFR-\*) → **CLI contract** + **data model** →
**architecture**. A behavior change must update
requirements, the CLI contract, and tests in the same change; a schema
change must update the data model, migration tests, and `user_version` together.

The domain vocabulary in **`CONTEXT.md`** is binding everywhere (e.g. a Worker produces a
*Submission*; only an Inspector's *Review* *completes* a *Task* — don't conflate the two).

> Note: this repo dog-foods crew, so its own root `.gitignore` ignores `.crew/` as the
> tool's runtime workspace. For end users, `crew init` writes a `.crew/.gitignore` that
> tracks config (`roles/`, `teams/`) and ignores only `state/` and `generated/`.
