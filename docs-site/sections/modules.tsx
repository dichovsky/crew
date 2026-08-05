import { ArrowDefs, Explorer, Note, NodeBox, Section } from '../kit';

/**
 * The module map. Twelve modules in four layers, with the four seams marked —
 * the boundaries where a part can be swapped out or tested on its own.
 */
const MODULES = [
  {
    id: 'program',
    label: 'Program',
    sub: 'src/run.ts',
    seam: true,
    detail:
      'run(argv, io) is the single entry point for argument parsing, output mode, and errors. It drives commander and maps every outcome to an exit code, and it never calls process.exit — the bin shim sets process.exitCode so Node can drain buffered stdout. Seam 1: this is how commands are tested in-process.',
  },
  {
    id: 'commands',
    label: 'Commands',
    sub: 'agents · init · roles · teams',
    detail:
      'Thin handlers: validate input, call a deeper module, render output. No SQL, no hard-coded platform paths. If a handler starts to grow rules, they belong deeper.',
  },
  {
    id: 'workspace',
    label: 'Workspace',
    sub: 'src/workspace.ts',
    detail:
      'Finds or initializes .crew/ by walking up the directory tree, derives every path, maintains the git-ignore file, and keeps every write inside the workspace. No command re-invents filesystem policy on its own.',
  },
  {
    id: 'roles',
    label: 'Roles',
    sub: 'src/roles.ts',
    detail:
      'Resolves, lists, and exports a Role. Packaged templates ship with crew; project files take precedence over them.',
  },
  {
    id: 'teams',
    label: 'Teams',
    sub: 'src/teams.ts',
    detail:
      'Resolves, lists, and renders a Team: safe YAML parsing, schema validation, and expanding replicas — how many copies of a roster member to start.',
  },
  {
    id: 'platforms',
    label: 'Platforms',
    sub: 'src/platforms/',
    seam: true,
    detail:
      'The authoritative Setup Target registry: canonical paths, executable names, version probes, readiness signals, and permission guidance. Seam 3: this is where a third-party integration plugs in. It replaced four separate copies of the same path tables — setup, launch, display, and doctor all read it (ADR-0006).',
  },
  {
    id: 'setup',
    label: 'Setup',
    sub: 'src/setup/',
    detail:
      'Installs or inspects one Setup Target, asking Platforms for the platform-specific facts. Its writes go to global and project paths outside .crew/, behind guard checks — a deliberately separate, narrower policy than the workspace-scoped fs-safe.',
  },
  {
    id: 'launcher',
    label: 'Launcher',
    sub: 'src/launcher/',
    detail:
      'Shows a launch plan or creates a tmux session: resolves worktrees, maps panes, waits for readiness, injects prompts, cleans up. Turning configuration into a plan is a pure step — the same input always produces exactly the same plan — which is what makes --print genuinely free of side effects.',
  },
  {
    id: 'relay',
    label: 'Relay',
    sub: 'src/relay.ts',
    detail:
      'Watches unread Message ids and stale Leases, typing fixed reminders into panes. A polling loop over a tmux adapter that never sees Message content and never marks anything read. Its decisions are pure functions of what it last observed.',
  },
  {
    id: 'console',
    label: 'Console',
    sub: 'src/ui/ + web/',
    detail:
      'The optional browser dashboard: five views, Store snapshots, and Operator actions with no authority beyond what the Store already allows. A foreground HTTP/SSE server reachable only from your own computer, with page assets bundled at build time so it works offline.',
  },
  {
    id: 'store',
    label: 'Store',
    sub: 'src/store/',
    seam: true,
    detail:
      'The only module that imports node:sqlite. It owns the schema, migrations, SQL, transactions, and retries, and exposes named domain operations — joinAgent, submitTask, receiveMessages — never generic CRUD. Seam 2: this is how persistence is tested. Keeping the always-true rules behind one boundary is what stops SQL coordination leaking into command handlers.',
  },
  {
    id: 'format',
    label: 'Format',
    sub: 'src/format.ts',
    detail:
      'Renders records for humans or as NDJSON. Human output is run through sanitizeHuman, which strips ANSI and control sequences so stored content cannot manipulate your terminal; JSON output keeps raw bytes and never rewrites stored content.',
  },
  {
    id: 'io',
    label: 'Io + process',
    sub: 'src/io.ts · src/process.ts',
    seam: true,
    detail:
      'The injected environment: cwd, env, stdin, stdout, stderr, and clock — the single source of “now”. Seam 4: runProcess is capture-only with shell:false, and runInteractive owns the terminal in the foreground for the one process that must (tmux attach). Real implementations on one side, a recording fake on the other, which is what makes it a genuine seam rather than an abstraction.',
  },
] as const;

const ROW_A = ['workspace', 'roles', 'teams', 'platforms'] as const;
const ROW_B = ['setup', 'launcher', 'relay', 'console'] as const;
const ROW_C = ['store', 'format', 'io'] as const;

const X4 = [24, 208, 392, 576];
const X3 = [100, 300, 500];

function byId(id: string) {
  return MODULES.find((module) => module.id === id);
}

export function Modules() {
  return (
    <Section
      title="Module map and the four seams"
      lede={
        <>
          Twelve modules in four layers. A seam is a boundary where one part can be swapped out or
          tested on its own, and crew keeps them deliberately few — there are exactly four, marked
          below. Select any module for what it owns and why it earns its place.
        </>
      }
      sources={[
        { path: 'docs/design/architecture.md', label: 'Architecture §3 — module map' },
        { path: 'src/run.ts', label: 'src/run.ts — the Program seam' },
        { path: 'src/store/index.ts', label: 'src/store/index.ts — the Store seam' },
      ]}
    >
      <Explorer
        items={MODULES.map((module) => ({
          id: module.id,
          label: `${module.label} — ${module.sub}`,
          detail: module.detail,
        }))}
        emptyHint="Select a module. The four with a dot are the seams."
      >
        {(selected, select) => (
          <svg
            viewBox="0 0 760 430"
            class="diagram"
            role="img"
            aria-label="crew module map in four layers"
          >
            <ArrowDefs />

            <text class="layer-label" x="8" y="46">
              entry
            </text>
            <text class="layer-label" x="8" y="118">
              handlers
            </text>
            <text class="layer-label" x="8" y="200">
              domain
            </text>
            <text class="layer-label" x="8" y="348">
              foundations
            </text>

            <NodeBox
              x={290}
              y={24}
              w={180}
              h={46}
              id="program"
              label="Program"
              sub="run(argv, io)"
              tone="accent"
              selected={selected}
              onSelect={select}
            />
            <path class="edge" d="M380,70 L380,96" markerEnd="url(#arrow)" />
            <NodeBox
              x={290}
              y={96}
              w={180}
              h={46}
              id="commands"
              label="Commands"
              sub="thin handlers"
              selected={selected}
              onSelect={select}
            />

            {/* One bus rather than twelve guessed dependency arrows: handlers call
                deeper modules; the exact call graph is in the architecture doc. */}
            <path class="edge is-dashed" d="M380,142 L380,164" />
            <path class="edge is-dashed" d="M104,164 L656,164" />
            {[...X4, ...X4].slice(0, 4).map((x, i) => (
              <path
                key={`tick-${String(i)}`}
                class="edge is-dashed"
                d={`M${String(x + 80)},164 L${String(x + 80)},182`}
              />
            ))}

            {ROW_A.map((id, i) => {
              const module = byId(id);
              return module === undefined ? null : (
                <NodeBox
                  key={id}
                  x={X4[i] ?? 0}
                  y={182}
                  w={160}
                  h={52}
                  id={id}
                  label={module.label}
                  sub={module.sub}
                  tone={'seam' in module && module.seam === true ? 'accent' : 'plain'}
                  selected={selected}
                  onSelect={select}
                />
              );
            })}

            {ROW_B.map((id, i) => {
              const module = byId(id);
              return module === undefined ? null : (
                <NodeBox
                  key={id}
                  x={X4[i] ?? 0}
                  y={252}
                  w={160}
                  h={52}
                  id={id}
                  label={module.label}
                  sub={module.sub}
                  selected={selected}
                  onSelect={select}
                />
              );
            })}

            {ROW_C.map((id, i) => {
              const module = byId(id);
              return module === undefined ? null : (
                <NodeBox
                  key={id}
                  x={X3[i] ?? 0}
                  y={330}
                  w={160}
                  h={52}
                  id={id}
                  label={module.label}
                  sub={module.sub}
                  tone="accent"
                  selected={selected}
                  onSelect={select}
                />
              );
            })}

            {/* Seam markers */}
            {[
              [470, 34],
              [X4[3] ?? 0, 192],
              [X3[0] ?? 0, 340],
              [X3[2] ?? 0, 340],
            ].map(([cx, cy], i) => (
              <circle
                key={`seam-${String(i)}`}
                class="seam-dot"
                cx={(cx ?? 0) + (i === 0 ? -10 : 148)}
                cy={(cy ?? 0) + 8}
                r={5}
              />
            ))}
          </svg>
        )}
      </Explorer>

      <Note kind="why">
        Wrapping each SQL statement in its own public function would create many thin modules and
        spread the rules that must always hold across every caller. The Store may have internal
        files for Agents, Messages, Tasks, and migrations — but it exposes one domain interface.
      </Note>
    </Section>
  );
}
