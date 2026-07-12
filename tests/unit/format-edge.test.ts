import { describe, it, expect } from 'vitest';
import { CrewError } from '../../src/errors.js';
import { formatTimestamp, messageOf, renderLaunchPlanHuman, writeError } from '../../src/format.js';
import type { Io } from '../../src/io.js';
import type { BriefMeta, LaunchAssembly, LaunchPlan } from '../../src/launcher/plan.js';

/**
 * Edge-branch coverage for src/format.ts that the primary format.test.ts suite
 * does not exercise: messageOf on a non-Error (24), redactValue over arrays /
 * nested objects / null-and-primitive leaves (190, 191, 199), writeError's human
 * surface for a non-CrewError (232), and renderLaunchPlanHuman's worktree-enabled
 * (351), relay-enabled/disabled (359), custom-role pane-breakdown sort (318), and
 * present/absent brief (372) branches. Pure functions only — no workspace, no run().
 */

// Verbatim capture seam from tests/unit/format.test.ts: a fixed clock keeps every
// case deterministic and no Date.now/random is reached for.
function captureIo(): { out: string[]; err: string[]; io: Io } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd: '/tmp',
    env: {},
    stdin: process.stdin,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    clock: () => 0,
    random: () => 0.5,
    runProcess: () => Promise.resolve({ status: null, stdout: '', stderr: '' }),
    runInteractive: () => Promise.resolve(0),
  };
  return { out, err, io };
}

// A fully-typed baseline plan; each renderLaunchPlanHuman case spreads new
// sub-objects over it (immutability: nothing is mutated in place).
const BASE_PLAN: LaunchPlan = {
  schema_version: 1,
  session_name: 'crew-demo',
  created_at: 0,
  team: 'dev',
  client: 'claude-code',
  executable: 'claude',
  worktree: { enabled: false, path: null, branch: null, base_ref: 'HEAD' },
  relay: { enabled: true, poll_seconds: 5, reminder_seconds: 120, attach: true },
  roster: [{ agent_id: 'manager-1', role: 'manager', replica_base: 'manager' }],
  focus: { files: [], docs: [] },
  constraints: [],
  task_brief: { present: false, target_role: 'manager' },
  artifacts: ['pane-map.json'],
};

const ABSENT_BRIEF: BriefMeta = {
  present: false,
  path: '.crew/run-task.md',
  lineCount: null,
  explicit: false,
  body: null,
};

describe('messageOf', () => {
  it('coerces a non-Error throwable via String() (line 24)', () => {
    expect(messageOf('plain string')).toBe('plain string');
    expect(messageOf(42)).toBe('42');
    expect(messageOf(null)).toBe('null');
  });
});

describe('writeError redactValue traversal', () => {
  it('redacts string leaves inside array and nested-object details, leaving null/number/boolean untouched (lines 190,191,199)', () => {
    const err = new CrewError('INVALID_CONFIG', 'config rejected', {
      list: ['password=hunter2supersecret', 'ordinary value'],
      nested: { token: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWX0123456789' },
      empty: null,
      count: 42,
      flag: true,
    });

    const { err: stderr, io } = captureIo();
    writeError(io, err, true);
    const parsed = JSON.parse(stderr.join('')) as {
      error: {
        details: {
          list: [string, string];
          nested: { token: string };
          empty: null;
          count: number;
          flag: boolean;
        };
      };
    };
    // Array branch (190): each string leaf is redacted; a benign string survives.
    expect(parsed.error.details.list[0]).toBe('password=[REDACTED]');
    expect(parsed.error.details.list[1]).toBe('ordinary value');
    // Object branch (191, recursive): the nested token is masked whole.
    expect(parsed.error.details.nested.token).toBe('[REDACTED]');
    // null short-circuits `value !== null` and the number/boolean fall through to
    // the passthrough return (199) unchanged.
    expect(parsed.error.details.empty).toBe(null);
    expect(parsed.error.details.count).toBe(42);
    expect(parsed.error.details.flag).toBe(true);
  });
});

describe('writeError human surface for a non-CrewError', () => {
  it('renders an unknown throwable under the ERROR code (line 232)', () => {
    const { out, err, io } = captureIo();
    writeError(io, new Error('boom happened'), false);
    expect(err.join('')).toBe('[ERROR] boom happened\n');
    expect(out).toEqual([]);
  });
});

describe('renderLaunchPlanHuman branches', () => {
  it('renders an enabled worktree, enabled relay, custom-role panes, and a present brief with a line count (lines 318,351,359,372)', () => {
    const assembly: LaunchAssembly = {
      plan: {
        ...BASE_PLAN,
        worktree: {
          enabled: true,
          path: '/data/crew/worktrees/abc/feature-x',
          branch: 'feature/x',
          base_ref: 'HEAD',
        },
        relay: { enabled: true, poll_seconds: 5, reminder_seconds: 120, attach: true },
        // Two roles outside ROLE_ORDER force the `=== -1` sort branches (line 318).
        roster: [
          { agent_id: 'manager-1', role: 'manager', replica_base: 'manager' },
          { agent_id: 'worker-1', role: 'worker', replica_base: 'worker' },
          { agent_id: 'scout-1', role: 'scout', replica_base: 'scout' },
          { agent_id: 'gremlin-1', role: 'gremlin', replica_base: 'gremlin' },
        ],
        focus: { files: ['src/a.ts'], docs: ['docs/x.md'] },
        constraints: ['no network'],
      },
      clientSource: 'flag',
      brief: {
        present: true,
        path: '.crew/run-task.md',
        lineCount: 5,
        explicit: false,
        body: 'brief body',
      },
    };

    const { out, io } = captureIo();
    renderLaunchPlanHuman(io, assembly);
    const text = out.join('');
    // Worktree-enabled branch (351).
    expect(text).toContain(
      'Worktree: /data/crew/worktrees/abc/feature-x branch=feature/x base=HEAD',
    );
    // Relay enabled + attach yes (359).
    expect(text).toContain('Relay: enabled poll=5s reminder=120s attach=yes');
    // Custom roles sort after the canonical ones and appear in the breakdown (318).
    expect(text).toContain('Panes: 1 manager + 1 worker + 1 scout + 1 gremlin = 4');
    // Present brief with a numeric line count (372).
    expect(text).toContain('Task brief: .crew/run-task.md (5 lines) → Manager, under guard');
  });

  it('renders a disabled worktree, disabled relay, empty constraints, and an absent brief (lines 359,369,377)', () => {
    const assembly: LaunchAssembly = {
      plan: {
        ...BASE_PLAN,
        worktree: { enabled: false, path: null, branch: null, base_ref: 'HEAD' },
        relay: { enabled: false, poll_seconds: 5, reminder_seconds: 120, attach: false },
        roster: [
          { agent_id: 'manager-1', role: 'manager', replica_base: 'manager' },
          { agent_id: 'inspector-1', role: 'inspector', replica_base: 'inspector' },
        ],
        focus: { files: [], docs: [] },
        constraints: [],
      },
      clientSource: 'default',
      brief: ABSENT_BRIEF,
    };

    const { out, io } = captureIo();
    renderLaunchPlanHuman(io, assembly);
    const text = out.join('');
    expect(text).toContain('Worktree: disabled');
    // Relay disabled + attach no — the opposite side of line 359.
    expect(text).toContain('Relay: disabled poll=5s reminder=120s attach=no');
    // Empty constraints emit the `(none)` placeholder (369).
    expect(text).toContain('Constraints:\n  (none)');
    // Absent-brief branch (377).
    expect(text).toContain('Task brief: none (.crew/run-task.md absent)');
  });

  it('renders a present brief whose line count is unknown as `?` (line 372 null ternary)', () => {
    const assembly: LaunchAssembly = {
      plan: BASE_PLAN,
      clientSource: 'config',
      brief: {
        present: true,
        path: '.crew/run-task.md',
        lineCount: null,
        explicit: false,
        body: 'brief body',
      },
    };

    const { out, io } = captureIo();
    renderLaunchPlanHuman(io, assembly);
    expect(out.join('')).toContain(
      'Task brief: .crew/run-task.md (? lines) → Manager, under guard',
    );
  });
});

describe('formatTimestamp', () => {
  it('renders trimmed UTC ISO-8601 (no always-zero millisecond field)', () => {
    // 1767225600 === 2026-01-01T00:00:00Z. Timestamps are stored as whole
    // seconds, so the `.000` is dropped to match the cli-contract examples and
    // keep every command's timestamp column consistent (the commit-4 fix).
    expect(formatTimestamp(1_767_225_600)).toBe('2026-01-01T00:00:00Z');
    expect(formatTimestamp(0)).toBe('1970-01-01T00:00:00Z');
  });
});

describe('renderLaunchPlanHuman worktree null-field fallbacks', () => {
  it('tolerates an enabled worktree whose path/branch are still null (line 443 ?? arms)', () => {
    // An enabled worktree normally carries a path and branch; the renderer must
    // not crash (or print "null") if a hand-edited or older plan omits them.
    const assembly: LaunchAssembly = {
      plan: {
        ...BASE_PLAN,
        worktree: { enabled: true, path: null, branch: null, base_ref: 'HEAD' },
      },
      clientSource: 'flag',
      brief: ABSENT_BRIEF,
    };

    const { out, io } = captureIo();
    renderLaunchPlanHuman(io, assembly);
    expect(out.join('')).toContain('Worktree:  branch= base=HEAD');
  });
});
