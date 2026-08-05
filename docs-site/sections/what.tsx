import { ArrowDefs, Edge, Note, Section } from '../kit';

/**
 * Opening section: the problem crew solves, drawn as the difference between
 * independent terminal sessions and sessions sharing one workspace-local store.
 */
export function What() {
  return (
    <Section
      title="What crew is"
      lede={
        <>
          crew is a command-line tool that lets AI coding assistants running in separate terminal
          sessions coordinate on one project. It gives them a shared inbox, a task workflow where
          finished work must pass a separate review, and an optional launcher that opens them side
          by side. It never contacts a model provider itself — it only passes coordination data
          between sessions that are already running.
        </>
      }
      sources={[
        { path: 'README.md', label: 'README' },
        { path: 'docs/design/product-spec.md', label: 'Product specification' },
        { path: 'docs/design/architecture.md', label: 'Architecture §1 — system shape' },
      ]}
    >
      <figure class="figure">
        <svg
          viewBox="0 0 760 300"
          class="diagram"
          role="img"
          aria-label="Three isolated agent sessions on the left; the same three sharing one SQLite state store on the right"
        >
          <ArrowDefs />

          <text class="fig-title" x="24" y="26">
            Without crew
          </text>
          <text class="fig-title" x="430" y="26">
            With crew
          </text>

          {/* Left: three isolated sessions */}
          {[0, 1, 2].map((i) => (
            <g key={`iso-${String(i)}`} class="node node-plain">
              <rect x={24} y={54 + i * 74} width={150} height={56} rx={8} />
              <text x={99} y={78 + i * 74}>
                agent session
              </text>
              <text class="node-sub" x={99} y={94 + i * 74}>
                own context only
              </text>
            </g>
          ))}
          <text class="fig-caption" x="200" y="150">
            no shared state
          </text>
          <text class="fig-caption" x="200" y="168">
            you relay by hand
          </text>

          {/* Divider */}
          <line class="fig-divider" x1="400" y1="40" x2="400" y2="280" />

          {/* Right: three sessions around one store */}
          {[0, 1, 2].map((i) => (
            <g key={`crew-${String(i)}`} class="node node-accent">
              <rect x={430} y={54 + i * 74} width={140} height={56} rx={8} />
              <text x={500} y={78 + i * 74}>
                {['manager', 'worker', 'inspector'][i]}
              </text>
              <text class="node-sub" x={500} y={94 + i * 74}>
                an Agent in the Crew
              </text>
            </g>
          ))}

          {[0, 1, 2].map((i) => (
            <Edge key={`e-${String(i)}`} d={`M572,${82 + i * 74} L648,${150}`} />
          ))}

          <g class="node node-accent is-selected">
            <rect x={650} y={116} width={92} height={68} rx={8} />
            <text x={696} y={144}>
              State Store
            </text>
            <text class="node-sub" x={696} y={160}>
              .crew/state
            </text>
            <text class="node-sub" x={696} y={174}>
              crew.db
            </text>
          </g>
        </svg>
        <figcaption>
          Every command opens the one SQLite file in the workspace, does a bounded amount of work,
          prints, and exits. Nothing stays running in the background.
        </figcaption>
      </figure>

      <Note kind="why">
        A task is not finished because the agent that did it says so. The Worker producing a{' '}
        <em>Submission</em> and an Inspector <em>accepting</em> it are two separate steps the
        database itself enforces, so an agent cannot mark its own work complete.
      </Note>
    </Section>
  );
}
