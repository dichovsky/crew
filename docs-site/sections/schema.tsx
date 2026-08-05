import { facts } from '../facts';
import { Explorer, Note, Section } from '../kit';

/**
 * The State Store schema. Table names and the version come from facts.json;
 * the prose below explains what each table guarantees. TABLE_DOCS must cover
 * every table the schema declares — docs-site/sections/schema.test.ts enforces it.
 */
export const TABLE_DOCS: Record<string, { summary: string; invariants: readonly string[] }> = {
  agents: {
    summary:
      'One row per Agent registration: id, Role, optional platform, join and last-seen times, lifecycle status, and an optional launch token proving which launched session created it.',
    invariants: [
      'status is exactly one of active or archived',
      'last_seen can never precede joined_at',
      'active rows have no archived_at; archived rows must have one, at or after joined_at',
      'an id stays reserved once used, so archived work can be resumed deliberately',
    ],
  },
  tasks: {
    summary:
      'The reviewed unit of work, carrying its creator, assignee, and reviewer, a revision counter, the Lease, the Submission, the Review, and any per-Task worktree.',
    invariants: [
      'status is one of queued, in_progress, submitted, completed, abandoned',
      'a per-status CHECK matrix decides which columns may be set in each state — a Lease exists only while in_progress, a Submission only from submitted onward',
      'worktree path, branch, and base ref are all set together or all NULL',
      'revision only ever increases; updated_at can never precede created_at',
    ],
  },
  messages: {
    summary:
      'Durable notes addressed to one Agent. Consumed by marking read_at, never deleted on receipt, so history survives delivery.',
    invariants: [
      'kind is one of note, task_assigned, task_submitted, task_approved, task_requeued, clear_safe',
      'every kind except note must reference a task_id',
      'read_at can never precede created_at',
      'deleting a Task cascades to its Messages; a deleted reply target becomes NULL rather than dangling',
    ],
  },
  task_events: {
    summary:
      'The append-only history of Task transitions: which revision, what kind of transition, who acted, and the exact status it moved from and to.',
    invariants: [
      'UNIQUE (task_id, revision) — one event per revision, so a transition cannot be recorded twice',
      'a CHECK matrix pins each event_type to its only legal from/to pair: approved is always submitted → completed, and nothing else can claim to be',
      'created is always revision 0, from NULL, to queued',
      'rows are never updated once written',
    ],
  },
  review_worktrees: {
    summary:
      'The persistent Worktree owned by one Inspector, reused across Reviews by switching branches instead of getting a fresh copy each time.',
    invariants: [
      'one row per Agent (agent_id is the primary key)',
      'path and base_ref are always present; current_ref is set once a branch is checked out',
      'updated_at can never precede created_at',
    ],
  },
  agent_mutations: {
    summary:
      'A single-row cursor the Console polls to notice Agent-roster changes without re-reading every row.',
    invariants: ['exactly one row, id = 1', 'cursor only ever moves forward and is at least 1'],
  },
  observable_mutations: {
    summary:
      'The same idea for everything else the Console observes — Tasks, Messages, and events — so a poll can cheaply detect that something changed.',
    invariants: ['exactly one row, id = 1', 'cursor only ever moves forward and is at least 1'],
  },
};

export function Schema() {
  const { version, tables } = facts.schema;

  return (
    <Section
      title="The State Store"
      lede={
        <>
          Schema version <strong>{version}</strong>, <strong>{tables.length}</strong> tables, all
          declared <code>STRICT</code>. The rules that must always hold are enforced by the database
          itself through <code>CHECK</code> constraints — not merely by the code that writes to it.
          Select a table to see what it guarantees.
        </>
      }
      sources={[
        { path: 'src/store/schema.ts', label: 'src/store/schema.ts — the released SQL' },
        { path: 'docs/design/data-model.md', label: 'Data model' },
        { path: 'docs/adr/0002-local-sqlite-state-store.md', label: 'ADR-0002' },
      ]}
    >
      <Explorer
        items={tables.map((table) => {
          const doc = TABLE_DOCS[table];
          return {
            id: table,
            label: table,
            detail:
              doc === undefined ? (
                <p>Undocumented table — schema.test.ts should have caught this.</p>
              ) : (
                <>
                  <p>{doc.summary}</p>
                  <h4>Always true</h4>
                  <ul class="invariants">
                    {doc.invariants.map((rule) => (
                      <li key={rule}>{rule}</li>
                    ))}
                  </ul>
                </>
              ),
          };
        })}
        emptyHint="Select a table to see the constraints the database enforces on it."
      >
        {(selected, select) => (
          <div class="tables">
            {tables.map((table) => (
              <button
                key={table}
                type="button"
                class={`table-card${selected === table ? ' is-selected' : ''}`}
                aria-pressed={selected === table}
                onClick={() => {
                  select(table);
                }}
              >
                <span class="table-name">{table}</span>
                <span class="table-count">{TABLE_DOCS[table]?.invariants.length ?? 0} rules</span>
              </button>
            ))}
          </div>
        )}
      </Explorer>

      <Note kind="why">
        On every open, <code>assertCurrentSchema</code> canonicalizes the live schema and compares
        it against the released SQL. A database whose schema is newer than the installed crew
        understands is refused with <code>UNSUPPORTED_SCHEMA</code> — never opened for writing with
        only a warning. Whether a column exists is answered by SQLite’s own metadata, never by
        matching error-message text.
      </Note>
    </Section>
  );
}
