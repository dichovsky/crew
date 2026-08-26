import { describe, expect, it } from 'vitest';
import { CrewError } from '../../src/errors.js';
import { compileSearchQuery } from '../../src/search-query.js';

function expectUsage(clauses: readonly string[]): void {
  try {
    compileSearchQuery(clauses);
    throw new Error('expected failure');
  } catch (err) {
    expect(err).toBeInstanceOf(CrewError);
    expect((err as CrewError).code).toBe('USAGE');
  }
}

describe('compileSearchQuery', () => {
  it('preserves argv boundaries as AND clauses versus one phrase clause', () => {
    expect(compileSearchQuery(['lease', 'inspector']).match).toBe('"lease" AND "inspector"');
    expect(compileSearchQuery(['lease inspector']).match).toBe('"lease inspector"');
  });

  it('quotes every clause, escapes quotes, and leaves only a trailing prefix operator outside', () => {
    expect(compileSearchQuery(['AND', 'content:lease', 'say "hello"', 'leas*']).match).toBe(
      '"AND" AND "content:lease" AND "say ""hello""" AND "leas"*',
    );
  });

  it('counts Unicode code points after joining arguments with one space', () => {
    expect(compileSearchQuery(['😀'.repeat(500)]).match).toHaveLength(1_002);
    expectUsage(['😀'.repeat(501)]);
    expectUsage([]);
  });

  it('rejects the argv-impossible NUL that would truncate FTS5 syntax', () => {
    expectUsage(['lease\0inspector']);
  });
});
