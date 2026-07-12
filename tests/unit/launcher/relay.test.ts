/**
 * Truth-table proof of the pure Relay reducer:
 * first-observation, new-message, reminder-boundary, emptied-inbox, partial-read,
 * and multi-Agent independence — all deterministic with `now` as a parameter.
 */
import { describe, expect, it } from 'vitest';
import {
  type AgentThrottle,
  type InboxObservation,
  relayStep,
  type RelayState,
  type StaleLeaseObservation,
  staleLeaseStep,
  type StaleLeaseState,
  type TaskThrottle,
} from '../../../src/launcher/relay.js';

const CONFIG = { reminderSeconds: 30 };

function state(entries: Record<string, AgentThrottle>): RelayState {
  return new Map(Object.entries(entries));
}

function obs(agentId: string, unreadCount: number, maxUnreadId: number | null): InboxObservation {
  return { agentId, unreadCount, maxUnreadId };
}

function taskState(entries: Record<string, TaskThrottle>): StaleLeaseState {
  return new Map(Object.entries(entries));
}

function staleObs(taskId: string, creatorId: string): StaleLeaseObservation {
  return { taskId, creatorId };
}

describe('relayStep', () => {
  it('nudges on first observation of unread work and records the nudge time', () => {
    const r = relayStep(new Map(), [obs('worker', 2, 17)], 100, CONFIG);
    expect(r.nudges).toEqual(['worker']);
    expect(r.state.get('worker')).toEqual({ lastSeenMaxId: 17, lastReminderAt: 100 });
  });

  it('does not nudge an empty Inbox and leaves the reminder clock cleared', () => {
    const r = relayStep(new Map(), [obs('worker', 0, null)], 100, CONFIG);
    expect(r.nudges).toEqual([]);
    expect(r.state.get('worker')).toEqual({ lastSeenMaxId: null, lastReminderAt: null });
  });

  it('nudges again immediately when a new Message raises the max unread id', () => {
    const prior = state({ worker: { lastSeenMaxId: 17, lastReminderAt: 100 } });
    const r = relayStep(prior, [obs('worker', 3, 18)], 105, CONFIG);
    expect(r.nudges).toEqual(['worker']);
    expect(r.state.get('worker')).toEqual({ lastSeenMaxId: 18, lastReminderAt: 105 });
  });

  it('stays quiet when unread is unchanged and the reminder is not yet due', () => {
    const prior = state({ worker: { lastSeenMaxId: 18, lastReminderAt: 105 } });
    const r = relayStep(prior, [obs('worker', 3, 18)], 120, CONFIG); // 15s < 30s
    expect(r.nudges).toEqual([]);
    expect(r.state.get('worker')).toEqual({ lastSeenMaxId: 18, lastReminderAt: 105 });
  });

  it('re-nudges when the reminder interval has elapsed while unread work remains', () => {
    const prior = state({ worker: { lastSeenMaxId: 18, lastReminderAt: 105 } });
    const r = relayStep(prior, [obs('worker', 3, 18)], 135, CONFIG); // 30s >= 30s
    expect(r.nudges).toEqual(['worker']);
    expect(r.state.get('worker')).toEqual({ lastSeenMaxId: 18, lastReminderAt: 135 });
  });

  it('treats the reminder boundary as due at exactly reminderSeconds, not just under', () => {
    const prior = state({ worker: { lastSeenMaxId: 18, lastReminderAt: 100 } });
    const justUnder = relayStep(prior, [obs('worker', 1, 18)], 129, CONFIG); // 29s
    expect(justUnder.nudges).toEqual([]);
    const exactly = relayStep(prior, [obs('worker', 1, 18)], 130, CONFIG); // 30s
    expect(exactly.nudges).toEqual(['worker']);
  });

  it('resets the reminder clock when the Inbox empties, so the next arrival nudges at once', () => {
    const prior = state({ worker: { lastSeenMaxId: 18, lastReminderAt: 105 } });
    const cleared = relayStep(prior, [obs('worker', 0, null)], 140, CONFIG);
    expect(cleared.nudges).toEqual([]);
    expect(cleared.state.get('worker')).toEqual({ lastSeenMaxId: null, lastReminderAt: null });
    // A fresh Message after the clear nudges immediately.
    const arrived = relayStep(cleared.state, [obs('worker', 1, 22)], 145, CONFIG);
    expect(arrived.nudges).toEqual(['worker']);
  });

  it('does not treat a falling max unread id (partial read) as a new Message', () => {
    const prior = state({ worker: { lastSeenMaxId: 20, lastReminderAt: 100 } });
    const r = relayStep(prior, [obs('worker', 1, 18)], 110, CONFIG); // read #19,#20; reminder not due
    expect(r.nudges).toEqual([]);
    expect(r.state.get('worker')).toEqual({ lastSeenMaxId: 18, lastReminderAt: 100 });
  });

  it('decides each Agent independently in one poll', () => {
    const prior = state({
      manager: { lastSeenMaxId: 5, lastReminderAt: 100 },
      worker: { lastSeenMaxId: 9, lastReminderAt: 100 },
      inspector: { lastSeenMaxId: 3, lastReminderAt: 100 },
    });
    const r = relayStep(
      prior,
      [
        obs('manager', 1, 5), // unchanged, reminder not due → quiet
        obs('worker', 2, 11), // new message → nudge
        obs('inspector', 0, null), // emptied → quiet + reset
      ],
      110,
      CONFIG,
    );
    expect(r.nudges).toEqual(['worker']);
    expect(r.state.get('manager')).toEqual({ lastSeenMaxId: 5, lastReminderAt: 100 });
    expect(r.state.get('worker')).toEqual({ lastSeenMaxId: 11, lastReminderAt: 110 });
    expect(r.state.get('inspector')).toEqual({ lastSeenMaxId: null, lastReminderAt: null });
  });

  it('does not mutate the input state map', () => {
    const prior = state({ worker: { lastSeenMaxId: 1, lastReminderAt: 100 } });
    relayStep(prior, [obs('worker', 1, 9)], 200, CONFIG);
    expect(prior.get('worker')).toEqual({ lastSeenMaxId: 1, lastReminderAt: 100 });
  });
});

describe('staleLeaseStep', () => {
  it('nudges the creator on first observation of a stale Task and records the nudge time', () => {
    const r = staleLeaseStep(new Map(), [staleObs('task-1', 'manager')], 100, CONFIG);
    expect(r.nudges).toEqual([{ taskId: 'task-1', creatorId: 'manager' }]);
    expect(r.state.get('task-1')).toEqual({ lastReminderAt: 100 });
  });

  it('stays quiet while the Task remains stale and the reminder is not yet due', () => {
    const prior = taskState({ 'task-1': { lastReminderAt: 100 } });
    const r = staleLeaseStep(prior, [staleObs('task-1', 'manager')], 120, CONFIG); // 20s < 30s
    expect(r.nudges).toEqual([]);
    expect(r.state.get('task-1')).toEqual({ lastReminderAt: 100 });
  });

  it('re-nudges when the reminder interval has elapsed while the Task is still stale', () => {
    const prior = taskState({ 'task-1': { lastReminderAt: 100 } });
    const r = staleLeaseStep(prior, [staleObs('task-1', 'manager')], 130, CONFIG); // 30s >= 30s
    expect(r.nudges).toEqual([{ taskId: 'task-1', creatorId: 'manager' }]);
    expect(r.state.get('task-1')).toEqual({ lastReminderAt: 130 });
  });

  it('treats the reminder boundary as due at exactly reminderSeconds, not just under', () => {
    const prior = taskState({ 'task-1': { lastReminderAt: 100 } });
    const justUnder = staleLeaseStep(prior, [staleObs('task-1', 'manager')], 129, CONFIG);
    expect(justUnder.nudges).toEqual([]);
    const exactly = staleLeaseStep(prior, [staleObs('task-1', 'manager')], 130, CONFIG);
    expect(exactly.nudges).toEqual([{ taskId: 'task-1', creatorId: 'manager' }]);
  });

  it('drops a Task that is no longer observed (requeued/abandoned/completed) with no lingering entry', () => {
    const prior = taskState({ 'task-1': { lastReminderAt: 100 } });
    const r = staleLeaseStep(prior, [], 105, CONFIG);
    expect(r.nudges).toEqual([]);
    expect(r.state.has('task-1')).toBe(false);
  });

  it('nudges immediately when a Task recovers then goes stale again (fresh throttle entry)', () => {
    const cleared = staleLeaseStep(
      taskState({ 'task-1': { lastReminderAt: 100 } }),
      [],
      105,
      CONFIG,
    );
    expect(cleared.state.has('task-1')).toBe(false);
    const restaled = staleLeaseStep(cleared.state, [staleObs('task-1', 'manager')], 110, CONFIG);
    expect(restaled.nudges).toEqual([{ taskId: 'task-1', creatorId: 'manager' }]);
  });

  it('decides each Task independently in one poll, including two Tasks from the same creator', () => {
    const prior = taskState({
      'task-1': { lastReminderAt: 100 }, // not due at 110
      'task-2': { lastReminderAt: 70 }, // due at 110 (40s >= 30s)
    });
    const r = staleLeaseStep(
      prior,
      [
        staleObs('task-1', 'manager'),
        staleObs('task-2', 'manager'),
        staleObs('task-3', 'inspector'),
      ],
      110,
      CONFIG,
    );
    // task-1 quiet, task-2 due, task-3 new — each Task decided on its own clock,
    // and a creator with two due Tasks (here it doesn't, but the shape proves it
    // could) would get two distinct entries, not one collapsed nudge.
    expect(r.nudges).toEqual([
      { taskId: 'task-2', creatorId: 'manager' },
      { taskId: 'task-3', creatorId: 'inspector' },
    ]);
    expect(r.state.get('task-1')).toEqual({ lastReminderAt: 100 });
    expect(r.state.get('task-2')).toEqual({ lastReminderAt: 110 });
    expect(r.state.get('task-3')).toEqual({ lastReminderAt: 110 });
  });

  it('gives a creator with two independently-due stale Tasks two distinct nudge entries', () => {
    const prior = taskState({
      'task-1': { lastReminderAt: 70 }, // due at 110
      'task-2': { lastReminderAt: 70 }, // also due at 110
    });
    const r = staleLeaseStep(
      prior,
      [staleObs('task-1', 'manager'), staleObs('task-2', 'manager')],
      110,
      CONFIG,
    );
    expect(r.nudges).toEqual([
      { taskId: 'task-1', creatorId: 'manager' },
      { taskId: 'task-2', creatorId: 'manager' },
    ]);
  });

  it('does not mutate the input state map', () => {
    const prior = taskState({ 'task-1': { lastReminderAt: 100 } });
    staleLeaseStep(prior, [staleObs('task-1', 'manager')], 200, CONFIG);
    expect(prior.get('task-1')).toEqual({ lastReminderAt: 100 });
  });
});
