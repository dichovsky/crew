/**
 * Drift guard for hand-written prose that is keyed by a generated fact: every
 * table the schema declares must have documentation, and the page must not
 * document a table that no longer exists.
 */
import { describe, expect, it } from 'vitest';
import { facts } from '../facts';
import { TABLE_DOCS } from './schema';

describe('schema documentation', () => {
  it('documents every table the schema declares', () => {
    const missing = facts.schema.tables.filter((table) => TABLE_DOCS[table] === undefined);
    expect(missing).toEqual([]);
  });

  it('documents no table the schema has dropped', () => {
    const stale = Object.keys(TABLE_DOCS).filter((table) => !facts.schema.tables.includes(table));
    expect(stale).toEqual([]);
  });

  it('states at least one always-true rule per table', () => {
    for (const table of facts.schema.tables) {
      expect(TABLE_DOCS[table]?.invariants.length ?? 0).toBeGreaterThan(0);
    }
  });
});
