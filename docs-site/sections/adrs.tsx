import { facts } from '../facts';
import { Explorer, Note, Section } from '../kit';

const PER_ROW = 6;
const NODE_W = 110;
const NODE_H = 44;
const GAP = 12;
const ROW_Y = [50, 140, 230];

/**
 * The decision record, laid out chronologically.
 *
 * Deliberately a spine rather than a dependency graph: the ADRs do not encode
 * machine-readable relationships, so drawing edges between them would mean
 * inventing links this site cannot verify. Order is a fact; influence is not.
 */
export function Adrs() {
  const { adrs } = facts;

  return (
    <Section
      title="Decision record"
      lede={
        <>
          <strong>{adrs.length}</strong> Architecture Decision Records — decisions judged hard
          enough to reverse that they were written down rather than buried in a commit message. They
          sit at the top of the documentation authority order: when documents disagree, an accepted
          ADR wins. Select one to read its title and open it.
        </>
      }
      sources={[
        { path: 'docs/adr/README.md', label: 'ADR index' },
        { path: 'docs/README.md', label: 'Documentation authority order' },
      ]}
    >
      <Explorer
        items={adrs.map((adr) => ({
          id: adr.id,
          label: `ADR-${adr.id}`,
          detail: (
            <>
              <p class="adr-title">{adr.title}</p>
              <p>
                <a
                  href={`https://github.com/dichovsky/crew/blob/main/docs/adr/${adr.slug}.md`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Read ADR-{adr.id} →
                </a>
              </p>
            </>
          ),
        }))}
        emptyHint="Select a record to see what it decided."
      >
        {(selected, select) => (
          <svg
            viewBox="0 0 760 290"
            class="diagram"
            role="img"
            aria-label={`${String(adrs.length)} architecture decision records in chronological order`}
          >
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

            {adrs.map((adr, i) => {
              const row = Math.floor(i / PER_ROW);
              const col = i % PER_ROW;
              const x = 20 + col * (NODE_W + GAP);
              const y = ROW_Y[row] ?? 0;
              const isOn = selected === adr.id;
              return (
                <g
                  key={adr.id}
                  class={`node node-plain${isOn ? ' is-selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isOn}
                  aria-label={`ADR ${adr.id}: ${adr.title}`}
                  onClick={() => {
                    select(adr.id);
                  }}
                  onKeyDown={(event: KeyboardEvent) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      select(adr.id);
                    }
                  }}
                >
                  <rect x={x} y={y} width={NODE_W} height={NODE_H} rx={8} />
                  <text x={x + NODE_W / 2} y={y + 27}>
                    ADR-{adr.id}
                  </text>
                </g>
              );
            })}

            {/* Chronological spine: within each row, then wrapping to the next. */}
            {adrs.slice(0, -1).map((adr, i) => {
              const row = Math.floor(i / PER_ROW);
              const col = i % PER_ROW;
              const y = (ROW_Y[row] ?? 0) + NODE_H / 2;
              if (col < PER_ROW - 1) {
                const x = 20 + col * (NODE_W + GAP) + NODE_W;
                return (
                  <path
                    key={`e-${adr.id}`}
                    class="edge"
                    d={`M${String(x)},${String(y)} L${String(x + GAP - 2)},${String(y)}`}
                    marker-end="url(#arrow)"
                  />
                );
              }
              const nextY = (ROW_Y[row + 1] ?? 0) + NODE_H / 2;
              return (
                <path
                  key={`w-${adr.id}`}
                  class="edge is-dashed"
                  d={`M${String(20 + col * (NODE_W + GAP) + NODE_W / 2)},${String(y + NODE_H / 2)} C740,${String(y + 40)} 20,${String(nextY - 40)} ${String(20 + NODE_W / 2)},${String(nextY - NODE_H / 2)}`}
                  marker-end="url(#arrow)"
                />
              );
            })}
          </svg>
        )}
      </Explorer>

      <Note kind="why">
        The order below the ADRs is the Software Requirements Specification, then the CLI contract
        and data model, then the architecture. A change to CLI behavior updates the requirements,
        the contract, and the tests together; a schema change updates the data model, the migration
        tests, and <code>PRAGMA user_version</code> together. This site sits outside that order — it
        explains the contract, it never defines it.
      </Note>
    </Section>
  );
}
