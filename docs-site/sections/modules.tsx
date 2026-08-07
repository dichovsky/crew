import { facts } from '../facts';
import { ArrowDefs, Explorer, Note, NodeBox, Section } from '../kit';

/**
 * The architecture diagram: what a command actually touches, from the agent
 * session that types it through to the SQLite file, the tmux session, or the
 * browser dashboard.
 *
 * The edges mirror the flowchart in README.md, which is where crew records how
 * these parts connect. The agent row is driven from the registry rather than
 * being a fixed list, so it cannot fall behind when an engine lands.
 */
interface ArchNode {
  readonly id: string;
  readonly label: string;
  readonly sub?: string;
  readonly seam?: boolean;
  readonly detail: string;
}

const NODES: readonly ArchNode[] = [
  {
    id: 'sessions',
    label: 'Agent sessions',
    detail:
      'Independent terminal sessions, each running its own AI CLI. They are not started by crew in manual mode and they never talk to each other directly — every interaction goes through a crew command and the shared State Store. Coordination is the only thing crew provides; it never contacts a model provider itself.',
  },
  {
    id: 'bin',
    label: 'bin/crew',
    sub: 'Node floor check',
    detail:
      'The installed executable shim. It asserts the Node floor BEFORE importing the application graph, then dynamically imports run(). The ordering is load-bearing: ES modules evaluate static imports before any module body, and the graph imports node:sqlite, so a static import would make a too-old runtime fail with an opaque linking error instead of the clear floor message. Do not convert that dynamic import to a static one.',
  },
  {
    id: 'program',
    label: 'Program',
    sub: 'run(argv, io)',
    seam: true,
    detail:
      'The single entry point for argument parsing, output mode, and errors. It drives commander and maps every outcome to an exit code, and it never calls process.exit — the shim sets process.exitCode so Node can drain buffered stdout, such as piped NDJSON. Seam 1: this is how commands are tested in-process. It builds two commander programs from one registration — the live program and a silent validator — so help is honored only when the surrounding command is otherwise valid.',
  },
  {
    id: 'io',
    label: 'Io + process',
    sub: 'injected environment',
    seam: true,
    detail:
      'cwd, env, stdin, stdout, stderr, and clock — the single source of “now” for an operation. Seam 4: runProcess is capture-only with shell:false, and runInteractive owns the terminal in the foreground for the one process that must (tmux attach). Real implementations on one side, a recording fake on the other, which is what makes it a genuine seam rather than an abstraction. Tests pass the working directory in through here instead of changing the process’s global cwd.',
  },
  {
    id: 'commands',
    label: 'Commands',
    sub: 'thin handlers',
    detail:
      'Validate input, call a deeper module, render output. No SQL, no hard-coded platform paths. If a handler starts accumulating rules, they belong deeper — that is the whole reason the modules below it are shaped the way they are.',
  },
  {
    id: 'format',
    label: 'Format',
    sub: 'human + JSON',
    detail:
      'Renders records for humans or as NDJSON — one complete JSON object per line. Human output is run through sanitizeHuman, which strips ANSI and control sequences so stored content cannot manipulate your terminal. JSON output keeps raw bytes and never rewrites stored content. Both surfaces are first-class contracts and are kept in sync.',
  },
  {
    id: 'workspace',
    label: 'Workspace',
    sub: '.crew/ discovery',
    detail:
      'Finds or initializes .crew/ by walking up the directory tree, derives every path, maintains the git-ignore file, and keeps every write inside the workspace. init never git-ignores the whole .crew/ directory and never writes to your home directory. No command re-invents filesystem policy on its own.',
  },
  {
    id: 'roles-teams',
    label: 'Roles / Teams',
    sub: 'validated YAML',
    detail:
      'Roles resolve, list, and export a behavioral prompt — packaged templates ship with crew, and project files take precedence over them. Teams resolve and render a roster template: safe YAML parsing, schema validation, and expanding replicas (how many copies of a member to start). Neither grants any privilege; a Role is instructions, not permissions.',
  },
  {
    id: 'store',
    label: 'Store',
    sub: 'only node:sqlite',
    seam: true,
    detail:
      'The only module that imports node:sqlite. It owns the schema, migrations, SQL, transactions, and retries, and exposes named domain operations — joinAgent, submitTask, receiveMessages — never generic CRUD. Seam 2: this is how persistence is tested. Keeping the always-true rules behind one boundary is what stops SQL coordination leaking into command handlers.',
  },
  {
    id: 'platforms',
    label: 'Platforms',
    sub: '+ Setup',
    seam: true,
    detail:
      'The authoritative Setup Target registry: canonical paths, executable names, version probes, readiness signals, and permission guidance. Setup installs or inspects one target, writing to global and project paths outside .crew/ behind guard checks. Seam 3: this is where a third-party integration plugs in. The registry replaced four separate copies of the same path tables — setup, launch, display, and doctor all read it (ADR-0006).',
  },
  {
    id: 'launcher',
    label: 'Launcher',
    sub: 'plan → tmux',
    detail:
      'Shows a launch plan or creates a tmux session: resolves worktrees, maps panes, waits for readiness, injects prompts, cleans up. Turning configuration into a plan is a pure step — the same input always produces exactly the same plan — which is what makes --print genuinely free of side effects and lets the plan be tested before any tmux adapter exists.',
  },
  {
    id: 'console',
    label: 'Console',
    sub: 'crew ui',
    detail:
      'The optional browser dashboard: six views, bounded non-consuming Store snapshots, and Operator actions with no authority beyond what the Store already allows. A foreground HTTP/SSE server, never a background process. Page assets are bundled at build time so it works offline.',
  },
  {
    id: 'db',
    label: 'State Store',
    sub: 'SQLite · WAL · STRICT',
    detail:
      '.crew/state/crew.db — the one file every Agent in a Crew shares. Opened defensively: WAL, synchronous NORMAL, foreign keys on, trusted schema off, defensive mode on, no extension loading, with a 5-second busy timeout and one bounded retry before returning CONTENTION. WAL needs a shared-memory sidecar, which is why the workspace must be on a local disk — NFS and SMB are unsupported.',
  },
  {
    id: 'tmux',
    label: 'tmux session',
    sub: 'panes + relay window',
    detail:
      'One pane per Agent plus a crew-relay window. Created only in launched mode, torn down only if crew owns the session. The Relay running in that window is an internal node subcommand, not a shell script, and it stops when the session ends.',
  },
  {
    id: 'browser',
    label: 'Browser dashboard',
    sub: 'loopback · token · SSE',
    detail:
      'Reachable only from your own computer, guarded by a per-run token that rides in the page URL, with live updates over server-sent events. You start it explicitly with crew ui; it never becomes a background process, and no other feature depends on it.',
  },
];

/** The seven modules a command handler fans out to, left to right. */
const FANOUT = ['format', 'workspace', 'roles-teams', 'store', 'platforms', 'launcher', 'console'];
const FAN_W = 104;
const FAN_Y = 316;
const fanX = (i: number): number => 22 + i * 112;
const fanCx = (i: number): number => fanX(i) + FAN_W / 2;

const OUTPUTS: { id: string; x: number; from: string }[] = [
  { id: 'db', x: 180, from: 'store' },
  { id: 'tmux', x: 350, from: 'launcher' },
  { id: 'browser', x: 520, from: 'console' },
];

function node(id: string) {
  return NODES.find((entry) => entry.id === id);
}

export function Modules() {
  const participants = facts.registry.participants;

  return (
    <Section
      title="Architecture"
      lede={
        <>
          What a single crew command actually touches, from the terminal session that types it
          through to the SQLite file, the tmux session, or the browser dashboard. Four of these
          boxes are <strong>seams</strong> — boundaries where a part can be swapped out or tested on
          its own — and crew keeps them deliberately few. Select any box to see what it owns.
        </>
      }
      sources={[
        { path: 'docs/design/architecture.md', label: 'Architecture §3 — module map' },
        { path: 'README.md', label: 'README — architecture flowchart' },
        { path: 'src/run.ts', label: 'src/run.ts — the Program seam' },
        { path: 'src/store/index.ts', label: 'src/store/index.ts — the Store seam' },
      ]}
    >
      <Explorer
        items={NODES.map((entry) => ({
          id: entry.id,
          label: entry.sub === undefined ? entry.label : `${entry.label} — ${entry.sub}`,
          detail: entry.detail,
        }))}
        emptyHint="Select a box. The four marked with a dot are the seams."
      >
        {(selected, select) => (
          <svg
            viewBox="0 0 820 512"
            class="diagram"
            role="img"
            aria-label="crew architecture: agent sessions call the crew CLI, which fans out from thin command handlers to the Store, Launcher, Console and supporting modules, producing the SQLite state store, a tmux session, or the browser dashboard"
          >
            <ArrowDefs />

            {/* Agent sessions, driven from the registry so the row cannot go stale. */}
            <g
              class={`node node-plain${selected === 'sessions' ? ' is-selected' : ''}`}
              role="button"
              tabIndex={0}
              aria-pressed={selected === 'sessions'}
              aria-label="Independent terminal agent sessions"
              onClick={() => {
                select('sessions');
              }}
              onKeyDown={(event: KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  select('sessions');
                }
              }}
            >
              <rect x={20} y={8} width={760} height={64} rx={10} />
              <text class="group-title" x={30} y={25}>
                Independent terminal agent sessions
              </text>
            </g>
            {participants.map((participant, i) => (
              <g key={participant.id} class="chip-node">
                <rect x={30 + i * 92} y={34} width={86} height={28} rx={6} />
                <text x={30 + i * 92 + 43} y={52}>
                  {participant.id}
                </text>
              </g>
            ))}

            <path class="edge" d="M410,72 L410,94" marker-end="url(#arrow)" />
            <text class="edge-label edge-label-left" x="422" y="88">
              crew join / send / receive / task …
            </text>

            <NodeBox
              x={330}
              y={96}
              w={160}
              h={44}
              id="bin"
              label="bin/crew"
              sub="Node floor check"
              selected={selected}
              onSelect={select}
            />
            <path class="edge" d="M410,140 L410,162" marker-end="url(#arrow)" />

            <NodeBox
              x={330}
              y={164}
              w={160}
              h={44}
              id="program"
              label="Program"
              sub="run(argv, io)"
              tone="accent"
              selected={selected}
              onSelect={select}
            />

            {/* The injected environment is a peer, not a dependency of Program. */}
            <NodeBox
              x={556}
              y={164}
              w={140}
              h={44}
              id="io"
              label="Io + process"
              sub="injected"
              tone="accent"
              selected={selected}
              onSelect={select}
            />
            <path class="edge is-dashed" d="M554,186 L492,186" marker-end="url(#arrow)" />

            <path class="edge" d="M410,208 L410,230" marker-end="url(#arrow)" />
            <NodeBox
              x={330}
              y={232}
              w={160}
              h={44}
              id="commands"
              label="Commands"
              sub="thin handlers"
              selected={selected}
              onSelect={select}
            />

            {/* Fan-out bus: one handler calls exactly one deeper module. */}
            <path class="edge" d="M410,276 L410,294" />
            <path class="edge" d={`M${String(fanCx(0))},294 L${String(fanCx(6))},294`} />
            {FANOUT.map((id, i) => (
              <path
                key={`tick-${id}`}
                class="edge"
                d={`M${String(fanCx(i))},294 L${String(fanCx(i))},314`}
                marker-end="url(#arrow)"
              />
            ))}

            {FANOUT.map((id, i) => {
              const entry = node(id);
              return entry === undefined ? null : (
                <NodeBox
                  key={id}
                  x={fanX(i)}
                  y={FAN_Y}
                  w={FAN_W}
                  h={56}
                  id={id}
                  label={entry.label}
                  {...(entry.sub !== undefined ? { sub: entry.sub } : {})}
                  tone={entry.seam === true ? 'accent' : 'plain'}
                  selected={selected}
                  onSelect={select}
                />
              );
            })}

            {/* Outputs, each produced by exactly one module above it. */}
            {OUTPUTS.map((output) => {
              const entry = node(output.id);
              const fromCx = fanCx(FANOUT.indexOf(output.from));
              return entry === undefined ? null : (
                <g key={output.id}>
                  <path
                    class="edge"
                    d={`M${String(fromCx - 8)},${String(FAN_Y + 56)} L${String(output.x + 82)},426`}
                    marker-end="url(#arrow)"
                  />
                  <NodeBox
                    x={output.x}
                    y={430}
                    w={150}
                    h={52}
                    id={output.id}
                    label={entry.label}
                    {...(entry.sub !== undefined ? { sub: entry.sub } : {})}
                    selected={selected}
                    onSelect={select}
                  />
                </g>
              );
            })}

            {/* tmux runs the very sessions the diagram starts from. */}
            <path
              class="edge is-dashed"
              d="M425,482 L425,494 Q425,502 437,502 L798,502 Q812,502 812,490 L812,54 Q812,40 798,40 L788,40"
              marker-end="url(#arrow)"
            />
            <text class="edge-label" x="620" y="497">
              each pane runs an agent CLI
            </text>

            {/* Seam markers: Program, Io, Store, Platforms — and nothing else. */}
            <circle class="seam-dot" cx={478} cy={174} r={4.5} />
            <circle class="seam-dot" cx={684} cy={174} r={4.5} />
            <circle class="seam-dot" cx={fanCx(3) + 42} cy={326} r={4.5} />
            <circle class="seam-dot" cx={fanCx(4) + 42} cy={326} r={4.5} />
          </svg>
        )}
      </Explorer>

      <Note kind="why">
        Every core command follows one path down this diagram and then exits — it opens the State
        Store, does a bounded amount of work, prints, closes, and stops. Nothing stays running, and
        any command can safely be run again on its own.
      </Note>

      <Note kind="limit">
        Wrapping each SQL statement in its own public function would create many thin modules and
        spread the rules that must always hold across every caller. The Store may have internal
        files for Agents, Messages, Tasks, and migrations — but it exposes exactly one domain
        interface.
      </Note>
    </Section>
  );
}
