/**
 * Documentation-site glossary drift guard.
 *
 * `CONTEXT.md` is the binding domain vocabulary, and `docs-site/sections/concepts.tsx`
 * is where a newcomer meets it. Nothing kept the two in step, so a term added to
 * `CONTEXT.md` could leave the site silently incomplete with every gate green — and
 * because the page presents its list affirmatively, a reader had no way to tell.
 *
 * The check is direct rather than routed through `docs-site/generated/facts.json`: the
 * site does not restate a *volatile fact* here, it restates a *set of headings*, and
 * each entry carries hand-written prose that could never be generated. Putting the term
 * list in the facts file would therefore generate a fact the page does not consume,
 * leaving the coverage half — the actual gap — still unguarded. Both sides are derived
 * from their source text here, so the guard itself cannot drift.
 *
 * It lives under `tests/` in the node-environment `main` project, not beside the other
 * `docs-site/**` tests, for the reason `vitest.config.ts` already records for
 * `docs-facts.test.ts`: it reads the filesystem.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CONTEXT = readFileSync(new URL('../../CONTEXT.md', import.meta.url), 'utf8');
const CONCEPTS = readFileSync(
  new URL('../../docs-site/sections/concepts.tsx', import.meta.url),
  'utf8',
);

/** Slice `body` between a start heading and the next same-level heading. */
function section(body: string, heading: string, nextHeading: string): string {
  const start = body.indexOf(heading);
  if (start === -1) throw new Error(`CONTEXT.md no longer has a "${heading}" heading`);
  const end = body.indexOf(nextHeading, start);
  if (end === -1) throw new Error(`CONTEXT.md no longer has a "${nextHeading}" heading`);
  return body.slice(start, end);
}

/**
 * The bold-lead term definitions under CONTEXT.md's `## Language` section.
 *
 * Deliberately tolerant of what follows the closing `**`. Requiring the exact
 * `**Term**:` shape made the parser shrink silently when a definition was reformatted:
 * unmatched terms simply left the guarded set, so reformatting all but one still
 * reported green while checking a single term. Matching any bold-lead line keeps a
 * formatting change inside the section from quietly narrowing what is guarded — and if
 * a future non-term bold line appears here, the set comparison below fails loudly
 * rather than silently, which is the safe direction.
 */
function contextTerms(): string[] {
  const language = section(CONTEXT, '## Language', '## Relationships');
  return [...language.matchAll(/^\*\*(.+?)\*\*/gm)].map((match) => match[1]!);
}

/** The `label:` values of the `TERMS` array the documentation site renders. */
function siteTerms(): string[] {
  const open = CONCEPTS.indexOf('const TERMS = [');
  if (open === -1) throw new Error('concepts.tsx no longer declares a TERMS array');
  const close = CONCEPTS.indexOf('\n] as const;', open);
  if (close === -1) throw new Error('concepts.tsx TERMS array is never closed');
  return [...CONCEPTS.slice(open, close).matchAll(/^\s*label: '(.+?)',$/gm)].map(
    (match) => match[1]!,
  );
}

describe('docs-site glossary mirrors CONTEXT.md', () => {
  it('reads a non-empty term list from each source', () => {
    expect(contextTerms().length).toBeGreaterThan(0);
    expect(siteTerms().length).toBeGreaterThan(0);
  });

  it('teaches every term CONTEXT.md defines, and no others', () => {
    const defined = contextTerms();
    const rendered = siteTerms();

    const missing = defined.filter((term) => !rendered.includes(term));
    expect(
      missing,
      'CONTEXT.md defines terms the documentation site never teaches — add them to the TERMS array in docs-site/sections/concepts.tsx',
    ).toEqual([]);

    // The reverse direction is what keeps the guard from degrading quietly. If either
    // parser stops seeing part of its source, the two sets stop matching and this fires;
    // a one-directional coverage check would just guard a smaller set and stay green.
    const untaught = rendered.filter((term) => !defined.includes(term));
    expect(
      untaught,
      'the documentation site teaches terms CONTEXT.md does not define — either add them to CONTEXT.md or remove them from the TERMS array',
    ).toEqual([]);
  });
});
