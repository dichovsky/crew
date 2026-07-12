/**
 * Live launch orchestration. Drives the validated launch plan
 * into a real tmux session through the semantic {@link TmuxAdapter}, so tests
 * exercise the full sequence against a fake adapter while the real adapter is
 * proven argv-exact separately.
 *
 * Ownership + teardown: a session is created with `new-session`;
 * from that point every step runs under a guard that, on ANY failure, tears down
 * the WHOLE session crew created this invocation and never touches a pre-existing
 * one. Only on a CONFIRMED teardown does a scoped reap DELETE the
 * UNTOUCHED Agent rows this launch created — stamped with a per-launch token — so
 * the same team is immediately relaunchable; touched or foreign rows are left for
 * `doctor`/retry. The reap is skipped when teardown could not be confirmed (live
 * panes must never be invalidated) and is best-effort otherwise. Readiness is
 * two-stage with a settle delay;
 * the untrusted brief reaches the Manager pane via a file load, the short
 * invocation via an argv buffer.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { CrewError } from '../errors.js';
import type { Io } from '../io.js';
import { getTarget, type ParticipantTarget, type SetupTarget } from '../platforms/registry.js';
import { openWorkspaceStore } from '../store/index.js';
import { isExecutableOnPath } from '../which.js';
import { resolveWorkspaceRoot } from '../workspace.js';
import { resolveWorktree, type WorktreeRequest, type WorktreeResolution } from '../worktree.js';
import { type PaneMap, type PaneMapPane, writePaneMap, writePlanArtifacts } from './artifacts.js';
import { managedWorktreeBase } from './derive.js';
import type { BriefMeta, LaunchAssembly, LaunchPlan, PlanRosterEntry } from './plan.js';
import { buildInspectorPrompt, buildManagerPrompt, buildRunSummary } from './prompts.js';
import { listOwnedSessions } from './sessions.js';
import type { TmuxAdapter } from './tmux.js';

/** Bounded timeout for the best-effort `git worktree remove` on a failed launch. */
const GIT_TIMEOUT_MS = 10_000;

const WINDOW_MAIN = 'crew';
const WINDOW_RELAY = 'crew-relay';
const SESSION_WIDTH = 220;
const SESSION_HEIGHT = 50;

// Bounded, attempt-based polls keep waits testable with an injected instant delay.
// The wall-clock budgets are sized for real interactive LLM CLIs: a pane process
// appears quickly, but registration waits on cold-start + skill load + a model turn
// + a `crew join` tool call across panes, so the join budget is generous (~2 min).
const READINESS_ATTEMPTS = 60;
const READINESS_POLL_MS = 500; // ~30s for the CLI process to appear
const SETTLE_MS = 500; // raw-mode settle before pasting into a heavy TUI
const JOIN_ATTEMPTS = 120;
const JOIN_POLL_MS = 1_000; // ~120s for the roster to run `crew join`
// Stage-2 attempt marks (~30s/~60s in) at which the invocation is re-pasted into
// panes whose Agent has not yet joined; two rounds, never more.
const REDELIVERY_MARKS: readonly number[] = [30, 60];

// tmux buffers are server-GLOBAL, so a fixed name would let concurrent launches /
// Relays (or an unrelated user buffer) clobber each other between set/load-buffer
// and paste-buffer -d. Each paste uses a collision-resistant unique name
// instead; paste-buffer -d deletes it, so none linger.
const INVOCATION_BUFFER_PREFIX = 'crew-inv';
const BRIEF_BUFFER_PREFIX = 'crew-brief';

/** A collision-resistant, single-use tmux buffer name for one paste operation. */
function uniqueBuffer(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export interface LiveLaunchDeps {
  readonly adapter: TmuxAdapter;
  /** Await between polls / for the settle delay; injected so tests run instantly. */
  readonly delay: (ms: number) => Promise<void>;
  /** Base argv for re-invoking crew as the Relay window command (e.g. [node, binPath]). */
  readonly relayBin: readonly string[];
  /** True when recovering a clean stop; pane invocations include `--resume`. */
  readonly resume?: boolean;
  /**
   * Called once the session is fully built, BEFORE the (blocking) attach — the
   * caller renders the `launch_result` here so the contract ("emitted before
   * attaching") holds even on the default attach path.
   */
  readonly onLaunched?: (result: LaunchResult) => void;
  /**
   * Resolve the registry Setup Target for the plan's client. Defaults to the
   * authoritative {@link getTarget}; production never overrides it. The full
   * real-tmux launch e2e injects a homogeneous FAKE Participant target here
   * (readiness matched to the fake's interpreter process name) so the whole live
   * path runs against real tmux without a shipped test hook.
   */
  readonly resolveTarget?: (client: string) => SetupTarget | undefined;
  /**
   * Resolve (create/reuse) the single whole-Crew worktree for a worktree-enabled
   * plan. Defaults to the real {@link resolveWorktree}; tests inject a fake the
   * same way they do for {@link resolveTarget}, so the worktree git calls never
   * touch a real repository in a unit test.
   */
  readonly resolveWorktree?: (io: Io, req: WorktreeRequest) => Promise<WorktreeResolution>;
  /**
   * Force a DETACHED launch regardless of the plan's attach setting: the
   * session is built and readiness-verified exactly as usual, but no attach
   * call ever reaches the tmux adapter (ADR-0012: a Console-started launch is
   * detached; attaching stays a terminal-only action). Default false — the
   * CLI's plan-driven attach behavior is unchanged.
   */
  readonly noAttach?: boolean;
}

export interface LaunchResult {
  readonly sessionName: string;
  readonly panes: number;
  readonly relay: boolean;
  readonly attached: boolean;
}

interface PaneAgent {
  readonly agentId: string;
  readonly role: string;
  readonly paneId: string;
  readonly command: readonly string[];
  readonly invocation: string;
  readonly pasteInvocation: boolean;
}

function paneLaunch(
  executable: string,
  target: ParticipantTarget,
  role: string,
  agentId: string,
  resume: boolean,
): Pick<PaneAgent, 'command' | 'invocation' | 'pasteInvocation'> {
  const options = { resume };
  const args = target.launchArgs?.(role, agentId, options);
  if (args !== undefined) {
    const command = [executable, ...args];
    return { command, invocation: command.join(' '), pasteInvocation: false };
  }
  return {
    command: [executable],
    invocation: target.invocation(role, agentId, options),
    pasteInvocation: true,
  };
}

/** Poll `check` up to `attempts` times with `delay` between; return the first non-null result. */
async function pollUntil<T>(
  check: () => Promise<T | null> | T | null,
  attempts: number,
  intervalMs: number,
  delay: (ms: number) => Promise<void>,
): Promise<T | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await check();
    if (result !== null) return result;
    if (attempt < attempts - 1) await delay(intervalMs);
  }
  return null;
}

/** Shared inputs for building the owned tmux session (post-preflight). */
interface OwnedSessionContext {
  readonly io: Io;
  readonly deps: LiveLaunchDeps;
  readonly plan: LaunchPlan;
  readonly root: string;
  readonly session: string;
  readonly target: ParticipantTarget;
  readonly readinessNames: readonly string[];
  readonly paneEnv: { readonly CREW_LAUNCH_TOKEN: string };
  readonly ownershipToken: string;
  readonly managerPromptPath: string;
}

/**
 * Build the live tmux session for an already-validated plan. The flow is:
 * preflight (resolves/creates the single whole-Crew worktree when enabled,
 * ADR-0011 — the only mutation preflight performs) → write artifacts into the
 * launch root (the worktree once resolved, else the workspace root) → create
 * the owned session → build it under a teardown guard (which also removes a
 * NEWLY created worktree on a confirmed teardown) → emit the result → attach
 * outside the guard.
 */
export async function runLiveLaunch(
  io: Io,
  deps: LiveLaunchDeps,
  assembly: LaunchAssembly,
): Promise<LaunchResult> {
  const { adapter } = deps;
  const { plan, brief } = assembly;
  const root = resolveWorkspaceRoot(io.cwd);
  const session = plan.session_name;

  const { target, managerEntry, worktree } = await preflightLaunch(io, deps, assembly, root);
  // ADR-0011: once a worktree is resolved, the launched Crew's artifacts, Store,
  // and pane `cwd` all live in the worktree — discovered exactly like any other
  // `.crew/` workspace. `root` stays the repo the plan/config were read from
  // (used below only to run `git worktree remove` on a failed NEW worktree).
  const launchRoot = worktree?.path ?? root;
  const readinessNames = target.readinessNames;
  const { managerPromptPath } = buildLaunchArtifacts(
    launchRoot,
    session,
    plan,
    brief,
    managerEntry,
  );

  // A per-launch crypto token: injected into each participant pane's
  // environment so the Agent its own `crew join` creates is stamped with this
  // launch's provenance, scoping the failed-teardown reap below to rows THIS
  // invocation created. Generated with node:crypto — never the seedable
  // contention RNG — and never rendered to any surface.
  const launchToken = randomBytes(32).toString('hex');
  // Separate from launch provenance: this UUID is not an authority secret. It
  // binds the generated pane map to this exact live tmux session instance so a
  // stale map can never authorize a later session that reuses its name/ids.
  const ownershipToken = randomUUID();
  const paneEnv = { CREW_LAUNCH_TOKEN: launchToken } as const;
  const resume = deps.resume === true;

  // Create the session (its first pane runs the first roster agent). From here a
  // failure must tear down the whole owned session.
  const [first, ...rest] = plan.roster;
  if (first === undefined) {
    throw new CrewError('USAGE', 'the team roster is empty');
  }
  const firstLaunch = paneLaunch(plan.executable, target, first.role, first.agent_id, resume);
  const firstPaneId = await adapter.newSession({
    session,
    window: WINDOW_MAIN,
    width: SESSION_WIDTH,
    height: SESSION_HEIGHT,
    cwd: launchRoot,
    command: firstLaunch.command,
    env: paneEnv,
  });
  const initialPanes: PaneAgent[] = [
    {
      agentId: first.agent_id,
      role: first.role,
      paneId: firstPaneId,
      ...firstLaunch,
    },
  ];

  // owned = true: only now may teardown kill this session. The build
  // (panes → readiness → roster → relay → brief) runs under the guard; attach is a
  // POST-success step OUTSIDE it (a failed attach must not destroy the session).
  let panes: readonly PaneAgent[];
  try {
    await adapter.setSessionOwner(session, ownershipToken);
    panes = await buildOwnedSession(
      {
        io,
        deps,
        plan,
        root: launchRoot,
        session,
        target,
        readinessNames,
        paneEnv,
        ownershipToken,
        managerPromptPath,
      },
      initialPanes,
      rest,
    );
  } catch (err) {
    const tornDown = await teardownOwnedSession(io, adapter, session, launchRoot, launchToken);
    // A worktree CREATED by this invocation is removed on a confirmed teardown
    // only — a REUSED worktree pre-existed this launch and is left intact
    // (mirrors the "never touch a pre-existing session" invariant), and an
    // unconfirmed teardown may still have live processes using it as their cwd.
    if (tornDown && worktree !== null && worktree.action === 'create') {
      await removeCreatedWorktree(io, root, worktree.path);
    }
    throw err;
  }

  const attach = plan.relay.attach && deps.noAttach !== true;
  const result: LaunchResult = {
    sessionName: session,
    panes: panes.length,
    relay: plan.relay.enabled,
    attached: attach,
  };

  // Emit the result BEFORE the blocking attach so the launch_result contract
  // ("before attaching") holds on the default attach path, not only --no-attach.
  deps.onLaunched?.(result);

  // Attach is OUTSIDE the teardown guard: the session is already built, so a failed
  // attach surfaces as an error (not a silent exit 0) WITHOUT killing
  // the session the operator can reattach to.
  if (attach) {
    const attachCode = await adapter.attach(session);
    if (attachCode !== 0) {
      throw new CrewError(
        'LAUNCH_FAILED',
        `the session "${session}" was created but \`tmux attach\` exited with code ${attachCode}; reattach with \`tmux attach -t ${session}\``,
      );
    }
  }
  return result;
}

/**
 * Validate every precondition BEFORE any tmux mutation: tmux present, no
 * colliding session, a resolvable participant target, a manager in the
 * roster, the client executable on PATH, the single whole-Crew worktree
 * resolved (created or reused) when the plan enables one, and no planned id
 * already taken in the LAUNCH root's Store (the worktree's own Store once
 * resolved, ADR-0011). Building/reusing the worktree is the only mutation
 * preflight performs — it happens last, after every read-only check passes,
 * so a failed resolution never leaves a tmux session behind.
 */
async function preflightLaunch(
  io: Io,
  deps: LiveLaunchDeps,
  assembly: LaunchAssembly,
  root: string,
): Promise<{
  target: ParticipantTarget;
  managerEntry: PlanRosterEntry;
  worktree: WorktreeResolution | null;
}> {
  const { adapter } = deps;
  const { plan } = assembly;
  const session = plan.session_name;

  // FR-H02: a launch is impossible without tmux — report manual commands and
  // DEPENDENCY_MISSING before creating anything.
  if (!(await adapter.isPresent())) {
    throw new CrewError(
      'DEPENDENCY_MISSING',
      `tmux is required for an automatic launch but was not found. Launch the panes manually: run \`crew team ${plan.team}\` for the per-member join commands and invocations.`,
    );
  }

  // Never create on top of an existing session.
  if (await adapter.hasSession(session)) {
    throw new CrewError(
      'ALREADY_EXISTS',
      `a tmux session named "${session}" already exists; attach with \`tmux attach -t ${session}\`, kill it, or choose another session name`,
    );
  }

  const liveOwnedSessions = await listOwnedSessions(io, { adapter });
  if (liveOwnedSessions.length > 0) {
    throw new CrewError('ALREADY_EXISTS', 'the workspace already has a live crew-owned session');
  }

  const target = (deps.resolveTarget ?? getTarget)(plan.client);
  if (target === undefined || target.category !== 'participant') {
    throw new CrewError('UNSUPPORTED_PLATFORM', `no registry target for client "${plan.client}"`);
  }

  // The launch is Manager-centric: the brief targets the Manager pane.
  const managerEntry = plan.roster.find((r) => r.role === 'manager');
  if (managerEntry === undefined) {
    throw new CrewError(
      'USAGE',
      'an automatic launch requires a manager in the team (the launch brief targets the manager role)',
    );
  }

  // FR-H03 / architecture §7.1 step 6: validate the Participant executable and the
  // roster baseline BEFORE any mutation (artifacts or tmux). A missing client is a
  // preflight DEPENDENCY_MISSING with setup guidance, not a later LAUNCH_FAILED
  // discovered only because an empty pane never reached readiness.
  if (!isExecutableOnPath(io.env, target.executable)) {
    throw new CrewError(
      'DEPENDENCY_MISSING',
      `the ${plan.client} CLI ("${target.executable}") was not found on PATH; install it and run \`crew setup ${plan.client}\` before an automatic launch (or launch the panes manually with \`crew team ${plan.team}\`)`,
    );
  }

  // ADR-0011: resolve the single whole-Crew worktree LAST — it is the only
  // mutation this preflight performs, and it must run before the tmux session is
  // created but after every read-only check above has passed.
  let worktree: WorktreeResolution | null = null;
  if (plan.worktree.enabled) {
    if (plan.worktree.path === null || plan.worktree.branch === null) {
      throw new CrewError(
        'INVALID_CONFIG',
        'the launch plan enables a worktree but has no derived path/branch',
      );
    }
    const req: WorktreeRequest = {
      repoRoot: root,
      targetPath: plan.worktree.path,
      managedBase: managedWorktreeBase(io.env),
      branch: plan.worktree.branch,
      baseRef: plan.worktree.base_ref,
    };
    worktree = await (deps.resolveWorktree ?? resolveWorktree)(io, req);
  }
  const launchRoot = worktree?.path ?? root;

  // Stage-2 readiness binds the Relay and pane-map to the planned base ids, so those
  // ids must be FRESH: if an Agent with a planned id already exists (e.g. a prior
  // launch whose session was killed but whose rows remain), the gate would pass on
  // the stale row while each new pane's `crew join` allocates a suffixed id — the
  // Relay would then nudge the dead registration. Reject up front.
  // Checked against the LAUNCH root's Store: once a worktree is resolved, that is
  // the worktree's own ephemeral Store, never the original workspace's.
  const plannedIds = plan.roster.map((r) => r.agent_id);
  if (deps.resume !== true) {
    const preexisting = preexistingAgentIds(io, launchRoot, plannedIds);
    if (preexisting.length > 0) {
      throw new CrewError(
        'ALREADY_EXISTS',
        `the launch would create Agents whose ids already exist: ${preexisting.join(', ')}. Archive them (\`crew leave <id>\`) or prune the workspace before launching, so the Relay is not bound to stale registrations.`,
      );
    }
  }

  return { target, managerEntry, worktree };
}

/**
 * Build the Manager/Inspector/run-summary prompts and write the pre-tmux
 * artifacts (the Manager prompt file is what the brief step later
 * load-buffers). The untrusted brief body is embedded here under guard, never on
 * argv. Returns the Manager prompt file path.
 */
function buildLaunchArtifacts(
  root: string,
  session: string,
  plan: LaunchPlan,
  brief: BriefMeta,
  managerEntry: PlanRosterEntry,
): { managerPromptPath: string } {
  const promptRoster = plan.roster.map((r) => ({ agentId: r.agent_id, role: r.role }));
  const baseCtx = {
    sessionName: session,
    team: plan.team,
    roster: promptRoster,
    focus: plan.focus,
    constraints: plan.constraints,
  };
  const managerPrompt = buildManagerPrompt(
    { ...baseCtx, agent: { agentId: managerEntry.agent_id, role: 'manager' } },
    brief.body ?? '',
  );
  const inspectorEntry = plan.roster.find((r) => r.role === 'inspector');
  const inspectorPrompt =
    inspectorEntry === undefined
      ? null
      : buildInspectorPrompt({
          ...baseCtx,
          agent: { agentId: inspectorEntry.agent_id, role: 'inspector' },
        });
  const runSummary = buildRunSummary({
    sessionName: session,
    team: plan.team,
    client: plan.client,
    executable: plan.executable,
    roster: promptRoster,
  });
  const { managerPromptPath } = writePlanArtifacts(root, session, {
    launchPlan: plan,
    managerPrompt,
    inspectorPrompt,
    runSummary,
  });
  return { managerPromptPath };
}

/**
 * Under the teardown guard: split the remaining panes (re-tiling after each),
 * record the pane-map immediately once the panes exist (so `team stop` can prove
 * ownership during the later build waits), then run two-stage readiness (Stage 1
 * paste the invocation, Stage 2 wait for every roster Agent to register), start
 * the Relay, and paste the brief into the Manager pane. Returns the realized pane
 * assignment; any throw leaves the session for the caller's teardown.
 */
async function buildOwnedSession(
  ctx: OwnedSessionContext,
  initialPanes: readonly PaneAgent[],
  rest: readonly PlanRosterEntry[],
): Promise<PaneAgent[]> {
  const {
    io,
    deps,
    plan,
    root,
    session,
    target,
    readinessNames,
    paneEnv,
    ownershipToken,
    managerPromptPath,
  } = ctx;
  const { adapter, delay } = deps;
  const resume = deps.resume === true;
  const panes: PaneAgent[] = [...initialPanes];

  for (const entry of rest) {
    const launch = paneLaunch(plan.executable, target, entry.role, entry.agent_id, resume);
    const paneId = await adapter.splitPane({
      target: `${session}:${WINDOW_MAIN}`,
      cwd: root,
      command: launch.command,
      env: paneEnv,
    });
    panes.push({
      agentId: entry.agent_id,
      role: entry.role,
      paneId,
      ...launch,
    });
    // Re-balance after EVERY split: a default split halves the active pane, so
    // without re-tiling between splits the space is exhausted after only ~5
    // panes ("no space for new pane"). Tiling keeps each next split room for a
    // full roster (FR-H13 reliability).
    await adapter.tileLayout(`${session}:${WINDOW_MAIN}`);
  }

  // Record the pane assignment immediately once the participant panes exist, so
  // `crew team stop <session>` can prove ownership and kill the session even if
  // the launch process dies during readiness/roster waits. The Relay window does
  // not exist yet, so the preliminary map records it as absent and is rewritten
  // below once tmux returns the Relay pane id.
  writePaneMap(
    root,
    session,
    paneMap(session, plan.executable, readinessNames, ownershipToken, false, null, panes),
  );

  // Stage 1: per pane, wait for the CLI process to appear, settle
  // for the raw-mode gap, then paste the invocation (argv buffer) and submit.
  for (const pane of panes) {
    await awaitPaneReady(
      adapter,
      pane.paneId,
      readinessNames,
      target.readinessMode ?? 'names',
      delay,
    );
    if (!pane.pasteInvocation) continue;
    await delay(SETTLE_MS);
    const invocationBuffer = uniqueBuffer(INVOCATION_BUFFER_PREFIX);
    await adapter.setBufferArg(invocationBuffer, pane.invocation);
    await adapter.pasteBuffer({ bufferName: invocationBuffer, target: pane.paneId });
    await adapter.sendEnter(pane.paneId);
  }

  // Stage 2: the authoritative gate — every roster Agent registers.
  await awaitRoster(io, root, adapter, panes, delay);

  // Start the Relay in its own window unless suppressed.
  if (plan.relay.enabled) {
    const relayPaneId = await adapter.newWindow({
      session,
      window: WINDOW_RELAY,
      cwd: root,
      command: [...deps.relayBin, 'relay', '--internal', '--session', session],
    });
    // The Relay starts against the preliminary participant map above. Rewrite
    // atomically once tmux returns its realized pane id so Console peek can
    // target the Relay without accepting a caller-supplied tmux target.
    writePaneMap(
      root,
      session,
      paneMap(session, plan.executable, readinessNames, ownershipToken, true, relayPaneId, panes),
    );
  }

  // Paste the brief into the Manager pane via a file load (untrusted, off argv).
  const managerPane = panes.find((p) => p.role === 'manager');
  if (managerPane !== undefined) {
    const briefBuffer = uniqueBuffer(BRIEF_BUFFER_PREFIX);
    await adapter.loadBufferFile(briefBuffer, managerPromptPath);
    await adapter.pasteBuffer({ bufferName: briefBuffer, target: managerPane.paneId });
    await adapter.sendEnter(managerPane.paneId);
  }

  return panes;
}

/**
 * Tear down the whole owned session best-effort, never masking the real launch
 * error. The scoped reap runs ONLY after the session is confirmed gone:
 * if teardown failed the panes' participant processes may still be alive, and
 * removing their (untouched) Agent rows would break them with AGENT_INACTIVE on
 * their next operation — strictly worse than the leave-intact baseline. On a
 * confirmed teardown, delete only the UNTOUCHED rows this launch created (stamped
 * with launchToken, no Task/Event/Message footprint) so the same team is
 * immediately relaunchable; touched/foreign rows are left for doctor/retry.
 */
async function teardownOwnedSession(
  io: Io,
  adapter: TmuxAdapter,
  session: string,
  root: string,
  launchToken: string,
): Promise<boolean> {
  let tornDown = false;
  try {
    await adapter.killSession(session);
    tornDown = true;
  } catch {
    // ignore teardown failures — surface the original launch error
  }
  if (!tornDown) return false;
  try {
    const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
    try {
      store.reapByLaunchToken(launchToken);
    } finally {
      store.close();
    }
  } catch {
    // ignore reap failures — the baseline leaves joined rows for doctor/retry
  }
  return true;
}

/**
 * Best-effort `git worktree remove --force` for a worktree THIS invocation
 * created, run only after a CONFIRMED teardown of the session that used it as
 * pane `cwd` (never on an unconfirmed teardown, where a live process may still
 * hold it as its working directory). A reused (pre-existing) worktree is never
 * passed here — see the call site. Never masks the original launch error.
 */
async function removeCreatedWorktree(io: Io, repoRoot: string, path: string): Promise<void> {
  try {
    await io.runProcess('git', ['-C', repoRoot, 'worktree', 'remove', '--force', path], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
  } catch {
    // best-effort cleanup only — a failed launch must not be masked by this
  }
}

/** Foreground commands that mean the Participant CLI has not started yet. */
const SHELL_NAMES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'tcsh',
  'csh',
  'login',
  'pwsh',
]);

/** Stage 1: poll the pane's foreground command until the target's readiness rule holds. */
async function awaitPaneReady(
  adapter: TmuxAdapter,
  paneId: string,
  readinessNames: readonly string[],
  readinessMode: 'names' | 'not-shell',
  delay: (ms: number) => Promise<void>,
): Promise<void> {
  if (readinessMode === 'names' && readinessNames.length === 0) {
    return; // nothing to match — rely on the settle delay
  }
  const isReady = (command: string): boolean =>
    readinessMode === 'not-shell'
      ? command !== '' && !SHELL_NAMES.has(command)
      : readinessNames.includes(command);
  const ready = await pollUntil(
    async () => {
      const command = await adapter.paneCommand(paneId);
      return isReady(command) ? command : null;
    },
    READINESS_ATTEMPTS,
    READINESS_POLL_MS,
    delay,
  );
  if (ready === null) {
    throw new CrewError(
      'LAUNCH_FAILED',
      readinessMode === 'not-shell'
        ? `pane ${paneId} did not reach readiness (foreground command stayed a shell)`
        : `pane ${paneId} did not reach readiness (expected one of: ${readinessNames.join(', ')})`,
    );
  }
}

/**
 * Return which planned ids already exist in the Store (active OR archived — an
 * archived row still occupies the id, so a fresh `crew join` would suffix). Used
 * to refuse a launch that would bind the Relay to a stale registration.
 */
function preexistingAgentIds(io: Io, root: string, plannedIds: readonly string[]): string[] {
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    const existing = new Set(store.listAgents({ includeArchived: true }).map((agent) => agent.id));
    return plannedIds.filter((id) => existing.has(id));
  } finally {
    store.close();
  }
}

/** Stage 2: poll the Store until every roster Agent id has registered. */
async function awaitRoster(
  io: Io,
  root: string,
  adapter: TmuxAdapter,
  panes: readonly PaneAgent[],
  delay: (ms: number) => Promise<void>,
): Promise<void> {
  const store = openWorkspaceStore(root, io.clock, io.random, io.onTransactionStep);
  try {
    for (let attempt = 0; attempt < JOIN_ATTEMPTS; attempt++) {
      const present = new Set(store.listAgents().map((agent) => agent.id));
      if (panes.every((pane) => present.has(pane.agentId))) return;
      // Bounded invocation redelivery: real TUIs can drop the Stage-1 paste while
      // still initializing (startup banner, plugin load) even though the pane's
      // process is already up — observed live with both Codex and Claude Code.
      // It also nets a not-shell readiness that fired early (an exotic shell
      // name outside SHELL_NAMES). Each pane is re-checked against a FRESH
      // Store read immediately before its own re-paste, because earlier panes'
      // tmux round-trips take real time; the residual race is the duration of
      // that pane's own paste, and a stray duplicate `crew join` cannot corrupt
      // the original registration (ON CONFLICT DO NOTHING + suffix).
      if (REDELIVERY_MARKS.includes(attempt)) {
        for (const pane of panes) {
          const joined = store.listAgents().some((agent) => agent.id === pane.agentId);
          if (joined || !pane.pasteInvocation) continue;
          const invocationBuffer = uniqueBuffer(INVOCATION_BUFFER_PREFIX);
          await adapter.setBufferArg(invocationBuffer, pane.invocation);
          await adapter.pasteBuffer({ bufferName: invocationBuffer, target: pane.paneId });
          await adapter.sendEnter(pane.paneId);
        }
      }
      if (attempt < JOIN_ATTEMPTS - 1) await delay(JOIN_POLL_MS);
    }
    const present = new Set(store.listAgents().map((agent) => agent.id));
    const missing = panes.map((p) => p.agentId).filter((id) => !present.has(id));
    throw new CrewError(
      'LAUNCH_FAILED',
      `agents did not register before the join timeout: ${missing.join(', ')}`,
    );
  } finally {
    store.close();
  }
}

/** Assemble the pane-map record from the realized panes. */
function paneMap(
  session: string,
  executable: string,
  readinessNames: readonly string[],
  ownershipToken: string,
  relayEnabled: boolean,
  relayPaneId: string | null,
  panes: readonly PaneAgent[],
): PaneMap {
  const records: PaneMapPane[] = panes.map((pane) => ({
    pane_id: pane.paneId,
    window: WINDOW_MAIN,
    agent_id: pane.agentId,
    role: pane.role,
    executable,
    invocation: pane.invocation,
    readiness_names: readinessNames,
  }));
  return {
    schema_version: 1,
    session_name: session,
    ownership_token: ownershipToken,
    relay_window: { present: relayEnabled, name: WINDOW_RELAY, pane_id: relayPaneId },
    panes: records,
  };
}
