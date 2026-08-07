/**
 * A guard for one invisible class of diagram defect, not for diagram markup.
 *
 * Preact writes an unrecognized prop on an SVG element straight through
 * `setAttribute`, and `setAttribute` preserves case in the SVG namespace. So a
 * prop spelled `markerEnd` lands as the attribute `markerEnd`, which SVG simply
 * ignores — the edge still draws, only its arrowhead silently disappears. That
 * is why it survived review across five files (#128): the geometry looks right
 * and only the direction cue is gone.
 *
 * Scope note: this deliberately asserts nothing about *which* edges exist or
 * where they point — that markup churns with every diagram tweak and catching
 * it would be noise (see the header of `kit.test.tsx`). It asserts only the two
 * things that make an arrowhead fail to paint no matter how the diagram is
 * drawn: a presentation attribute spelled in camelCase, and a marker reference
 * pointing at an id that the same section never defines.
 *
 * jsdom limitation, stated honestly: jsdom does not resolve SVG presentation
 * attributes into computed style — `getComputedStyle(path).markerEnd` is
 * `'none'` here for the correct spelling and the broken one alike. So this file
 * cannot prove an arrowhead *paints*; only a real browser can, and that check
 * belongs to whoever renders the built bundle. What it can prove, exactly and
 * cheaply, is that the attribute reaching the DOM is the one SVG reads.
 */
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { SECTIONS } from './sections';

/**
 * SVG presentation attributes whose spec spelling is hyphenated. Their
 * camelCase forms are the trap: they look like valid JSX props, survive
 * TypeScript, and are discarded silently by the renderer.
 *
 * Genuinely camelCase SVG attributes (`markerWidth`, `refX`, `viewBox`,
 * `markerUnits`) are correct as written and are absent from this list by
 * construction, so they can never be flagged.
 */
const HYPHENATED_PRESENTATION_ATTRIBUTES: readonly string[] = [
  'clip-path',
  'clip-rule',
  'color-interpolation',
  'dominant-baseline',
  'fill-opacity',
  'fill-rule',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'marker-end',
  'marker-mid',
  'marker-start',
  'paint-order',
  'pointer-events',
  'shape-rendering',
  'stop-color',
  'stop-opacity',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
  'text-anchor',
  'vector-effect',
];

function toCamelCase(attribute: string): string {
  return attribute.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/** camelCase spelling → the spec spelling it should have been. */
const FORBIDDEN_SPELLINGS = new Map<string, string>(
  HYPHENATED_PRESENTATION_ATTRIBUTES.map((attribute) => [toCamelCase(attribute), attribute]),
);

/** Every `url(#id)` reference a marker attribute can carry. */
const MARKER_ATTRIBUTES = ['marker-start', 'marker-mid', 'marker-end'];

function mount(Component: (typeof SECTIONS)[number]['Component']): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(<Component />, host);
  return host;
}

function svgElements(host: HTMLElement): Element[] {
  return [...host.querySelectorAll('svg, svg *')];
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe.each(SECTIONS.map((section) => section))('$id diagrams', ({ id, Component }) => {
  it('spells every SVG presentation attribute the way SVG reads it', () => {
    const offenders = svgElements(mount(Component)).flatMap((element) =>
      element
        .getAttributeNames()
        .filter((name) => FORBIDDEN_SPELLINGS.has(name))
        .map(
          (name) => `<${element.tagName} ${name}=…> should be "${FORBIDDEN_SPELLINGS.get(name)}"`,
        ),
    );

    expect(offenders, `${id}: camelCase SVG presentation attributes are dropped silently`).toEqual(
      [],
    );
  });

  it('points every marker reference at a marker the section actually defines', () => {
    const host = mount(Component);
    const defined = new Set(
      [...host.querySelectorAll('marker[id]')].map((marker) => marker.getAttribute('id')),
    );

    const dangling = svgElements(host).flatMap((element) =>
      MARKER_ATTRIBUTES.flatMap((attribute) => {
        const value = element.getAttribute(attribute);
        if (value === null) return [];
        const target = /^url\(#(?<id>[^)]+)\)$/.exec(value)?.groups?.['id'];
        if (target === undefined) return [`<${element.tagName} ${attribute}="${value}">`];
        return defined.has(target) ? [] : [`<${element.tagName} ${attribute}="${value}">`];
      }),
    );

    expect(
      dangling,
      `${id}: a marker reference with no matching <marker id> paints nothing`,
    ).toEqual([]);
  });
});
