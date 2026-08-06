import { Note, Section, Stepper } from '../kit';

/**
 * The reviewed Task lifecycle, walked transition by transition. The point the
 * diagram has to make: submitted and completed are different states, reached by
 * different actors, and the database refuses to conflate them.
 *
 * The five statuses of `TaskStatus` split into two shapes, so the diagram draws
 * them differently: four sit on the forward path, and `abandoned` is a terminal
 * off-ramp reachable from any of the three states before completion.
 */
const FLOW_STATES = ['queued', 'in_progress', 'submitted', 'completed'] as const;
const TERMINAL_STATE = 'abandoned';

/**
 * Row geometry. Box i sits at x = 20 + i * 186, so the forward-path centres are
 * 95 / 281 / 467 / 653. The abandon edges rise from the first three of those
 * into a rail above the row; requeue loops back below it. Keeping the two
 * off-path edges on opposite sides of the row is what keeps them from crossing.
 */
const ROW_Y = 136;
/** The x centres of the three states `task abandon` may be called from. */
const ABANDON_FROM_X = [95, 281, 467];
/** The horizontal rail those abandon edges merge into, above the row. */
const RAIL_Y = 100;
/** The x centre of the terminal `abandoned` box. */
const TERMINAL_X = 380;

/** Exported for the drift guard in `lifecycle.test.tsx`, which pins this set
 *  against the `task` subcommands the facts file derives from `src/cli.ts`. */
export const STEPS = [
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
  {
    id: 'abandon',
    label: 'abandon',
    active: TERMINAL_STATE,
    actor: 'the creator or the reviewer, with an optional reason',
    detail:
      'Retires a queued, in_progress, or submitted Task without it ever completing. abandoned is terminal exactly as completed is: there is no un-abandon, and a completed Task cannot be abandoned either. The assignee’s notification is the structured clear_safe Sign-off rather than a courtesy note, because an abandoned Task never merges and no rework is coming — so it is delivered even when the assignee is the one abandoning. Worktree bookkeeping is cleared in the same write. If both the creator and the reviewer have been archived, the plain operator identity may abandon on their behalf.',
  },
] as const;

export function Lifecycle() {
  return (
    <Section
      title="The reviewed Task lifecycle"
      lede={
        <>
          Each transition is permitted only to the actors named on it, increments a revision, and
          appends an unchangeable Task Event. The rule the whole design turns on:{' '}
          <strong>a Submission is not a completed Task</strong> — only an accepting Review completes
          one, and <code>abandoned</code> is the other, terminal way a Task can end. Step through to
          see who may do what.
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
            <svg viewBox="0 0 760 300" class="diagram" role="img" aria-label="Task state machine">
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

              {/* abandon: an off-ramp above the row, merging the three states it
                  may be called from into one rail so the edges never cross. */}
              <g
                class={`node ${TERMINAL_STATE === active ? 'node-accent is-selected' : 'node-plain'}`}
              >
                <rect x={TERMINAL_X - 75} y={20} width={150} height={54} rx={8} />
                <text x={TERMINAL_X} y={52}>
                  {TERMINAL_STATE}
                </text>
              </g>
              {ABANDON_FROM_X.map((x) => (
                <path
                  key={`a-${String(x)}`}
                  class={`edge is-dashed${index === 5 ? ' is-live' : ''}`}
                  d={`M${String(x)},${String(ROW_Y)} L${String(x)},${String(RAIL_Y)}`}
                />
              ))}
              <path
                class={`edge is-dashed${index === 5 ? ' is-live' : ''}`}
                d={`M95,${String(RAIL_Y)} L467,${String(RAIL_Y)}`}
              />
              <path
                class={`edge is-dashed${index === 5 ? ' is-live' : ''}`}
                d={`M${String(TERMINAL_X)},${String(RAIL_Y)} L${String(TERMINAL_X)},76`}
                markerEnd="url(#arrow)"
              />
              <text class={`edge-label${index === 5 ? ' is-live' : ''}`} x="606" y="96">
                abandon · terminal
              </text>

              {FLOW_STATES.map((state, i) => (
                <g
                  key={state}
                  class={`node ${state === active ? 'node-accent is-selected' : 'node-plain'}`}
                >
                  <rect x={20 + i * 186} y={ROW_Y} width={150} height={54} rx={8} />
                  <text x={95 + i * 186} y={ROW_Y + 32}>
                    {state}
                  </text>
                </g>
              ))}

              {[0, 1, 2].map((i) => (
                <path
                  key={`f-${String(i)}`}
                  class={`edge${index === i ? ' is-live' : ''}`}
                  d={`M${String(170 + i * 186)},${String(ROW_Y + 27)} L${String(200 + i * 186)},${String(ROW_Y + 27)}`}
                  markerEnd="url(#arrow)"
                />
              ))}
              {/* Between the abandon rail and the boxes, never level with them —
                  at box height these overlapped the state borders. */}
              <text class="edge-label" x="188" y="124">
                start
              </text>
              <text class="edge-label" x="374" y="124">
                submit
              </text>
              <text class="edge-label" x="560" y="124">
                approve
              </text>

              {/* requeue: submitted (and expired in_progress) back to queued */}
              <path
                class={`edge is-dashed${index === 4 ? ' is-live' : ''}`}
                d="M500,190 C470,254 190,254 110,192"
                markerEnd="url(#arrow)"
              />
              <text class={`edge-label${index === 4 ? ' is-live' : ''}`} x="330" y="268">
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
