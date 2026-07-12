import { describe, it, expect } from 'vitest';

const originalNodeVersion = process.versions.node;
const originalArgv = process.argv;

Object.defineProperty(process.versions, 'node', {
  value: '24.18.0',
  configurable: true,
});
process.argv = ['node', 'crew', '--version'];

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

describe('bin/crew.ts floor pass', () => {
  it('runs successfully when Node floor passes', () => {
    expect(process.exitCode).toBe(0);
    process.exitCode = undefined;
  });
});
