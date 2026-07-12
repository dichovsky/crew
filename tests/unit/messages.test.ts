import { describe, expect, it } from 'vitest';
import { CrewError } from '../../src/errors.js';
import { parseHistoryTimestamp } from '../../src/messages.js';

function expectUsage(value: string): void {
  let error: unknown;
  try {
    parseHistoryTimestamp(value);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(CrewError);
  expect((error as CrewError).code).toBe('USAGE');
}

describe('parseHistoryTimestamp', () => {
  it('accepts safe epoch seconds and exact-second ISO-8601 offsets', () => {
    expect(parseHistoryTimestamp('0')).toBe(0);
    expect(parseHistoryTimestamp('-1')).toBe(-1);
    expect(parseHistoryTimestamp(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseHistoryTimestamp('2026-01-01T00:00:00Z')).toBe(1_767_225_600);
    expect(parseHistoryTimestamp('2026-01-01T02:30:00+02:30')).toBe(1_767_225_600);
    expect(parseHistoryTimestamp('2025-12-31T19:00:00-05:00')).toBe(1_767_225_600);
    expect(parseHistoryTimestamp('2026-01-01T23:59:00+23:59')).toBe(1_767_225_600);
  });

  it('rejects unsafe epochs, invalid calendar values, and invalid offsets', () => {
    for (const value of [
      '9007199254740992',
      '2026-02-29T00:00:00Z',
      '2026-01-01T24:00:00Z',
      '2026-01-01T00:60:00Z',
      '2026-01-01T00:00:60Z',
      '2026-01-01T00:00:00+24:00',
      '2026-01-01T00:00:00-00:60',
    ]) {
      expectUsage(value);
    }
  });
});
