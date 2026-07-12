/**
 * Machine error taxonomy for crew (see cli-contract.md "Error codes").
 *
 * Every operational/usage failure is a {@link CrewError} carrying one of these
 * codes; the Program seam maps the code to an exit status and a human/JSON
 * rendering. Unknown throwables are treated as operational (exit 1).
 */
export type ErrorCode =
  | 'USAGE'
  | 'INVALID_CONFIG'
  | 'NOT_WORKSPACE'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'AGENT_INACTIVE'
  | 'TASK_CONFLICT'
  | 'TEAM_DRIFT'
  | 'CONTENTION'
  | 'INTEGRITY'
  | 'UNSUPPORTED_SCHEMA'
  | 'UNSUPPORTED_PLATFORM'
  | 'UNSAFE_PATH'
  | 'DEPENDENCY_MISSING'
  | 'ACTIVE_AGENTS'
  | 'STALE_STORE'
  | 'ERROR'
  | 'LAUNCH_FAILED';

/** Codes that signal a usage/configuration failure and exit 2; all others exit 1. */
const EXIT_2_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['USAGE', 'INVALID_CONFIG']);

export class CrewError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CrewError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

/** Resolve the process exit status for any throwable per the exit taxonomy. */
export function exitCodeForError(err: unknown): number {
  if (err instanceof CrewError) {
    return EXIT_2_CODES.has(err.code) ? 2 : 1;
  }
  return 1;
}
