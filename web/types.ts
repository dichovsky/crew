/**
 * Type definitions for the Console API.
 *
 * The Workspace snapshot shapes are NOT redeclared here: they are re-exported
 * from `src/ui/snapshot-records.ts`, the same declarations the server builds
 * its payload from, so the two surfaces cannot drift. That module is a leaf —
 * it never imports the Store — which is what lets this DOM-only program
 * (`types: []`, so no Node builtins resolve) reach into `src/` at all.
 *
 * The session shapes below stay local. They originate in `src/ui/server.ts`,
 * which is bound to the Node graph, so there is no leaf to share them from;
 * they remain hand-mirrored against the routes named in each comment.
 */
export type {
  AgentSnapshotRecord,
  InboxStateSnapshotRecord,
  MessageSnapshotRecord,
  TaskEventSnapshotRecord,
  TaskSnapshotRecord,
  WorkspaceSnapshot,
} from '../src/ui/snapshot-records.js';

/** Mirror of the `session` record from GET /api/sessions (Operations view). */
export interface SessionSnapshotRecord {
  readonly type: 'session';
  readonly schema_version: 1;
  readonly session_name: string;
  readonly pane_count: number;
  readonly agent_count: number;
  /** Launch time in epoch seconds. */
  readonly started_at: number;
}

/** Mirror of the resumable-session record from GET /api/resumable-sessions. */
export interface ResumableSessionSnapshotRecord {
  readonly type: 'resumable_session';
  readonly schema_version: 1;
  readonly session_name: string;
  readonly team: string;
  readonly stopped_at: number;
  readonly agents_archived: number;
}
