/* eslint-disable */
import { describe, it, expect } from 'vitest';

const originalNodeVersion = process.versions.node;
const originalStderrWrite = process.stderr.write;
let stderrOutput: string[] = [];

Object.defineProperty(process.versions, 'node', {
  value: '22.0.0',
  configurable: true,
});

process.stderr.write = ((text: any) => {
  stderrOutput.push(String(text));
  return true;
}) as any;

const { main } = await import('../../bin/crew.js');

try {
  process.exitCode = undefined;
  await main();
} finally {
  Object.defineProperty(process.versions, 'node', {
    value: originalNodeVersion,
    configurable: true,
  });
  process.stderr.write = originalStderrWrite;
}

describe('bin/crew.ts floor failure', () => {
  it('fails with exit 1 if Node version is below floor', () => {
    expect(process.exitCode).toBe(1);
    expect(stderrOutput.join('')).toContain('crew requires Node >=24.15');
    process.exitCode = undefined;
  });
});
