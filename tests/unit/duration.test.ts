import { describe, expect, it } from 'vitest';
import { CrewError } from '../../src/errors.js';
import { parseDuration } from '../../src/duration.js';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof CrewError ? err.code : 'NON_CREW';
  }
  return undefined;
}

describe('parseDuration', () => {
  it('converts each unit to seconds', () => {
    expect(parseDuration('1s')).toBe(1);
    expect(parseDuration('1m')).toBe(60);
    expect(parseDuration('1h')).toBe(3600);
    expect(parseDuration('1d')).toBe(86400);
    expect(parseDuration('1w')).toBe(604800);
  });

  it('multiplies the integer count by the unit', () => {
    expect(parseDuration('30d')).toBe(30 * 86400);
    expect(parseDuration('90d')).toBe(90 * 86400);
    expect(parseDuration('2w')).toBe(2 * 604800);
  });

  it('rejects zero and negative values as USAGE', () => {
    expect(code(() => parseDuration('0d'))).toBe('USAGE');
    expect(code(() => parseDuration('-1d'))).toBe('USAGE');
  });

  it('rejects malformed, compound, and empty inputs as USAGE', () => {
    expect(code(() => parseDuration(''))).toBe('USAGE');
    expect(code(() => parseDuration('1d12h'))).toBe('USAGE');
    expect(code(() => parseDuration('d'))).toBe('USAGE');
    expect(code(() => parseDuration('10'))).toBe('USAGE');
    expect(code(() => parseDuration('10y'))).toBe('USAGE');
    expect(code(() => parseDuration('1.5d'))).toBe('USAGE');
    expect(code(() => parseDuration(' 1d '))).toBe('USAGE');
  });

  it('rejects values whose seconds leave the safe-integer range', () => {
    expect(code(() => parseDuration('99999999999999999999w'))).toBe('USAGE');
  });
});
