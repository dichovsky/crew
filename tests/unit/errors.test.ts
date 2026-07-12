import { describe, it, expect } from 'vitest';
import { CrewError, exitCodeForError } from '../../src/errors.js';

describe('CrewError', () => {
  it('carries code, message, and optional details', () => {
    const e = new CrewError('TASK_CONFLICT', 'Task is submitted, expected in_progress', {
      task_id: 'x',
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('TASK_CONFLICT');
    expect(e.message).toBe('Task is submitted, expected in_progress');
    expect(e.details).toEqual({ task_id: 'x' });
  });

  it('leaves details undefined when not supplied', () => {
    const e = new CrewError('USAGE', 'bad');
    expect(e.details).toBeUndefined();
  });

  it('maps usage/config codes to exit 2 and domain codes to exit 1', () => {
    expect(exitCodeForError(new CrewError('USAGE', 'x'))).toBe(2);
    expect(exitCodeForError(new CrewError('INVALID_CONFIG', 'x'))).toBe(2);
    expect(exitCodeForError(new CrewError('NOT_WORKSPACE', 'x'))).toBe(1);
    expect(exitCodeForError(new CrewError('CONTENTION', 'x'))).toBe(1);
    expect(exitCodeForError(new CrewError('TASK_CONFLICT', 'x'))).toBe(1);
    expect(exitCodeForError(new CrewError('ERROR', 'x'))).toBe(1);
  });

  it('treats unknown throwables as operational exit 1', () => {
    expect(exitCodeForError(new Error('boom'))).toBe(1);
    expect(exitCodeForError('boom')).toBe(1);
  });
});
