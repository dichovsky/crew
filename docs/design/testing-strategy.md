# crew Testing Strategy

The suite proves the public interfaces and the failure modes that collaboration depends on.
The coverage percentage is a guardrail, not a substitute for proving the concurrency and
state-machine behavior.

## Test layers

| Layer | Interface under test | Process model | Purpose |
|---|---|---|---|
| Unit | validators, formatters, Role/Team/platform registry, launch plan | in-process | fast, exhaustive edge cases |
| Store integration | Store domain operations against temp SQLite | in-process, real DB | schema constraints, transitions, migrations, transactions |
| Program integration | `run(argv, io)` | in-process | parsing, exit/error/output contracts for every command |
| Spawn | built `crew` executable | many OS processes | locking, stdout/stderr, shebang, signals, crash behavior |
| Launcher contract | Launcher with recording process adapter | in-process | the exact subprocess argv, call order, cleanup, no shell interpretation |
| tmux e2e | built executable + real tmux | real processes | pane readiness, Relay nudge, session cleanup |
| Platform smoke | installed Participant CLI | release-only/manual or isolated job | generated artifact discovery and a finite workflow |
| Package smoke | packed tarball in clean temp prefix | real install | published file list, templates, executable, runtime floor |

The spawn layer starts many real operating-system processes on purpose, so it can prove
behavior — locking, crashes, signals — that in-process tests cannot reach. "e2e" means
end-to-end: the whole path is exercised, from the built executable to a real tmux session.

## Test environment matrix

- Self-hosted GitHub Actions runner, Node `24.18.0`.
- CI requires the self-hosted runner to provide tmux and runs the test suite with
  `CREW_REQUIRE_TMUX=1`, so the real-tmux e2e always runs in CI and a missing tmux is a hard
  failure (never a silent skip). Locally the real-tmux e2e gracefully skips when tmux is
  absent; the recording-adapter tests remain mandatory everywhere.
- Windows may run the core Program/Store tests as informational until officially supported.

Tests use an isolated temporary `HOME`, Workspace, XDG variables, Git repo, and database. No
test writes to real user setup locations or invokes a real model/backend except the release
smoke job.

## Unit and Store cases

### Workspace/configuration

- nearest-ancestor discovery, nested Workspace selection, no-Workspace error;
- the selective Git-ignore is safe to apply twice (the second run changes nothing); tracked
  files remain visible;
- symlink/path traversal rejection and cleanup after an interrupted atomic write;
- strict Team/launcher schema, unknown keys, denial of YAML aliases/tags/merge keys;
- replica expansion (turning one Role into several copies) and collision detection;
- precedence: defaults < tracked config < CLI flags.

### Agents and Messages

- id grammar, the reserved id, join, archive, exact resume, Role conflict;
- sequential and concurrent suffix allocation, including running out of suffixes;
- direct/broadcast recipient validation, and a broadcast that rolls back as one unit on
  failure;
- reply ownership validation;
- receive default/max limit, the Agent's activity timestamp update, ordering after
  `RETURNING`, empty receive, second receive returning nothing;
- pending does not consume anything; the summary exposes a count and a maximum id but no
  content or sender; history filter combinations and bounded ordering;
- rendering fixtures for ANSI/OSC/control characters, and exact preservation in JSON output;
- the 100,000-character limit, Unicode preview boundaries, multiline prefixes.

### Reviewed Tasks

- every allowed state transition and every forbidden one;
- wrong assignee/reviewer/creator; inactive participant;
- Lease edges before and after expiry, using a clock the test controls;
- submit clears the Lease, approve keeps the Submission, requeue clears the work fields;
- exactly one revision increment and one matching Task Event per transition;
- Task notification rows are written in the same transaction;
- constraint fixtures cannot create impossible status/field combinations;
- a completed Task cannot be changed, and retargeting is validated.

### Migrations and maintenance

- a fresh schema has the expected DDL, indexes, constraints, and `user_version`;
- an empty version-0 database initializes to v1; a non-empty version-0 database refuses
  without changing anything;
- once older released schemas exist, each supported non-zero fixture migrates to the current
  version through the ordered migration runner, and reopening it again changes nothing;
- a newer schema is rejected without changes; a too-old schema gets upgrade guidance;
- a failed migration rolls back the version and any DDL/data changes; the released v1->v2
  step adds `launch_token` (plus a partial index) and back-fills NULL, preserving rows, and a
  crash before its commit (real `run()` path, fault injected through the Io seam) rolls the
  database back to v1 with no partial schema;
- the `launch_token` stamp is set on the create-only join (never on resume) and never appears
  in output, and `reapByLaunchToken` deletes only untouched (no Task/Event/Message footprint)
  token-matching active rows — freeing their ids so the same team can launch again — leaving
  touched/foreign/no-token/archived rows intact; the launcher reaps only after a confirmed
  teardown and skips it otherwise;
- doctor detects drift in exported built-ins, stale Leases, and archived owners;
- prune cutoffs, reference behavior, and counts; the vacuum/clean active-Agent guards;
- quick-check and foreign-key-check findings map to `INTEGRITY`.

## Program contract suite

Drive every command through `run(argv, {cwd, stdin, stdout, stderr, env, clock})` using a
table of cases, and assert:

- help and valid/invalid option combinations;
- exit status and the exact machine error code;
- stdout/stderr separation;
- human-output snapshots for stable headings and hints;
- JSON schema fixtures for every record type;
- an unknown command never creates an Agent or a State Store;
- an empty query emits no JSON lines and exits 0;
- all command examples in `cli-contract.md` parse.

Avoid asserting commander's own incidental wording outside crew-owned error messages.

## Forced-contention spawn suite

This suite forces many processes to hit the database at the same time. All child processes
wait on a shared start barrier so their operations genuinely overlap. One knob,
`CREW_STRESS_ITERS`, scales every statistical case together (the deterministic
CONTENTION/lock and crash cases run once); the two CI tiers run a fast 25 iterations per case
on every PR and the full 500 per case nightly and at release on the self-hosted runner at
Node `24.18.0`. The local `npm run test:stress` convenience script defaults to an
intermediate 300 per case (override via `CREW_STRESS_ITERS`) as a quick pre-push check
between those tiers. The random retry delay is seeded per child from `CREW_STRESS_SEED`
(default 1), so a run can be replayed, apart from OS scheduling differences.

1. **Same-id join:** N processes request `worker`; the result is exactly N unique ids with no
   gaps in the claimed suffix range and no claim that reported success but did not stick.
2. **Same Inbox send/receive:** concurrent senders and receivers target one Agent. No Message
   id appears in two receivers' outputs; after draining, the history count equals the number
   of committed sends.
3. **Two receivers:** simultaneous receives of a fixed unread set split it with no overlap.
4. **Task race:** simultaneous submit/requeue or approve/requeue allows exactly one
   transition, one new revision, one Task Event, and the matching notification set.
5. **Lock deadline:** a test process holds a writer lock past the timeout; the contender
   retries once and returns `CONTENTION` with no partial state.
6. **Crash mid-transaction:** kill the process after the Task update but before the
   event/notification commit; reopening passes the integrity check and shows either all of
   the operation or none of it.
7. **Receive crash window:** kill the process after the receive commits but before its normal
   output completes; assert the Message may be marked read but remains in history, matching
   the documented guarantee.

“No lost messages” is never asserted as one blanket claim: the committed send count, the
returned ids, the unread ids, the read history, and the accepted receive crash window are
each measured separately.

Cases 6–7 and the migration crash inject their fault through the test-only fault build (a
fault-injecting `Io` over the real `run()` path, never the shipped binary; see ADR-0009). The
`clean` active-Agent guard is proven separately: a contender that opened the database
beforehand fails in a detectable way (`STALE_STORE`) when `clean` succeeds, and an active
Agent aborts `clean`, leaving the store intact.

## Launcher and Relay verification

### Recording adapter

The recording process adapter stands in for real process spawning: it records the
executable, argv, working directory, environment keys, and call order instead of running
anything. Tests prove:

- tracked config cannot introduce executable/argv/env text;
- all subprocesses use `shell:false`;
- each platform registry entry produces the expected invocation;
- `--print` makes zero process, setup-write, Store, worktree, or tmux calls;
- a readiness timeout tears down only a session created by this invocation;
- Task brief/Message text never enters shell argv or the Relay nudge;
- worktree storage remains under the managed base directory.

### Real tmux e2e

Two tiers of proof against real tmux, split by cost:

**Per-PR (`tests/spawn/tmux-e2e.test.ts`, runs on every PR with `CREW_REQUIRE_TMUX=1`).** The
adapter's argv actually drives tmux 3.6+ (create/split/tile/paste-argv/paste-file/window/kill),
and a single `relayTick` pastes the exact fixed nudge into a real pane WITHOUT consuming the
Inbox — using lightweight `cat` panes, no participant, no orchestrator.

**Nightly/release (`tests/spawn/launch-e2e.test.ts`, `launch-e2e.yml` tier; gated behind
`CREW_LAUNCH_E2E=1` so per-PR `npm test` collects it as a visible SKIP).** The FULL launch
path with a fake Participant. It drives `runLiveLaunch` **in-process against real tmux** (the
meeting point that neither the per-PR adapter e2e nor the in-process fake-adapter
orchestration test reached), injecting a fake Participant target — the same one for every
pane — through the launcher's `resolveTarget` dependency seam, so NO test hook ships in the
binary. The fake is a real Node executable whose `readinessNames` match the interpreter
process name (`node`) that tmux reports for the pane (robust across platforms, versus forcing
an OS-level process name); it parses its pasted invocation to run the REAL `crew join`
(honouring the injected `CREW_LAUNCH_TOKEN`) and the fixed nudge to run the REAL
`crew receive` exactly once. It proves end to end:

1. `runLiveLaunch` builds the real tmux session and the panes start with role-specific
   invocations;
2. two-stage readiness (pane process-name match, then the Store roster) waits for each pane's
   real `crew join`;
3. the untrusted Manager brief is pasted into the Manager pane;
4. a new Message makes the real `crew relay` window paste the exact fixed nudge into only the
   target pane;
5. the fake Worker's real `crew receive` consumes the Message exactly once (never twice);
6. session termination stops the Relay process and leaves nothing behind.

On failure it keeps per-pane captures plus the tmux version under
`tests/spawn/__artifacts__/`. Neither tier requires or mocks a model. The Store-location
contract for worktrees that these tests exercise is fixed in ADR-0011 (a short-lived Store
local to the worktree).

## Setup and platform testing

### Generator tests

- snapshot the path and contents for global and project scope;
- marker/hash checks; re-running is a no-op;
- refusal on edited/unmarked files, backup on force, atomic replacement;
- the generated workflow contains only current commands;
- the platform registry is the only source of install-path and invocation facts;
- backend targets write no file and redact environment values.

### Release smoke

For each Participant CLI at its minimum version, in a clean home directory, execute the
checklist in [setup-integration.md](./setup-integration.md). Store the tool version, date,
artifact hash, and result as a release artifact (a generated file kept as evidence). This job
may require credentials and is not part of CI for fork PRs.

## Security regression suite

Every acceptance test listed in [security.md](./security.md) is automated at the unit,
Program, or Launcher layer. Fuzz the validators — feed them large volumes of hostile input —
with path separators, control characters, oversized input, YAML features, shell
metacharacters, Unicode edge cases, and malformed SQLite fixtures.

## Package verification

`npm pack --json` must contain only the documented files. Install the tarball into a clean
temporary prefix and verify:

- `crew --version` and `crew --help`;
- init + join + send + receive + reviewed Task flow;
- packaged Role/Team resolution through `import.meta.url`;
- the executable bit and shebang line on macOS and Linux;
- Node below the engine floor fails with a clear message;
- no source maps or test fixtures leak secrets or local paths.

The package `@dichovsky/crew` is published after the release gates close: `0.1.0` was a
one-time manual `npm publish`, and `0.1.1`+ publish from CI via npm OIDC Trusted
Publishing (`.github/workflows/publish.yml`).

## Quality gates

- TypeScript strict typecheck and lint pass.
- Unit + Store + Program suite pass with >=95% coverage (statements, branches, functions, and
  lines) on logic-bearing Modules.
- 100% of the Task state machine's transition edges are covered.
- The spawn contention suite passes with zero unexplained `SQLITE_BUSY`/integrity failures.
- The package smoke passes against the packed tarball.
- The real tmux e2e passes before release.
- The platform smoke matrix is current for the release date.
- Documentation link/command consistency checks pass.

A concurrency test that fails intermittently is a release failure, not a candidate for blind
retries. When one fails, record the seed, process logs, a copy of the database, the OS, the
Node version, and the timing.
