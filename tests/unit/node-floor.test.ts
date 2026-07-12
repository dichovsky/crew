import { describe, it, expect } from 'vitest';
import { assertNodeFloor, isNodeBelow, NODE_FLOOR } from '../../src/node-floor.js';

describe('node floor', () => {
  it('pins the floor to the engines policy', () => {
    expect(NODE_FLOOR).toBe('24.15.0');
  });

  it('detects versions below the floor', () => {
    expect(isNodeBelow('22.0.0', NODE_FLOOR)).toBe(true);
    expect(isNodeBelow('24.14.99', NODE_FLOOR)).toBe(true);
    expect(isNodeBelow('24.15.0', NODE_FLOOR)).toBe(false);
    expect(isNodeBelow('24.18.0', NODE_FLOOR)).toBe(false);
    expect(isNodeBelow('25.0.0', NODE_FLOOR)).toBe(false);
  });

  it('throws a clear, version-bearing message below the floor', () => {
    expect(() => assertNodeFloor('22.0.0')).toThrowError(/Node >=24\.15/);
    expect(() => assertNodeFloor('22.0.0')).toThrowError(/22\.0\.0/);
  });

  it('passes at or above the floor', () => {
    expect(() => assertNodeFloor('24.15.0')).not.toThrow();
    expect(() => assertNodeFloor('24.18.0')).not.toThrow();
  });

  it('handles malformed or empty version strings gracefully', () => {
    expect(isNodeBelow('', NODE_FLOOR)).toBe(true);
    expect(isNodeBelow('abc', NODE_FLOOR)).toBe(true);
    expect(isNodeBelow('24', NODE_FLOOR)).toBe(true);
  });
});
