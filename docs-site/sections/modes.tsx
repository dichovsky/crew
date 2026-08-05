import { Note, Section, Stepper } from '../kit';

/**
 * The two operating modes, walked stage by stage. Both drive the same Store; the
 * only difference is who opens the terminals and who nudges an idle pane.
 */
const STAGES = [
  {
    id: 'init',
    label: 'Initialize',
    manual: 'crew init creates .crew/ with roles/, teams/, and an ignored state/ directory.',
    launched: 'Identical — a launched Crew still needs an initialized Workspace first.',
    detail:
      'Both modes begin the same way. `crew init` writes the workspace, tracks config (roles/, teams/), and git-ignores only the mutable parts (state/, generated/). It never writes to your home directory — changing a Participant CLI’s global configuration is a separate, explicit `crew setup`.',
  },
  {
    id: 'open',
    label: 'Open sessions',
    manual: 'You open each terminal yourself and start Claude Code, Codex, or another CLI by hand.',
    launched:
      'crew team <name> --launch builds a tmux session, one pane per roster member, and waits for each pane’s executable to signal readiness.',
    detail:
      'This is the first real difference. In manual mode nothing about your terminals is crew’s business. In launched mode the Launcher resolves one Participant CLI from the registry, creates the panes, waits for two-stage readiness, and pastes the right start command for that platform.',
  },
  {
    id: 'join',
    label: 'Register',
    manual: 'Each session runs crew join <id> --role <role> itself.',
    launched: 'The Launcher waits until every Agent in the expanded roster has joined.',
    detail:
      'An Agent is a database registration, nothing more. It does not prove a process exists, and crew never infers liveness from it — `last_seen` is a hint that labels a row recent, idle, or stale, and looking stale triggers nothing automatically.',
  },
  {
    id: 'work',
    label: 'Coordinate',
    manual: 'You prompt each session; it runs crew send, crew receive, crew task ... on its own.',
    launched:
      'Same commands — plus an optional Relay that watches the content-free inbox summary and nudges an idle pane.',
    detail:
      'The Relay never reads Message content and never marks anything read. It polls a summary — the unread count and the highest unread id — and pastes a fixed reminder into the pane: “Crew inbox changed. Run: crew receive <agent-id>”. Only the target Agent ever consumes its own Inbox.',
  },
  {
    id: 'finish',
    label: 'Finish',
    manual: 'Sessions leave; the Store keeps the Messages, Tasks, and history.',
    launched:
      'The Relay stops when the session ends. Teardown removes only a session crew itself owns.',
    detail:
      'Leaving changes only lifecycle status and archived_at; last_seen, Messages, Tasks, and history all remain. Nothing keeps running afterwards in either mode.',
  },
] as const;

export function Modes() {
  return (
    <Section
      title="Manual and launched mode"
      lede={
        <>
          crew has exactly two operating modes, and they differ in one respect only: who opens the
          terminals and who nudges an idle one. Both drive the same commands against the same State
          Store. Step through a session to see where they diverge.
        </>
      }
      sources={[
        { path: 'docs/design/architecture.md', label: 'Architecture §1 and §7' },
        {
          path: 'docs/adr/0008-relay-process-model-and-live-launch.md',
          label: 'ADR-0008 — relay process model',
        },
        { path: 'EXAMPLES.md', label: 'EXAMPLES.md — worked sessions' },
      ]}
    >
      <Stepper
        caption="A session in manual and launched mode"
        steps={STAGES.map((stage) => ({
          id: stage.id,
          label: stage.label,
          detail: <p>{stage.detail}</p>,
        }))}
      >
        {(index) => (
          <div class="modes">
            {(['manual', 'launched'] as const).map((mode) => (
              <div key={mode} class={`modes-column modes-${mode}`}>
                <h3>{mode === 'manual' ? 'Manual mode' : 'Launched mode'}</h3>
                <ol>
                  {STAGES.map((stage, i) => (
                    <li
                      key={stage.id}
                      class={i === index ? 'is-current' : i < index ? 'is-done' : 'is-pending'}
                    >
                      <span class="modes-stage">{stage.label}</span>
                      <span class="modes-body">
                        {mode === 'manual' ? stage.manual : stage.launched}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}
      </Stepper>

      <Note kind="limit">
        Launched mode is the only place crew keeps a process alive, and only for as long as the tmux
        session lives. The core commands leave nothing running: each one opens the database, does a
        bounded amount of work, prints, and exits. There is no daemon, no account, and no cloud
        service anywhere in either mode.
      </Note>
    </Section>
  );
}
