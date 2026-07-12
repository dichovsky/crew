/**
 * Argv-exact proof of the real tmux adapter. The
 * recording process double captures every `shell:false` argv; the semantic
 * orchestration sequence is proven separately against a fake adapter. Also
 * proves the boundary diagnostic guard.
 */
import { describe, expect, it } from 'vitest';
import { CrewError } from '../../../src/errors.js';
import type { ProcessResult } from '../../../src/io.js';
import { createTmuxAdapter } from '../../../src/launcher/tmux.js';
import { captureIo, recordingRunInteractive, recordingRunProcess } from '../../helpers/io.js';

function adapterWith(script: readonly (ProcessResult | ((c: never) => ProcessResult))[]) {
  const rec = recordingRunProcess(script as never[]);
  const { io } = captureIo({ runProcess: rec.runProcess });
  return { adapter: createTmuxAdapter(io), calls: rec.calls };
}

const OK = (stdout = ''): ProcessResult => ({ status: 0, stdout, stderr: '' });

describe('tmux adapter argv', () => {
  it('isPresent runs `tmux -V` and maps status', async () => {
    const present = adapterWith([OK('tmux 3.6b')]);
    expect(await present.adapter.isPresent()).toBe(true);
    expect(present.calls[0]).toMatchObject({ file: 'tmux', args: ['-V'] });

    const absent = adapterWith([{ status: null, stdout: '', stderr: '' }]);
    expect(await absent.adapter.isPresent()).toBe(false);
  });

  it('isPresent treats a killed tmux probe as a generic ERROR, never missing tmux', async () => {
    const killed = adapterWith([
      { status: null, stdout: '', stderr: '', killed: true, signal: 'SIGTERM' },
    ]);
    const failure = await killed.adapter.isPresent().then(
      () => null,
      (err: unknown) => err as CrewError,
    );
    expect(failure).toMatchObject({
      code: 'ERROR',
      message: 'the tmux availability probe (tmux -V) did not exit cleanly (signal SIGTERM)',
    });
    expect(failure?.message).not.toContain('not available');
  });

  it('hasSession exits 0 = present, non-zero = absent, null spawn = DEPENDENCY_MISSING', async () => {
    const yes = adapterWith([OK()]);
    expect(await yes.adapter.hasSession('demo')).toBe(true);
    expect(yes.calls[0]).toMatchObject({ args: ['has-session', '-t', '=demo'] });

    const no = adapterWith([{ status: 1, stdout: '', stderr: '' }]);
    expect(await no.adapter.hasSession('demo')).toBe(false);

    const missing = adapterWith([{ status: null, stdout: '', stderr: '' }]);
    await expect(missing.adapter.hasSession('demo')).rejects.toMatchObject({
      code: 'DEPENDENCY_MISSING',
    });
  });

  it('hasSession treats a killed control command as a generic ERROR, not LAUNCH_FAILED', async () => {
    const killed = adapterWith([
      { status: null, stdout: '', stderr: '', killed: true, signal: 'SIGTERM' },
    ]);
    const failure = await killed.adapter.hasSession('demo').then(
      () => null,
      (err: unknown) => err as CrewError,
    );
    expect(failure).toMatchObject({
      code: 'ERROR',
      message: 'tmux has-session did not exit cleanly (signal SIGTERM)',
    });
    // hasSession also serves stop/peek/Relay/resume — never claim a launch failed.
    expect(failure?.message).not.toMatch(/launch/i);
  });

  it('newSession builds the detached argv and returns the trimmed pane id', async () => {
    const { adapter, calls } = adapterWith([OK('%4\n')]);
    const pane = await adapter.newSession({
      session: 'demo',
      window: 'crew',
      width: 220,
      height: 50,
      cwd: '/repo',
      command: ['claude'],
    });
    expect(pane).toBe('%4');
    expect(calls[0]?.args).toEqual([
      'new-session',
      '-d',
      '-s',
      'demo',
      '-n',
      'crew',
      '-x',
      '220',
      '-y',
      '50',
      '-c',
      '/repo',
      '-P',
      '-F',
      '#{pane_id}',
      'claude',
    ]);
  });

  it('splitPane targets a window, returns the pane id, runs the command as argv', async () => {
    const { adapter, calls } = adapterWith([OK('%7\n')]);
    const pane = await adapter.splitPane({ target: 'demo:crew', cwd: '/repo', command: ['codex'] });
    expect(pane).toBe('%7');
    expect(calls[0]?.args).toEqual([
      'split-window',
      '-t',
      'demo:crew',
      '-c',
      '/repo',
      '-P',
      '-F',
      '#{pane_id}',
      'codex',
    ]);
  });

  it('injects pane env as `-e KEY=VALUE` (before the command) on newSession and splitPane', async () => {
    const token = 'a'.repeat(64);
    const sess = adapterWith([OK('%4\n')]);
    await sess.adapter.newSession({
      session: 'demo',
      window: 'crew',
      width: 220,
      height: 50,
      cwd: '/repo',
      command: ['claude'],
      env: { CREW_LAUNCH_TOKEN: token },
    });
    // `-e KEY=VALUE` sits after the flags and immediately before the pane command.
    expect(sess.calls[0]?.args.slice(-3)).toEqual(['-e', `CREW_LAUNCH_TOKEN=${token}`, 'claude']);

    const split = adapterWith([OK('%7\n')]);
    await split.adapter.splitPane({
      target: 'demo:crew',
      cwd: '/repo',
      command: ['codex'],
      env: { CREW_LAUNCH_TOKEN: token },
    });
    expect(split.calls[0]?.args.slice(-3)).toEqual(['-e', `CREW_LAUNCH_TOKEN=${token}`, 'codex']);
  });

  it('tileLayout and paneCommand build the expected argv', async () => {
    const tile = adapterWith([OK()]);
    await tile.adapter.tileLayout('demo:crew');
    expect(tile.calls[0]?.args).toEqual(['select-layout', '-t', 'demo:crew', 'tiled']);

    const cmd = adapterWith([OK('  node \n')]);
    expect(await cmd.adapter.paneCommand('%4')).toBe('node');
    expect(cmd.calls[0]?.args).toEqual([
      'display-message',
      '-p',
      '-t',
      '%4',
      '#{pane_current_command}',
    ]);
  });

  it('capturePane builds the expected argv for session and session:window targets', async () => {
    const bySession = adapterWith([OK('pane line 1\npane line 2\n')]);
    expect(await bySession.adapter.capturePane('demo')).toBe('pane line 1\npane line 2\n');
    expect(bySession.calls[0]).toMatchObject({
      file: 'tmux',
      args: ['capture-pane', '-p', '-t', 'demo'],
    });

    const byWindow = adapterWith([OK('relay output\n')]);
    await byWindow.adapter.capturePane('demo:crew-relay');
    expect(byWindow.calls[0]?.args).toEqual(['capture-pane', '-p', '-t', 'demo:crew-relay']);
  });

  it('capturePane returns the capture RAW — no trim, no control stripping (FR-U24 is the route)', async () => {
    const esc = String.fromCharCode(0x1b);
    const raw = `  ${esc}[31mred${esc}[0m text \n\n`;
    const { adapter } = adapterWith([OK(raw)]);
    expect(await adapter.capturePane('demo')).toBe(raw);
  });

  it('capturePane maps a failed capture to LAUNCH_FAILED and a missing tmux to DEPENDENCY_MISSING', async () => {
    const failed = adapterWith([{ status: 1, stdout: '', stderr: "can't find pane" }]);
    await expect(failed.adapter.capturePane('demo:absent')).rejects.toMatchObject({
      code: 'LAUNCH_FAILED',
    });

    const missing = adapterWith([{ status: null, stdout: '', stderr: '' }]);
    await expect(missing.adapter.capturePane('demo')).rejects.toMatchObject({
      code: 'DEPENDENCY_MISSING',
    });
  });

  it('capturePane maps a killed tmux command to a generic ERROR, not LAUNCH_FAILED or DEPENDENCY_MISSING', async () => {
    const killed = adapterWith([
      { status: null, stdout: '', stderr: '', killed: true, signal: 'SIGTERM' },
    ]);
    const failure = await killed.adapter.capturePane('demo').then(
      () => null,
      (err: unknown) => err as CrewError,
    );
    expect(failure).toMatchObject({
      code: 'ERROR',
      message: 'tmux capture-pane did not exit cleanly (signal SIGTERM)',
    });
    // capturePane serves the Console pane peek — never claim a launch failed.
    expect(failure?.message).not.toMatch(/launch/i);
  });

  it('killSession maps a killed tmux command to a generic ERROR — team stop is not a launch', async () => {
    const killed = adapterWith([
      { status: null, stdout: '', stderr: '', killed: true, signal: 'SIGTERM' },
    ]);
    const failure = await killed.adapter.killSession('demo').then(
      () => null,
      (err: unknown) => err as CrewError,
    );
    expect(failure).toMatchObject({
      code: 'ERROR',
      message: 'tmux kill-session did not exit cleanly (signal SIGTERM)',
    });
    expect(failure?.message).not.toMatch(/launch/i);
  });

  it('sets and reads the session ownership marker', async () => {
    const token = '123e4567-e89b-42d3-a456-426614174000';
    const set = adapterWith([OK()]);
    await set.adapter.setSessionOwner('demo', token);
    expect(set.calls[0]?.args).toEqual(['set-option', '-t', 'demo', '@crew_ownership', token]);

    const read = adapterWith([OK(`${token}\n`)]);
    expect(await read.adapter.sessionOwner('demo')).toBe(token);
    expect(read.calls[0]?.args).toEqual([
      'display-message',
      '-p',
      '-t',
      'demo',
      '#{@crew_ownership}',
    ]);

    const missing = adapterWith([OK('\n')]);
    expect(await missing.adapter.sessionOwner('demo')).toBeNull();
  });

  it('setBufferArg uses `--` so a value cannot be read as an option', async () => {
    const { adapter, calls } = adapterWith([OK()]);
    await adapter.setBufferArg('crewnudge', '-rf danger');
    expect(calls[0]?.args).toEqual(['set-buffer', '-b', 'crewnudge', '--', '-rf danger']);
  });

  it('loadBufferFile reads a file (untrusted body never on argv)', async () => {
    const { adapter, calls } = adapterWith([OK()]);
    await adapter.loadBufferFile('crewbrief', '/repo/.crew/generated/demo/manager-prompt.md');
    expect(calls[0]?.args).toEqual([
      'load-buffer',
      '-b',
      'crewbrief',
      '/repo/.crew/generated/demo/manager-prompt.md',
    ]);
  });

  it('pasteBuffer deletes-after and uses bracketed paste; sendEnter submits', async () => {
    const paste = adapterWith([OK()]);
    await paste.adapter.pasteBuffer({ bufferName: 'crewbrief', target: '%4' });
    expect(paste.calls[0]?.args).toEqual([
      'paste-buffer',
      '-d',
      '-p',
      '-b',
      'crewbrief',
      '-t',
      '%4',
    ]);

    const enter = adapterWith([OK()]);
    await enter.adapter.sendEnter('%4');
    expect(enter.calls[0]?.args).toEqual(['send-keys', '-t', '%4', 'Enter']);
  });

  it('newWindow and killSession build the expected argv', async () => {
    const win = adapterWith([OK('%8\n')]);
    expect(
      await win.adapter.newWindow({
        session: 'demo',
        window: 'crew-relay',
        cwd: '/repo',
        command: ['crew', 'relay', '--internal'],
      }),
    ).toBe('%8');
    expect(win.calls[0]?.args).toEqual([
      'new-window',
      '-d',
      '-t',
      'demo',
      '-n',
      'crew-relay',
      '-c',
      '/repo',
      '-P',
      '-F',
      '#{pane_id}',
      'crew',
      'relay',
      '--internal',
    ]);

    const kill = adapterWith([OK()]);
    await kill.adapter.killSession('demo');
    expect(kill.calls[0]?.args).toEqual(['kill-session', '-t', '=demo']);
  });

  it('attach goes through the interactive seam (not runProcess) and returns its code', async () => {
    const inter = recordingRunInteractive(0);
    const { io } = captureIo({ runInteractive: inter.runInteractive });
    const adapter = createTmuxAdapter(io);
    expect(await adapter.attach('demo')).toBe(0);
    expect(inter.calls[0]).toEqual({ file: 'tmux', args: ['attach-session', '-t', '=demo'] });
  });
});

describe('tmux adapter error boundary', () => {
  it('a non-zero exit throws LAUNCH_FAILED with a redacted, control-stripped, truncated diagnostic', async () => {
    const esc = String.fromCharCode(0x1b);
    const noisy = `${esc}[31mfatal:${esc}[0m token=ghp_${'A'.repeat(40)} ${'x'.repeat(400)}`;
    const { adapter } = adapterWith([{ status: 1, stdout: '', stderr: noisy }]);
    const err = await adapter.tileLayout('demo:crew').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrewError);
    const message = (err as CrewError).message;
    expect((err as CrewError).code).toBe('LAUNCH_FAILED');
    expect(message).toContain('tmux select-layout failed (exit 1)');
    expect(message).not.toContain('ghp_'); // secret redacted
    expect(message).not.toContain(esc); // control stripped
    expect(message).toContain('[REDACTED]');
    expect(message.length).toBeLessThan(400); // truncated snippet
  });

  it('a spawn failure (status null) throws DEPENDENCY_MISSING', async () => {
    const { adapter } = adapterWith([{ status: null, stdout: '', stderr: '' }]);
    await expect(
      adapter.newWindow({
        session: 'demo',
        window: 'crew-relay',
        cwd: '/repo',
        command: ['crew'],
      }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_MISSING' });
  });

  it('a killed control command (status null + signal) throws a generic ERROR, not LAUNCH_FAILED', async () => {
    const { adapter } = adapterWith([
      { status: null, stdout: '', stderr: '', killed: true, signal: 'SIGTERM' },
    ]);
    await expect(
      adapter.newWindow({
        session: 'demo',
        window: 'crew-relay',
        cwd: '/repo',
        command: ['crew'],
      }),
    ).rejects.toMatchObject({ code: 'ERROR' });
  });

  it('a genuine launch-step failure (non-zero exit) keeps LAUNCH_FAILED', async () => {
    const { adapter } = adapterWith([{ status: 1, stdout: '', stderr: 'duplicate session' }]);
    await expect(
      adapter.newSession({
        session: 'demo',
        window: 'crew',
        width: 220,
        height: 50,
        cwd: '/repo',
        command: ['claude'],
      }),
    ).rejects.toMatchObject({ code: 'LAUNCH_FAILED' });
  });

  it('redacts a secret whose closing delimiter sits past the display cap (redact before truncate, C8)', async () => {
    // The keyed secret's closing quote is past the 240-char display cap. Truncating
    // first would strip the quote and defeat the redactor; redacting the full input
    // first must still mask it.
    const stderr = `${'x'.repeat(224)} password="hunter2supersecret"`;
    const { adapter } = adapterWith([{ status: 1, stdout: '', stderr }]);
    const err = await adapter.tileLayout('demo:crew').catch((e: unknown) => e);
    const message = (err as CrewError).message;
    expect(message).not.toContain('hunter2'); // the value never leaks
    expect(message).toContain('password='); // the key survives for context
  });
});
