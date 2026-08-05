import { Note, Section, Stepper } from '../kit';

/**
 * The reviewed Task lifecycle, walked transition by transition. The point the
 * diagram has to make: submitted and completed are different states, reached by
 * different actors, and the database refuses to conflate them.
 */
const STATES = ['queued', 'in_progress', 'submitted', 'completed'] as const;

const STEPS = [
  {
    id: 'create',
    label: 'create',
    active: 'queued',
    actor: 'creator (usually the Manager)',
    detail:
      'Requires an active creator, assignee, and reviewer. Writes the Task at revision 0, appends a created Task Event, and notifies the assignee. All three agents must exist and be active — a Task cannot be addressed to nobody.',
  },
  {
    id: 'start',
    label: 'start',
    active: 'in_progress',
    actor: 'the assignee, and only the assignee',
    detail:
      'Grants a 15-minute Lease. The Lease is a claim that expires on its own, so a crashed Agent cannot hold a Task forever. While in_progress the CHECK matrix requires lease_owner_id and lease_expires_at to be set, and forbids any Submission or Review column from being present.',
  },
  {
    id: 'submit',
    label: 'submit',
    active: 'submitted',
    actor: 'the holder of an unexpired Lease',
    detail:
      'Records the Submission — the Worker’s summary of its result — and notifies the reviewer and the creator. The Lease is released. This is emphatically not completion: the CHECK matrix requires completed_at to still be NULL in this state.',
  },
  {
    id: 'approve',
    label: 'approve',
    active: 'completed',
    actor: 'the reviewer, and only the reviewer',
    detail:
      'Completes the Task and notifies the creator and the assignee. Only an accepting Review moves a Task to completed; a Worker cannot reach this state by any path. The matching Task Event is pinned by CHECK to exactly submitted → completed.',
  },
  {
    id: 'requeue',
    label: 'requeue',
    active: 'queued',
    actor: 'the creator or the reviewer, with a reason',
    detail:
      'Sends work back. A Submission may be requeued by either; an in_progress Task may be recovered only after its Lease has expired. A reason is required, and the assignee plus the other agents involved are notified. This is the loop that makes review meaningful rather than advisory.',
  },
] as const;

export function Lifecycle() {
  return (
    <Section
      title="The reviewed Task lifecycle"
      lede={
        <>
          Five transitions, each permitted to exactly one actor, each incrementing a revision and
          appending an unchangeable Task Event. The rule the whole design turns on:{' '}
          <strong>a Submission is not a completed Task</strong> — only an accepting Review completes
          one. Step through to see who may do what.
        </>
      }
      sources={[
        { path: 'docs/adr/0004-reviewed-task-lifecycle.md', label: 'ADR-0004' },
        { path: 'docs/design/architecture.md', label: 'Architecture §6.3' },
        { path: 'src/store/tasks.ts', label: 'src/store/tasks.ts' },
      ]}
    >
      <Stepper
        caption="Task lifecycle transitions"
        steps={STEPS.map((step) => ({
          id: step.id,
          label: step.label,
          detail: (
            <>
              <p class="actor">
                Permitted actor: <strong>{step.actor}</strong>
              </p>
              <p>{step.detail}</p>
            </>
          ),
        }))}
      >
        {(index) => {
          const active = STEPS[index]?.active;
          return (
            <svg viewBox="0 0 760 200" class="diagram" role="img" aria-label="Task state machine">
              <defs>
                <marker
                  id="arrow"
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto"
                >
                  <path d="M0,0 L8,4 L0,8 z" />
                </marker>
              </defs>

              {STATES.map((state, i) => (
                <g
                  key={state}
                  class={`node ${state === active ? 'node-accent is-selected' : 'node-plain'}`}
                >
                  <rect x={20 + i * 186} y={60} width={150} height={54} rx={8} />
                  <text x={95 + i * 186} y={92}>
                    {state}
                  </text>
                </g>
              ))}

              {[0, 1, 2].map((i) => (
                <path
                  key={`f-${String(i)}`}
                  class={`edge${index === i ? ' is-live' : ''}`}
                  d={`M${String(170 + i * 186)},87 L${String(200 + i * 186)},87`}
                  markerEnd="url(#arrow)"
                />
              ))}
              <text class="edge-label" x="185" y="76">
                start
              </text>
              <text class="edge-label" x="371" y="76">
                submit
              </text>
              <text class="edge-label" x="557" y="76">
                approve
              </text>

              {/* requeue: submitted (and expired in_progress) back to queued */}
              <path
                class={`edge is-dashed${index === 4 ? ' is-live' : ''}`}
                d="M578,114 C520,170 200,170 95,120"
                markerEnd="url(#arrow)"
              />
              <text class={`edge-label${index === 4 ? ' is-live' : ''}`} x="330" y="164">
                requeue (with a reason) · expired Lease recovery
              </text>
            </svg>
          );
        }}
      </Stepper>

      <Note kind="why">
        Roles are not authentication — nothing verifies an Agent is who it says it is. But every
        transition is an update whose conditions check the Task id, the revision, the expected
        status, the acting Agent, and the Lease. It must change exactly one row; matching zero rows
        fails with <code>TASK_CONFLICT</code>, never a vague not-found and never a false success.
        The conditions catch honest mistakes even though they cannot stop a dishonest actor.
      </Note>
    </Section>
  );
}
