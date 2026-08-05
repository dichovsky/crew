import { Note, Section, Stepper } from '../kit';

/**
 * How two Agents racing on one Task resolve. The lesson: the losing write fails
 * loudly with TASK_CONFLICT rather than silently overwriting or falsely succeeding.
 */
const STEPS = [
  {
    id: 'read',
    label: 'Both read',
    a: 'reads task at revision 4',
    b: 'reads task at revision 4',
    db: 'revision 4 · status submitted',
    detail:
      'Two Agents observe the same Task at the same revision. Nothing is locked yet, and both believe they may act. Every Task carries a whole-number revision counter for exactly this moment.',
  },
  {
    id: 'immediate',
    label: 'A takes the lock',
    a: 'BEGIN IMMEDIATE — write lock acquired',
    b: 'waiting on the write lock',
    db: 'revision 4 · locked by A',
    detail:
      'Task transitions that need several statements use BEGIN IMMEDIATE, which takes the write lock up front. That ordering is the point: the transaction locks before it reads anything it depends on, so what it checked cannot change underneath it. A read-first, write-later transaction would have a window where it could not.',
  },
  {
    id: 'commit',
    label: 'A commits',
    a: 'UPDATE ... WHERE revision = 4 → 1 row · event appended',
    b: 'still waiting',
    db: 'revision 5 · status completed',
    detail:
      'The update’s conditions check the Task id, the revision, the expected status, the acting Agent, and where relevant the Lease. It must change exactly one row. The same transaction then appends the Task Event and any notification Messages — one transaction, or nothing at all.',
  },
  {
    id: 'conflict',
    label: 'B fails loudly',
    a: 'done',
    b: 'UPDATE ... WHERE revision = 4 → 0 rows → TASK_CONFLICT',
    db: 'revision 5 · unchanged by B',
    detail:
      'B’s conditions no longer match, so its update touches zero rows and the command returns TASK_CONFLICT. Not a not-found, not a silent no-op, and above all not a success. A write is never reported as successful unless it actually committed.',
  },
  {
    id: 'contention',
    label: 'Or: contention',
    a: 'holding the database',
    b: 'busy timeout → wait 25–100 ms → retry once',
    db: 'busy',
    detail:
      'A different failure: if SQLite’s 5-second busy timeout expires, crew waits a random 25 to 100 milliseconds and retries once. If the retry also times out, the command returns CONTENTION. Bounded backoff, bounded retries — a command never spins.',
  },
] as const;

export function Concurrency() {
  return (
    <Section
      title="Concurrency: leases, revisions, and conflict"
      lede={
        <>
          Several Agents share one SQLite file with no coordinating server between them. Correctness
          comes from three things: a revision counter on every Task, transactions that take the
          write lock before reading, and an update that must change exactly one row. Step through a
          race to see how the loser finds out.
        </>
      }
      sources={[
        { path: 'docs/design/architecture.md', label: 'Architecture §5 — store and concurrency' },
        { path: 'docs/adr/0009-fault-injection-and-concurrency-hardening.md', label: 'ADR-0009' },
        { path: 'docs/design/data-model.md', label: 'Data model — transactions' },
      ]}
    >
      <Stepper
        caption="Two Agents racing on one Task"
        steps={STEPS.map((step) => ({
          id: step.id,
          label: step.label,
          detail: <p>{step.detail}</p>,
        }))}
      >
        {(index) => {
          const step = STEPS[index];
          return (
            <div class="race">
              <div class="race-lane">
                <h4>Agent A</h4>
                <code>{step?.a}</code>
              </div>
              <div class="race-store">
                <h4>State Store</h4>
                <code>{step?.db}</code>
              </div>
              <div class={`race-lane${index === 3 ? ' is-failed' : ''}`}>
                <h4>Agent B</h4>
                <code>{step?.b}</code>
              </div>
            </div>
          );
        }}
      </Stepper>

      <Note kind="why">
        Message receive uses the same discipline for a different guarantee. A single write inside a
        short <code>BEGIN IMMEDIATE</code> claims a bounded batch — 50 by default, 500 at most — and
        the same transaction checks the receiving Agent exists and updates its last-seen time. Two
        Agents receiving simultaneously can never get the same row. Because SQLite does not
        guarantee the order of <code>RETURNING</code> rows, they are sorted again before printing.
      </Note>

      <Note kind="limit">
        The Store opens defensively — WAL, foreign keys on, trusted schema off, defensive mode on,
        no extension loading — and the workspace must be on a local disk: WAL’s shared-memory
        sidecar does not work on NFS or SMB.
      </Note>
    </Section>
  );
}
