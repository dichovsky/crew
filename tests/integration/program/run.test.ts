import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { run } from '../../../src/run.js';
import { captureIo } from '../../helpers/io.js';

const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

describe('run() — version and help', () => {
  it('prints the version and exits 0 for --version', async () => {
    const { io, out, err } = captureIo();
    const code = await run(['--version'], io);
    expect(code).toBe(0);
    expect(out.join('')).toContain(pkg.version);
    expect(err.join('')).toBe('');
  });

  it('accepts the -V alias', async () => {
    const { io, out } = captureIo();
    expect(await run(['-V'], io)).toBe(0);
    expect(out.join('')).toContain(pkg.version);
  });

  it('prints help to stdout and exits 0 for --help', async () => {
    const { io, out, err } = captureIo();
    const code = await run(['--help'], io);
    expect(code).toBe(0);
    expect(out.join('')).toMatch(/crew/);
    expect(err.join('')).toBe('');
  });

  it('accepts the -h alias', async () => {
    const { io, out } = captureIo();
    expect(await run(['-h'], io)).toBe(0);
    expect(out.join('')).toMatch(/crew/);
  });
});

describe('run() — usage failures', () => {
  it('treats a bare invocation as USAGE exit 2 without defaulting to help', async () => {
    const { io, out, err } = captureIo();
    const code = await run([], io);
    expect(code).toBe(2);
    expect(err.join('')).toMatch(/^\[USAGE\]/);
    expect(out).toEqual([]);
  });

  it.each(['role', 'task'])(
    'treats a bare %s invocation as USAGE exit 2 without defaulting to help',
    async (command) => {
      const { io, out, err } = captureIo();
      const code = await run([command], io);
      expect(code).toBe(2);
      expect(err.join('')).toMatch(/^\[USAGE\]/);
      expect(out).toEqual([]);
    },
  );

  it('treats an unknown command as USAGE exit 2', async () => {
    const { io, out, err } = captureIo();
    const code = await run(['bogus'], io);
    expect(code).toBe(2);
    expect(err.join('')).toMatch(/^\[USAGE\]/);
    expect(out).toEqual([]);
  });

  it('treats an unknown option as USAGE exit 2', async () => {
    const { io, out, err } = captureIo();
    const code = await run(['--nope'], io);
    expect(code).toBe(2);
    expect(err.join('')).toMatch(/^\[USAGE\]/);
    expect(out).toEqual([]);
  });

  it('renders the error as one JSON object on stderr with --json', async () => {
    const { io, out, err } = captureIo();
    const code = await run(['bogus', '--json'], io);
    expect(code).toBe(2);
    const parsed = JSON.parse(err.join('').trim()) as unknown;
    expect(parsed).toMatchObject({ ok: false, error: { code: 'USAGE' } });
    expect(out).toEqual([]);
  });

  it('does not treat an option value named --json as the JSON rendering flag', async () => {
    const { io, out, err } = captureIo();
    expect(await run(['join', 'worker', '--role', '--json'], io)).toBe(2);
    expect(err.join('')).toMatch(/^\[USAGE\]/);
    expect(out).toEqual([]);
  });

  it('still detects --json after an option that is unknown for the selected command', async () => {
    const { io, out, err } = captureIo();
    expect(await run(['agents', '--role', '--json'], io)).toBe(2);
    expect(JSON.parse(err.join(''))).toMatchObject({ error: { code: 'USAGE' } });
    expect(out).toEqual([]);
  });
});

describe('run() — help/version must not mask invalid invocations (FR-A11)', () => {
  it('treats an unknown command with --help as USAGE exit 2', async () => {
    const { io, out, err } = captureIo();
    expect(await run(['bogus', '--help'], io)).toBe(2);
    expect(err.join('')).toMatch(/^\[USAGE\]/);
    expect(out).toEqual([]);
  });

  it('treats an unknown option with -h as USAGE exit 2', async () => {
    const { io, out, err } = captureIo();
    expect(await run(['--nope', '-h'], io)).toBe(2);
    expect(err.join('')).toMatch(/^\[USAGE\]/);
    expect(out).toEqual([]);
  });

  it('treats an unknown command with --version as USAGE exit 2', async () => {
    const { io } = captureIo();
    expect(await run(['bogus', '--version'], io)).toBe(2);
  });

  it('treats an unknown option after a valid subcommand+help as USAGE exit 2', async () => {
    const { io, out, err } = captureIo();
    expect(await run(['team', 'dev', '--help', '--nope'], io)).toBe(2);
    expect(err.join('')).toMatch(/^\[USAGE\]/);
    expect(out).toEqual([]);
  });

  it('still honors a valid --help (exit 0, help on stdout)', async () => {
    const { io, out } = captureIo();
    expect(await run(['--help'], io)).toBe(0);
    expect(out.join('')).toMatch(/crew/);
  });

  it.each([
    ['role', /Usage: crew role <command>/],
    ['task', /Usage: crew task <command>/],
  ])('still honors a valid %s --help (exit 0, help on stdout)', async (command, pattern) => {
    const { io, out, err } = captureIo();
    expect(await run([command, '--help'], io)).toBe(0);
    expect(out.join('')).toMatch(pattern);
    expect(out.join('')).not.toContain('[command]');
    expect(err.join('')).toBe('');
  });

  it.each([
    [['join', '--help'], /Usage: crew join \[options\] <id>/],
    [['join', '-h'], /Usage: crew join \[options\] <id>/],
    [['role', 'show', '--help'], /Usage: crew role show \[options\] <name>/],
  ])('honors explicit help when %j omits its required operand', async (argv, pattern) => {
    const { io, out, err } = captureIo();
    expect(await run(argv, io)).toBe(0);
    expect(out.join('')).toMatch(pattern);
    expect(err.join('')).toBe('');
  });

  it('still honors a valid --version (exit 0)', async () => {
    const { io, out } = captureIo();
    expect(await run(['--version'], io)).toBe(0);
    expect(out.join('')).toContain(pkg.version);
  });

  it('does not treat a --help after a `--` terminator as a help request', async () => {
    // tokens after `--` are operands, so `--help` here is not a help flag
    const { io, out, err } = captureIo();
    expect(await run(['--help', '--', 'x'], io)).toBe(2);
    expect(err.join('')).toMatch(/^\[USAGE\]/);
    expect(out).toEqual([]);
  });
});
