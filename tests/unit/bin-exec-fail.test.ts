import { describe, it, expect } from 'vitest';

const originalNodeVersion = process.versions.node;
const originalArgv = process.argv;

Object.defineProperty(process.versions, 'node', {
  value: '24.18.0',
  configurable: true,
});
process.argv = ['node', 'crew', 'bogus'];

const { main } = await import('../../bin/crew.js');

try {
  process.exitCode = undefined;
  await main();
} finally {
  Object.defineProperty(process.versions, 'node', {
    value: originalNodeVersion,
    configurable: true,
  });
  process.argv = originalArgv;
}

describe('bin/crew.ts execution failure', () => {
  it('fails with exit 2 when command execution throws', () => {
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
  });
});
