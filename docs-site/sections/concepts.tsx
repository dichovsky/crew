import { Explorer, Note, Section } from '../kit';

/**
 * The binding vocabulary from CONTEXT.md. Each term is used with exactly one
 * meaning across the requirements, the architecture, the commands, and the
 * tests — so the glossary is a real interface, not background reading.
 */
const TERMS = [
  {
    id: 'crew',
    label: 'Crew',
    group: 'Collaboration',
    detail:
      'Every Agent registration sharing one Workspace’s State Store — all the agents coordinating through the same local database. Not a cluster or a swarm.',
  },
  {
    id: 'agent',
    label: 'Agent',
    group: 'Collaboration',
    detail:
      'A named registration standing for one actor in a Crew, usually one AI CLI session in a terminal. A registration is not proof that a process is alive.',
  },
  {
    id: 'operator',
    label: 'Operator',
    group: 'Collaboration',
    detail:
      'The human. In the database the Operator is an ordinary Agent row named “operator” with no platform, under the same rules as every other Agent — not a privileged identity.',
  },
  {
    id: 'participant',
    label: 'Participant CLI',
    group: 'Collaboration',
    detail:
      'An AI application that can run shell commands and takes part as an Agent by running crew commands itself.',
  },
  {
    id: 'role',
    label: 'Role',
    group: 'Collaboration',
    detail:
      'A behavioral prompt assigned to an Agent — instructions on how to act. Assigning a Role grants no privileges whatsoever.',
  },
  {
    id: 'team',
    label: 'Team',
    group: 'Collaboration',
    detail:
      'A roster template kept under version control, declaring which Agent ids exist and which Role each one has.',
  },
  {
    id: 'manager',
    label: 'Manager',
    group: 'Roles',
    detail:
      'The built-in Role that breaks goals into Tasks, assigns each Task and its reviewers, and watches Reviews.',
  },
  {
    id: 'worker',
    label: 'Worker',
    group: 'Roles',
    detail: 'The built-in Role that starts a Task and produces a Submission.',
  },
  {
    id: 'inspector',
    label: 'Inspector',
    group: 'Roles',
    detail: 'The built-in Role that either accepts a Submission or sends its Task back for rework.',
  },
  {
    id: 'task',
    label: 'Task',
    group: 'Work',
    detail:
      'A unit of assigned work, stored durably, moving through a lifecycle that includes a review step.',
  },
  {
    id: 'lease',
    label: 'Lease',
    group: 'Work',
    detail:
      'A claim an Agent holds while a Task is in progress. It expires on its own, so a crashed Agent cannot hold a Task forever. Not a lock.',
  },
  {
    id: 'submission',
    label: 'Submission',
    group: 'Work',
    detail:
      'A Worker’s summary of its result, waiting for a Review. A Submission is not a completed Task.',
  },
  {
    id: 'review',
    label: 'Review',
    group: 'Work',
    detail:
      'An Inspector’s decision that either completes a submitted Task or returns it to the queue for more work.',
  },
  {
    id: 'task-event',
    label: 'Task Event',
    group: 'Work',
    detail:
      'A record of one Task transition and the actor who caused it. Once written it is never changed.',
  },
  {
    id: 'message',
    label: 'Message',
    group: 'Runtime',
    detail:
      'A durable note addressed to one Agent, consumed — read and removed — from that Agent’s Inbox.',
  },
  {
    id: 'signoff',
    label: 'Sign-off',
    group: 'Runtime',
    detail:
      'A structured clear_safe Message confirming a Task fully landed: reviewed, approved, merged if there was anything to merge, worktree cleaned up, no rework coming. It is the signal a Worker’s conversation context is safe to reset. Only task land creates one (plus task abandon for the assignee); a hand-typed note with the same wording is advice, not a Sign-off.',
  },
  {
    id: 'inbox',
    label: 'Inbox',
    group: 'Runtime',
    detail: 'The Messages addressed to one Agent that it has not read yet.',
  },
  {
    id: 'workspace',
    label: 'Workspace',
    group: 'Runtime',
    detail:
      'The directory crew works in: starting from the current directory and walking upward, the nearest one containing a .crew/ directory.',
  },
  {
    id: 'state-store',
    label: 'State Store',
    group: 'Runtime',
    detail:
      'The SQLite database at .crew/state/crew.db. Every Agent in a Crew shares this one file. Not a server, not a message bus.',
  },
  {
    id: 'worktree',
    label: 'Worktree',
    group: 'Runtime',
    detail:
      'A separate working copy of the git repository, managed by crew on its own branch, keeping one Task’s — or one launched Crew’s — changes apart from the Workspace.',
  },
] as const;

const GROUPS = ['Collaboration', 'Roles', 'Work', 'Runtime'] as const;

export function Concepts() {
  return (
    <Section
      title="Concepts and vocabulary"
      lede={
        <>
          These twenty terms are binding. Each one is used with exactly the meaning below across the
          requirements, the architecture, the commands, and the tests — so reading them is the
          fastest way to understand everything else. Select a term to see its definition.
        </>
      }
      sources={[{ path: 'CONTEXT.md', label: 'CONTEXT.md — the domain vocabulary' }]}
    >
      <Explorer
        items={TERMS.map((term) => ({ id: term.id, label: term.label, detail: term.detail }))}
        emptyHint="Select any term to read its exact definition."
      >
        {(selected, select) => (
          <div class="glossary">
            {GROUPS.map((group) => (
              <div key={group} class="glossary-group">
                <h3>{group}</h3>
                <div class="chips">
                  {TERMS.filter((term) => term.group === group).map((term) => (
                    <button
                      key={term.id}
                      type="button"
                      class={`chip${selected === term.id ? ' is-selected' : ''}`}
                      aria-pressed={selected === term.id}
                      onClick={() => {
                        select(term.id);
                      }}
                    >
                      {term.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Explorer>

      <Note kind="why">
        The vocabulary exists to stop two words meaning the same thing. A Worker produces a{' '}
        <em>Submission</em>; only an Inspector’s <em>Review</em> <em>completes</em> a Task. Conflate
        those and the reviewed workflow stops meaning anything.
      </Note>
    </Section>
  );
}
