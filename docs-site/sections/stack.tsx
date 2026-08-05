import { facts } from '../facts';
import { Note, Section } from '../kit';

/**
 * Tech stack and the pipeline. Dependency lists, the Node floor, and the coverage
 * thresholds all come from facts.json — nothing on this page is retyped.
 */
const CI_STEPS = [
  { id: 'typecheck', label: 'typecheck', note: 'three tsconfigs: CLI, Console, docs site' },
  { id: 'lint', label: 'lint', note: 'type-checked ESLint rules' },
  { id: 'format', label: 'format:check', note: 'prettier, prose excluded' },
  { id: 'build', label: 'build', note: 'tsc → dist/ plus the Console bundle' },
  { id: 'build-docs', label: 'build:docs', note: 'this site — outside dist/, never published' },
  { id: 'test', label: 'test:coverage', note: 'the whole suite, coverage-gated' },
] as const;

export function Stack() {
  const { runtimeDependencies, devDependencies, nodeEngine, name, version } = facts.package;
  const { statements } = facts.coverageThresholds;

  return (
    <Section
      title="Tech stack, build, and CI"
      lede={
        <>
          <code>{name}</code> {version} is TypeScript compiled to ES modules, with exactly{' '}
          <strong>{Object.keys(runtimeDependencies).length}</strong> runtime dependencies. SQLite
          and UUID generation come from Node’s own core modules, which is why the floor is{' '}
          <code>{nodeEngine}</code> — <code>node:sqlite</code> only ships with Node 24 and later.
        </>
      }
      sources={[
        { path: 'package.json', label: 'package.json' },
        { path: '.github/workflows/ci.yml', label: 'CI workflow' },
        { path: 'docs/design/testing-strategy.md', label: 'Testing strategy' },
        {
          path: 'docs/design/architecture.md',
          label: 'Architecture §9 — runtime and distribution',
        },
      ]}
    >
      <div class="stack-grid">
        <div class="stack-card">
          <h3>Runtime dependencies</h3>
          <ul class="deps">
            {Object.entries(runtimeDependencies).map(([dep, range]) => (
              <li key={dep}>
                <code>{dep}</code> <span class="dep-range">{range}</span>
              </li>
            ))}
          </ul>
          <p class="stack-foot">
            That is the entire installed dependency surface. Preact is inlined into the Console
            bundle at build time and is not a runtime dependency.
          </p>
        </div>

        <div class="stack-card">
          <h3>Development dependencies</h3>
          <div class="chips">
            {devDependencies.map((dep) => (
              <span key={dep} class="chip chip-static">
                {dep}
              </span>
            ))}
          </div>
        </div>

        <div class="stack-card">
          <h3>Quality gate</h3>
          <p class="big-number">{statements}%</p>
          <p>
            Coverage threshold on statements, branches, functions, and lines across{' '}
            <code>src/**</code> and <code>bin/**</code>. Browser sources sit deliberately outside
            that gate and carry their own component tests.
          </p>
        </div>
      </div>

      <figure class="figure">
        <svg
          viewBox="0 0 760 150"
          class="diagram"
          role="img"
          aria-label="CI pipeline: six sequential gates"
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
          {CI_STEPS.map((step, i) => (
            <g key={step.id} class="node node-plain">
              <rect x={8 + i * 126} y={44} width={112} height={46} rx={8} />
              <text x={64 + i * 126} y={66}>
                {step.label}
              </text>
              <text class="node-sub" x={64 + i * 126} y={82}>
                gate {i + 1}
              </text>
            </g>
          ))}
          {[0, 1, 2, 3, 4].map((i) => (
            <path
              key={`a-${String(i)}`}
              class="edge"
              d={`M${String(120 + i * 126)},67 L${String(130 + i * 126)},67`}
              markerEnd="url(#arrow)"
            />
          ))}
          <text class="fig-caption" x="8" y="118">
            All six must pass on every push to main and every pull request, on Node 24.18.0.
          </text>
          <text class="fig-caption" x="8" y="136">
            A separate job rehearses publishing with npm publish --dry-run — no token, nothing
            published.
          </text>
        </svg>
        <figcaption>
          {CI_STEPS.map((step) => `${step.label} — ${step.note}`).join(' · ')}
        </figcaption>
      </figure>

      <Note kind="why">
        Publishing runs only when a GitHub Release is published, via npm OIDC Trusted Publishing
        with provenance — no long-lived npm secret ever enters CI. This documentation site deploys
        through a separate workflow with its own narrowly scoped permissions, so the CI workflow
        keeps its read-only posture.
      </Note>
    </Section>
  );
}
