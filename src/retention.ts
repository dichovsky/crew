/**
 * Default retention windows shared by `prune` (its default cutoffs) and `doctor`
 * (the human retention footer), so both surfaces quote one source of truth.
 */
const DAY_SECONDS = 86_400;

/** Default age past which a read Message is eligible for `prune`. */
export const DEFAULT_MESSAGE_RETENTION_DAYS = 30;
/** Default age past which a completed Task is eligible for `prune`. */
export const DEFAULT_TASK_RETENTION_DAYS = 90;

export const DEFAULT_MESSAGE_RETENTION_SECONDS = DEFAULT_MESSAGE_RETENTION_DAYS * DAY_SECONDS;
export const DEFAULT_TASK_RETENTION_SECONDS = DEFAULT_TASK_RETENTION_DAYS * DAY_SECONDS;
