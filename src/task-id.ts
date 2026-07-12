/** Shared Task-id grammar and argument validation. */
import { CrewError } from './errors.js';

/** Task ids are crew-generated UUIDv4 strings (data-model "Tasks"). */
export const TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Reject a malformed Task id before any State Store lookup or mutation. */
export function assertTaskId(id: string): void {
  if (!TASK_ID_PATTERN.test(id)) {
    throw new CrewError('USAGE', `invalid task id "${id}"; expected a UUIDv4 string`);
  }
}
