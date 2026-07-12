import { describe, expect, it } from 'vitest';
import { renderUiStarted } from '../../src/format.js';
import { captureIo } from '../helpers/io.js';

const ESC = String.fromCharCode(0x1b);

describe('renderUiStarted', () => {
  const result = {
    url: 'http://127.0.0.1:43127/?token=example-per-run-token',
    port: 43127,
    workspace: '/repo/.crew',
  };

  it('emits the contract ui_started NDJSON record in machine mode', () => {
    const { io, out, err } = captureIo();
    renderUiStarted(io, result, true);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual({
      type: 'ui_started',
      schema_version: 1,
      url: 'http://127.0.0.1:43127/?token=example-per-run-token',
      port: 43127,
      workspace: '/repo/.crew',
    });
  });

  it('prints the authenticated URL and workspace on the human surface', () => {
    const { io, out, err } = captureIo();
    renderUiStarted(io, result, false);
    expect(err).toEqual([]);
    const text = out.join('');
    expect(text).toContain('http://127.0.0.1:43127/?token=example-per-run-token');
    expect(text).toContain('/repo/.crew');
    expect(text).toContain('Ctrl-C');
  });

  it('sanitizes terminal controls on the human surface but keeps raw JSON bytes', () => {
    const hostile = {
      url: 'http://127.0.0.1:1/?token=x',
      port: 1,
      workspace: `/tmp/${ESC}[31mws/.crew`,
    };
    const human = captureIo();
    renderUiStarted(human.io, hostile, false);
    expect(human.out.join('')).not.toContain(ESC);
    expect(human.out.join('')).toContain('ws/.crew');
    const json = captureIo();
    renderUiStarted(json.io, hostile, true);
    expect((JSON.parse(json.out[0]!) as { workspace: string }).workspace).toBe(
      `/tmp/${ESC}[31mws/.crew`,
    );
  });
});
