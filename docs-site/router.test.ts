/**
 * Hash routing: every section must be reachable by URL, and anything else must
 * fall back rather than render nothing.
 */
import { describe, expect, it } from 'vitest';
import { routeFromHash } from './router';
import { DEFAULT_SECTION, SECTIONS, sectionById } from './sections';

describe('routeFromHash', () => {
  it('falls back when the hash is empty', () => {
    expect(routeFromHash('', DEFAULT_SECTION)).toBe(DEFAULT_SECTION);
    expect(routeFromHash('#', DEFAULT_SECTION)).toBe(DEFAULT_SECTION);
    expect(routeFromHash('#/', DEFAULT_SECTION)).toBe(DEFAULT_SECTION);
  });

  it('reads the section id out of the hash', () => {
    expect(routeFromHash('#/schema', DEFAULT_SECTION)).toBe('schema');
    expect(routeFromHash('#schema', DEFAULT_SECTION)).toBe('schema');
  });

  it('resolves a deep link for every registered section', () => {
    for (const section of SECTIONS) {
      const id = routeFromHash(`#/${section.id}`, DEFAULT_SECTION);
      expect(sectionById(id)).toBe(section);
    }
  });

  it('yields nothing resolvable for an unknown id', () => {
    expect(sectionById(routeFromHash('#/not-a-section', DEFAULT_SECTION))).toBeUndefined();
  });
});

describe('section registry', () => {
  it('has a unique id per section', () => {
    const ids = SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('assigns every section to a track', () => {
    for (const section of SECTIONS) {
      expect(['using', 'building']).toContain(section.track);
    }
  });

  it('starts on a section that exists', () => {
    expect(sectionById(DEFAULT_SECTION)).toBeDefined();
  });
});
