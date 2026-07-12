/**
 * The Relay's reminder/throttle decision as a PURE reducer.
 * All branch-dense, security-adjacent logic lives here as a total
 * function of (state, per-Agent inbox observations, now) → (next state, nudges),
 * so it is exhaustively unit-testable as a truth table without timers, signals,
 * subprocesses, or a Store. The thin `crew relay` loop supplies the
 * observations (via the shared content-free summary query) and pastes a nudge
 * into each returned Agent's pane; it owns no decision logic.
 *
 * Nudge policy (FR-H17/H19): fire for an Agent when its highest unread id
 * INCREASED since last seen (a new Message arrived) OR the reminder interval has
 * elapsed since the last nudge while unread work remains. An emptied Inbox never
 * nudges and resets the reminder clock so the next arrival nudges immediately.
 *
 * `staleLeaseStep` is a second, independent pure reducer over the
 * same shape: it nudges a stale Task's CREATOR (not its now-stale assignee)
 * on its own per-Task throttle clock, so a Lease crossing its expiry stops
 * being a fact only a human polling `doctor` would ever notice.
 */

export interface RelayConfig {
  /** Minimum seconds between repeat reminders for the same unread backlog. */
  readonly reminderSeconds: number;
}

/** Per-Agent throttle memory held across polls (in the relay process, never persisted). */
export interface AgentThrottle {
  /** Highest unread id observed so far, or null when none has been seen. */
  readonly lastSeenMaxId: number | null;
  /** Epoch seconds of the last nudge fired for this Agent, or null when never. */
  readonly lastReminderAt: number | null;
}

/** One poll's content-free observation of an Agent's Inbox (from getPendingSummary). */
export interface InboxObservation {
  readonly agentId: string;
  readonly unreadCount: number;
  readonly maxUnreadId: number | null;
}

export type RelayState = ReadonlyMap<string, AgentThrottle>;

export interface RelayDecision {
  /** The throttle memory to carry into the next poll. */
  readonly state: RelayState;
  /** Agent ids to nudge this poll, in observation order. */
  readonly nudges: readonly string[];
}

const FRESH: AgentThrottle = { lastSeenMaxId: null, lastReminderAt: null };

/**
 * Decide, for one poll, which Agents to nudge and the throttle memory to carry
 * forward. Pure: it reads only its arguments and returns new objects.
 */
export function relayStep(
  state: RelayState,
  observations: readonly InboxObservation[],
  now: number,
  config: RelayConfig,
): RelayDecision {
  const next = new Map(state);
  const nudges: string[] = [];

  for (const obs of observations) {
    const prev = state.get(obs.agentId) ?? FRESH;

    if (obs.unreadCount <= 0) {
      // Inbox empty: never nudge; reset the reminder clock so the next arrival
      // nudges immediately, and forget the previous high-water mark.
      next.set(obs.agentId, { lastSeenMaxId: obs.maxUnreadId, lastReminderAt: null });
      continue;
    }

    const increased =
      obs.maxUnreadId !== null &&
      (prev.lastSeenMaxId === null || obs.maxUnreadId > prev.lastSeenMaxId);
    const reminderDue =
      prev.lastReminderAt !== null && now - prev.lastReminderAt >= config.reminderSeconds;

    if (increased || reminderDue) {
      nudges.push(obs.agentId);
      next.set(obs.agentId, { lastSeenMaxId: obs.maxUnreadId, lastReminderAt: now });
    } else {
      // Unread work remains but neither a new Message nor a due reminder: stay
      // quiet, but record the current high-water mark (it may have shifted down
      // as the Agent read newer Messages) and keep the existing reminder clock.
      next.set(obs.agentId, {
        lastSeenMaxId: obs.maxUnreadId,
        lastReminderAt: prev.lastReminderAt,
      });
    }
  }

  return { state: next, nudges };
}

/** One poll's observation of a currently-stale Task and who created it. */
export interface StaleLeaseObservation {
  readonly taskId: string;
  readonly creatorId: string;
}

/** Per-Task throttle memory for stale-lease reminders — independent of AgentThrottle. */
export interface TaskThrottle {
  readonly lastReminderAt: number | null;
}

export type StaleLeaseState = ReadonlyMap<string, TaskThrottle>;

export interface StaleLeaseDecision {
  /** The throttle memory to carry into the next poll, keyed by Task id. */
  readonly state: StaleLeaseState;
  /**
   * Task/creator pairs to nudge this poll, in observation order. Carries the
   * Task id (not just the creator id): a creator with two independently-due
   * stale Tasks gets two distinct entries, so the caller can reference the
   * right Task in each nudge rather than losing which one triggered it.
   */
  readonly nudges: readonly StaleLeaseObservation[];
}

/**
 * Decide, for one poll, which Task creators to nudge about a stale Lease and
 * the throttle memory to carry forward. Pure, mirroring relayStep's
 * "increased OR reminder due" shape but keyed by Task id and nudging the
 * Task's creator, not its (now-stale) assignee: a Task newly observed as
 * stale nudges immediately; while it stays stale, only the reminder interval
 * re-nudges. A Task no longer in `observations` (requeued, abandoned, or
 * completed) simply has no entry in the returned state — unlike an emptied
 * Inbox, there is no "cleared" throttle to remember, the Task is not stale.
 */
export function staleLeaseStep(
  state: StaleLeaseState,
  observations: readonly StaleLeaseObservation[],
  now: number,
  config: RelayConfig,
): StaleLeaseDecision {
  const next = new Map<string, TaskThrottle>();
  const nudges: StaleLeaseObservation[] = [];

  for (const obs of observations) {
    const prev = state.get(obs.taskId);
    const reminderDue =
      prev !== undefined &&
      prev.lastReminderAt !== null &&
      now - prev.lastReminderAt >= config.reminderSeconds;

    if (prev === undefined || reminderDue) {
      nudges.push(obs);
      next.set(obs.taskId, { lastReminderAt: now });
    } else {
      next.set(obs.taskId, prev);
    }
  }

  return { state: next, nudges };
}
