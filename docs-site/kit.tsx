/**
 * Shared building blocks for every section.
 *
 * The site is diagram-first: a visual carries the explanation, a short lede
 * orients the reader, and links point at the authoritative document. Nothing
 * here restates a fact — see `facts.ts` for anything that could drift.
 */
import type { ComponentChildren } from 'preact';
import { useCallback, useState } from 'preact/hooks';

const REPO = 'https://github.com/dichovsky/crew';

/** A link into the repository's authoritative copy of something. */
export function Source({ path, children }: { path: string; children: ComponentChildren }) {
  return (
    <a class="source" href={`${REPO}/blob/main/${path}`} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** The strip of authority links that closes every section. */
export function Sources({ items }: { items: readonly { path: string; label: string }[] }) {
  return (
    <footer class="sources">
      <span class="sources-label">Authoritative source</span>
      <ul>
        {items.map((item) => (
          <li key={item.path}>
            <Source path={item.path}>{item.label}</Source>
          </li>
        ))}
      </ul>
    </footer>
  );
}

export function Section({
  title,
  lede,
  children,
  sources,
}: {
  title: string;
  lede: ComponentChildren;
  children: ComponentChildren;
  sources: readonly { path: string; label: string }[];
}) {
  return (
    <article class="section">
      <h1>{title}</h1>
      <p class="lede">{lede}</p>
      {children}
      <Sources items={sources} />
    </article>
  );
}

/** A short aside that names a tradeoff or a constraint. */
export function Note({ kind, children }: { kind: 'limit' | 'why'; children: ComponentChildren }) {
  return (
    <aside class={`note note-${kind}`}>
      <span class="note-tag">{kind === 'limit' ? 'Limit' : 'Why'}</span>
      <div>{children}</div>
    </aside>
  );
}

export interface Step {
  readonly id: string;
  readonly label: string;
  readonly detail: ComponentChildren;
}

/**
 * A step control for the sequential flows. The reader drives it; nothing plays
 * on its own, so `prefers-reduced-motion` needs no special case beyond the
 * transition suppression already in the stylesheet.
 */
export function Stepper({
  steps,
  children,
  caption,
}: {
  steps: readonly Step[];
  caption: string;
  children: (index: number) => ComponentChildren;
}) {
  const [index, setIndex] = useState(0);
  const last = steps.length - 1;
  const step = steps[index];

  const go = useCallback(
    (next: number) => {
      setIndex(Math.max(0, Math.min(last, next)));
    },
    [last],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        setIndex((i) => Math.min(last, i + 1));
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setIndex((i) => Math.max(0, i - 1));
      }
    },
    [last],
  );

  return (
    <div class="stepper" onKeyDown={onKeyDown}>
      <div class="stepper-stage" role="group" aria-label={caption}>
        {children(index)}
      </div>

      <ol class="stepper-track" aria-label={`${caption} steps`}>
        {steps.map((entry, i) => (
          <li key={entry.id}>
            <button
              type="button"
              class={`stepper-dot${i === index ? ' is-current' : ''}${i < index ? ' is-done' : ''}`}
              aria-current={i === index ? 'step' : undefined}
              onClick={() => {
                go(i);
              }}
            >
              <span class="stepper-dot-num">{i + 1}</span>
              <span class="stepper-dot-label">{entry.label}</span>
            </button>
          </li>
        ))}
      </ol>

      <div class="stepper-detail" aria-live="polite">
        <p class="stepper-detail-head">
          Step {index + 1} of {steps.length} — {step?.label}
        </p>
        <div>{step?.detail}</div>
      </div>

      <div class="stepper-controls">
        <button
          type="button"
          onClick={() => {
            go(index - 1);
          }}
          disabled={index === 0}
        >
          ← Previous
        </button>
        <button
          type="button"
          onClick={() => {
            go(index + 1);
          }}
          disabled={index === last}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

export interface ExplorerItem {
  readonly id: string;
  readonly label: string;
  readonly detail: ComponentChildren;
}

/**
 * Click-to-reveal wrapper for the structural diagrams: the diagram renders via
 * `children`, which receives the selected id and a selector callback, and the
 * detail panel below shows whichever item is selected.
 */
export function Explorer({
  items,
  children,
  emptyHint,
}: {
  items: readonly ExplorerItem[];
  emptyHint: string;
  children: (selected: string | null, select: (id: string) => void) => ComponentChildren;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const select = useCallback((id: string) => {
    setSelected((current) => (current === id ? null : id));
  }, []);
  const item = items.find((entry) => entry.id === selected);

  return (
    <div class="explorer">
      <div class="explorer-stage">{children(selected, select)}</div>
      <div class="explorer-detail" aria-live="polite">
        {item === undefined ? (
          <p class="explorer-hint">{emptyHint}</p>
        ) : (
          <>
            <h3>{item.label}</h3>
            <div>{item.detail}</div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * One selectable node inside an SVG diagram. Rendered as a `<g>` carrying
 * button semantics so it is reachable by keyboard, not only by pointer.
 */
export function NodeBox({
  x,
  y,
  w,
  h,
  id,
  label,
  sub,
  tone,
  selected,
  onSelect,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  id: string;
  label: string;
  sub?: string;
  tone?: 'accent' | 'plain' | 'warn';
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const isOn = selected === id;
  return (
    <g
      class={`node node-${tone ?? 'plain'}${isOn ? ' is-selected' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={isOn}
      aria-label={label}
      onClick={() => {
        onSelect(id);
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(id);
        }
      }}
    >
      <rect x={x} y={y} width={w} height={h} rx={8} />
      <text x={x + w / 2} y={sub === undefined ? y + h / 2 + 4 : y + h / 2 - 3}>
        {label}
      </text>
      {sub !== undefined && (
        <text class="node-sub" x={x + w / 2} y={y + h / 2 + 13}>
          {sub}
        </text>
      )}
    </g>
  );
}

/** A plain connector between two points in a diagram. */
export function Edge({
  d,
  dashed,
  label,
  labelX,
  labelY,
}: {
  d: string;
  dashed?: boolean;
  label?: string;
  labelX?: number;
  labelY?: number;
}) {
  return (
    <>
      <path class={`edge${dashed === true ? ' is-dashed' : ''}`} d={d} markerEnd="url(#arrow)" />
      {label !== undefined && labelX !== undefined && labelY !== undefined && (
        <text class="edge-label" x={labelX} y={labelY}>
          {label}
        </text>
      )}
    </>
  );
}

/** The arrowhead every diagram reuses. */
export function ArrowDefs() {
  return (
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
  );
}
