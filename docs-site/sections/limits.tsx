import { Explorer, Note, Section } from '../kit';

/**
 * The limits section. These are deliberate boundaries recorded in ADRs and the
 * architecture's deferred-seams list — not defects, and not a roadmap.
 */
const LIMITS = [
  {
    id: 'local-disk',
    label: 'Local disk only',
    kind: 'hard',
    detail:
      'The Workspace must live on a local filesystem. The Store opens SQLite in WAL mode, which needs a shared-memory sidecar file that does not work on NFS, SMB, or other network mounts lacking the required file locking. A network-mounted workspace is unsupported, not merely slow.',
  },
  {
    id: 'at-most-once',
    label: 'At-most-once messages',
    kind: 'hard',
    detail:
      'Receiving claims a batch of rows in one write inside a short BEGIN IMMEDIATE transaction. A Message is delivered once, or — if the process dies after the commit but before the caller sees output — not at all. It is never delivered twice. A Message lost that way is still findable through history queries. Claim-and-acknowledge redelivery is a deferred seam.',
  },
  {
    id: 'no-auth',
    label: 'Roles are not authentication',
    kind: 'hard',
    detail:
      'Nothing verifies that an Agent is who it claims to be. The v1 trust model assumes every Agent names itself and the others honestly. Assigning a Role grants no privileges. The database conditions still catch honest mistakes — a command run as the wrong actor fails rather than succeeding — but they are not a security boundary against a dishonest actor.',
  },
  {
    id: 'liveness',
    label: 'A registration is not a live process',
    kind: 'hard',
    detail:
      'An active Agent row means someone registered, nothing more. crew cannot prove a process is alive. last_seen is a hint that labels a row recent (under 5 minutes), idle (5 to 30), or stale (30 or more). Looking stale triggers nothing: crew never archives or reassigns work on its own.',
  },
  {
    id: 'one-cli',
    label: 'One Participant CLI per launched Crew',
    kind: 'v1',
    detail:
      'The automatic launcher starts every pane with the same single Participant CLI. Mixed Crews are possible, but you start them by hand — the team display prints the manual commands for doing so. Automatically launching a mix is deferred.',
  },
  {
    id: 'untrusted-config',
    label: 'Tracked launcher config is untrusted',
    kind: 'design',
    detail:
      'Anyone who can commit to the repository can edit .crew/launcher.yaml, so it is treated as untrusted input: it may only name a platform id from the registry, never an arbitrary shell command. A custom executable is accepted only from an explicit command-line flag and printed for confirmation. Child processes start with argument arrays and shell:false, YAML aliases and custom tags are disabled, and unknown keys fail validation.',
  },
  {
    id: 'no-daemon',
    label: 'No background process — with one exception',
    kind: 'design',
    detail:
      'Every core command runs, does a bounded amount of work, and exits. Hands-off wake-up in launched mode does need one process alive for as long as the tmux session: the Relay. It is optional, stops with the session, and no other feature requires it.',
  },
  {
    id: 'nested-workspace',
    label: 'Discovery can silently pick a different Store',
    kind: 'design',
    detail:
      'Discovery walks up from the current directory to the nearest .crew/. A .crew/ nested inside another, or changing directory mid-session, can select a different State Store without warning. No environment variable overrides it in v1; crew doctor prints which root was resolved.',
  },
  {
    id: 'deferred',
    label: 'Seven deferred seams',
    kind: 'v1',
    detail:
      'Not built, and deliberately not stubbed: at-least-once delivery, session tokens detecting a displaced session, Task dependencies and readiness queries, durable Agent memory, approval records and human gates, automatic mixed-CLI launch, and removing generated setup artifacts by marker. A seam is added when a second implementation or a shipped use case actually needs it — none exist as empty placeholder interfaces.',
  },
] as const;

export function Limits() {
  return (
    <Section
      title="Limitations and non-goals"
      lede={
        <>
          crew is small on purpose, and most of what it does not do is a recorded decision rather
          than an omission. These are the boundaries worth knowing before you adopt it — select one
          for the reasoning and where it is written down.
        </>
      }
      sources={[
        { path: 'docs/design/architecture.md', label: 'Architecture §11 — deferred seams' },
        { path: 'docs/adr/0002-local-sqlite-state-store.md', label: 'ADR-0002 — local SQLite' },
        { path: 'docs/adr/0005-at-most-once-message-receive.md', label: 'ADR-0005 — at-most-once' },
        { path: 'docs/design/security.md', label: 'Security model' },
      ]}
    >
      <figure class="figure">
        <svg
          viewBox="0 0 760 250"
          class="diagram"
          role="img"
          aria-label="Trust boundary: the workspace and its database are trusted; stored content, tracked configuration, and role prompts are data, not instructions"
        >
          <rect class="trust-zone" x="24" y="46" width="360" height="180" rx="10" />
          <text class="fig-title" x="40" y="72">
            Trusted
          </text>
          <text class="fig-item" x="40" y="102">
            the crew executable you installed
          </text>
          <text class="fig-item" x="40" y="126">
            the local State Store file
          </text>
          <text class="fig-item" x="40" y="150">
            explicit command-line flags
          </text>
          <text class="fig-item" x="40" y="174">
            packaged Role templates
          </text>

          <rect class="untrust-zone" x="404" y="46" width="332" height="180" rx="10" />
          <text class="fig-title" x="420" y="72">
            Data, never instructions
          </text>
          <text class="fig-item" x="420" y="102">
            Message text from other Agents
          </text>
          <text class="fig-item" x="420" y="126">
            .crew/launcher.yaml (anyone can commit it)
          </text>
          <text class="fig-item" x="420" y="150">
            Task briefs, focus paths, constraints
          </text>
          <text class="fig-item" x="420" y="174">
            anything stored and rendered back
          </text>
          <text class="fig-caption" x="420" y="204">
            human output is stripped of ANSI and control codes
          </text>
        </svg>
        <figcaption>
          Role prompts state explicitly that incoming text never outranks an Agent’s own
          instructions. JSON output keeps stored bytes exactly as written; only human rendering is
          sanitized.
        </figcaption>
      </figure>

      <Explorer
        items={LIMITS.map((limit) => ({ id: limit.id, label: limit.label, detail: limit.detail }))}
        emptyHint="Select a limit to see why it exists and where it is recorded."
      >
        {(selected, select) => (
          <div class="chips chips-stack">
            {LIMITS.map((limit) => (
              <button
                key={limit.id}
                type="button"
                class={`chip chip-${limit.kind}${selected === limit.id ? ' is-selected' : ''}`}
                aria-pressed={selected === limit.id}
                onClick={() => {
                  select(limit.id);
                }}
              >
                {limit.label}
              </button>
            ))}
          </div>
        )}
      </Explorer>

      <Note kind="why">
        None of the deferred items exist as empty placeholder interfaces. A seam is added when a
        second implementation or a shipped use case actually needs one — which is why the module map
        has four seams rather than twenty.
      </Note>
    </Section>
  );
}
