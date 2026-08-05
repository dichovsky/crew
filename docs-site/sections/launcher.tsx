import { Note, Section, Stepper } from '../kit';

/**
 * The ten-step launch sequence, plus what the Relay does afterwards. Step 5 is
 * the one worth pausing on: --print stops here, with no side effects at all.
 */
const STEPS = [
  {
    id: 'load',
    label: 'Load config',
    detail:
      'Load and validate the Team, the launcher config, the Task brief, and any command-line overrides. The tracked .crew/launcher.yaml is untrusted input — YAML aliases and custom tags are disabled, and unknown keys fail validation.',
  },
  {
    id: 'resolve',
    label: 'Resolve platform',
    detail:
      'Resolve one Participant CLI from the platform registry and show the exact executable that will run. Config may only name a platform id; it can never supply an arbitrary shell command. A custom executable is accepted only from an explicit flag, and printed for you to confirm.',
  },
  {
    id: 'worktree',
    label: 'Worktree',
    detail:
      'Optionally create or reuse one git worktree shared by the whole Crew. Paths are resolved and checked to stay inside their allowed location; branch and base values are passed to git as plain arguments, never spliced into shell text.',
  },
  {
    id: 'plan',
    label: 'Generate plan',
    detail:
      'Write the plan and its files under .crew/generated/<session>/. This step is pure: the same input always produces exactly the same plan. That determinism is what makes the plan testable before any tmux adapter exists.',
  },
  {
    id: 'print',
    label: '--print stops here',
    detail:
      'With --print, everything stops at this line: no setup, no state changes, no subprocesses, no tmux. Concentrating the safety checks in the pure planning step is what lets --print be genuinely free of side effects rather than merely quiet.',
  },
  {
    id: 'setup',
    label: 'Check setup',
    detail:
      'Verify explicit setup is healthy. crew never silently rewrites a Participant CLI’s configuration files — changing them is always a separate, explicit crew setup action.',
  },
  {
    id: 'panes',
    label: 'Create panes',
    detail:
      'Create the panes, wait until each pane’s known executable is running and showing its readiness pattern, then paste the correct start command for that platform. Readiness is two-stage: the foreground command matches, then the CLI signals it is up.',
  },
  {
    id: 'join',
    label: 'Wait for joins',
    detail:
      'Wait until every Agent in the expanded Team roster has joined. The roster is expanded from replicas — how many copies of a member to start — so the count is known exactly.',
  },
  {
    id: 'relay',
    label: 'Start the Relay',
    detail:
      'Unless --no-relay, start one Relay in its own tmux window. It is an internal node subcommand (crew relay --internal --session <name>), not a shell script, and it ships inside dist/ rather than as a separate packaged file.',
  },
  {
    id: 'attach',
    label: 'Brief and attach',
    detail:
      'Paste the Task brief into the Manager’s pane and attach the terminal to the session, unless --no-attach. Attaching is the one process that must own the terminal in the foreground, which is why runInteractive exists alongside the capture-only runProcess.',
  },
] as const;

export function Launcher() {
  return (
    <Section
      title="Launcher and Relay"
      lede={
        <>
          <code>crew team &lt;name&gt; --launch</code> performs ten steps, and the fifth is a
          deliberate cliff: with <code>--print</code> nothing past it ever runs. Afterwards an
          optional Relay watches for two things and types fixed reminders — it never reads Message
          content and never marks anything read.
        </>
      }
      sources={[
        { path: 'docs/design/architecture.md', label: 'Architecture §7' },
        { path: 'docs/adr/0008-relay-process-model-and-live-launch.md', label: 'ADR-0008' },
        {
          path: 'docs/adr/0007-deterministic-launch-plan-and-print-contract.md',
          label: 'ADR-0007',
        },
        { path: 'docs/adr/0015-per-worker-task-worktrees.md', label: 'ADR-0015' },
      ]}
    >
      <Stepper
        caption="The launch sequence"
        steps={STEPS.map((step) => ({
          id: step.id,
          label: step.label,
          detail: <p>{step.detail}</p>,
        }))}
      >
        {(index) => (
          <ol class="sequence">
            {STEPS.map((step, i) => (
              <li
                key={step.id}
                class={`${i === index ? 'is-current' : i < index ? 'is-done' : 'is-pending'}${
                  step.id === 'print' ? ' is-gate' : ''
                }`}
              >
                <span class="sequence-num">{i + 1}</span>
                <span class="sequence-label">{step.label}</span>
              </li>
            ))}
          </ol>
        )}
      </Stepper>

      <div class="relay-pair">
        <div>
          <h3>Inbox nudge</h3>
          <p>
            Each poll calls the same content-free summary query behind{' '}
            <code>crew pending --summary</code>: the unread count and the highest unread id, nothing
            more. When the Inbox changes — and again at the reminder interval while unread Messages
            remain — it pastes exactly:
          </p>
          <pre>Crew inbox changed. Run: crew receive &lt;agent-id&gt;</pre>
        </div>
        <div>
          <h3>Stale Lease nudge</h3>
          <p>
            A Lease crossing its expiry writes nothing to the database — it is a silent fact. A
            second, fully independent decision function finds those Tasks and pastes into the{' '}
            <strong>creator’s</strong> pane, not the assignee’s:
          </p>
          <pre>
            Task &lt;id&gt;&apos;s Lease is stale. Run: crew task requeue &lt;you&gt; &lt;id&gt;
            --reason &lt;text&gt; (or abandon it).
          </pre>
        </div>
      </div>

      <Note kind="why">
        The Relay must never run <code>receive</code> on an Agent’s behalf. Printing text into a
        terminal does not make a model take a turn, so a watcher that consumed Messages would mark
        the whole Inbox read and pour it into output no model would ever see. Only the target Agent
        consumes its own Inbox.
      </Note>
    </Section>
  );
}
