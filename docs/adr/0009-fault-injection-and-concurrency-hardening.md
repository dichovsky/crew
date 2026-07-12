---
status: accepted
---

# Fault injection rides the Io seam; the clean guard guarantees no silent loss, not linearizability

The hardening work recorded here proves that the system survives race conditions and hostile
inputs. Fault injection here means deliberately making the program fail — crash, get unlucky
timing — at chosen points during a test. Four choices carried real weight: they shape how the
system is tested and how its one destructive maintenance command behaves.

**Crash and randomness injection extend the `Io` interface; the shipped binary contains no fault
code.** `Io` is the boundary through which crew touches its environment, so tests can swap any
part of it out. Two requirements need test-only control over a running program: the forced-crash
cases (killing the process mid-transaction, and the `receive` crash window) and reproducible
random jitter. We rejected building a `process.abort()` into production code behind an
environment variable, and we rejected a coarse external kill signal. Instead, the test-only fault
build injects a faulting `Io`: `random` becomes an injected capability just like `clock` — the
real `Math.random` in production, a seeded stream in tests, so a stress failure that looked
random can be replayed exactly; and an optional `onTransactionStep` hook on `Io` is threaded
through `openWorkspaceStore`, so a test can crash the **real** `run()` path at a labelled point
inside a transaction. Production never sets either field, so no fault code ships, and a
package-smoke test confirms the fault build never reaches the published package.

**The `clean` active-Agent guard guarantees "no silent loss", not linearizability.** (In plain
terms: no one's committed data can vanish without an error being raised — but we do not promise
that concurrent operations behave as if they ran one at a time.) The naive version — check that
no Agent is active, then delete the database files — had a reproduced bug: a `join` that had
already opened the database could commit its write into the just-deleted file, silently losing
it. A persistent "maintenance in progress" marker file was rejected too: if a cleanup crashed,
the marker would stay behind and block every future `join` — a self-inflicted lockout. Instead,
`clean` holds the database write lock across BOTH the check for active Agents and the file
deletion, and every write transaction re-checks, while holding its own lock, that the database
file on disk is still the same file it originally opened. A competing process that carries on
after the files vanish fails with a clear `STALE_STORE` error instead of writing into a void.
The guarantee is stated precisely in `security.md`: a competing writer either commits durably or
fails with an error it can see; `clean --force` remains the deliberate escape hatch that skips
this protection. VACUUM only repacks the file without changing its contents, so its brief window
cannot lose data.

**One knob scales every forced-contention test together.** A single setting
(`CREW_STRESS_ITERS`) sets the iteration count for the same-id join race, the Inbox
send/receive race, the two-receivers race, and the Task races; the deterministic
CONTENTION/lock and crash cases always run exactly once, because their outcome never varies.

**Stress tests run in two CI tiers.** Every PR runs a fast fixed count (25 iterations per case)
and blocks the merge on failure; a job that runs nightly, on release, and whenever
concurrency-critical paths change runs the full count (500 per case) on both operating systems
at the minimum supported Node version, keeps the failure output for inspection, and never
retries blindly — a concurrency test that fails only sometimes is treated as a release failure,
not noise.

The consequence: crashes, lock contention, and hostile inputs are all exercised through the real
program with inputs that can be replayed exactly, and the one destructive maintenance command
can no longer lose a concurrent writer's data without telling them.
