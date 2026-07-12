/**
 * Launch orchestration. `runLaunch` resolves config → assembles + validates the
 * plan → with `--print` renders it (PURE: no git/subprocess/writes/tmux), else
 * drives the live tmux launch, which — when the plan enables a
 * worktree — resolves/creates the single whole-Crew worktree and runs the whole
 * live Crew (Store, artifacts, pane `cwd`) inside it (ADR-0011).
 *
 * `--print` stays the side-effect-free inspector: the worktree PATH is derived
 * purely in `plan.ts` and never itself creates the worktree.
 */
import { realDelay } from '../delay.js';
import { renderLaunchPlanHuman, writeLaunchPlanJson } from '../format.js';
import type { Io } from '../io.js';
import { resolveWorkspaceRoot } from '../workspace.js';
import { type LaunchFlags, loadLauncherConfig, mergeEffectiveConfig } from './config.js';
import { buildLaunchPlan } from './plan.js';
import { type LaunchResult, type LiveLaunchDeps, runLiveLaunch } from './session.js';
import { createTmuxAdapter } from './tmux.js';

export interface LaunchOptions {
  readonly client?: string;
  readonly workers?: string;
  readonly taskFile?: string;
  readonly worktree?: string | false;
  readonly noRelay?: boolean;
  readonly noAttach?: boolean;
  readonly print: boolean;
  readonly json: boolean;
}

function toFlags(opts: LaunchOptions): LaunchFlags {
  return {
    ...(opts.client !== undefined ? { client: opts.client } : {}),
    ...(opts.workers !== undefined ? { workers: opts.workers } : {}),
    ...(opts.taskFile !== undefined ? { taskFile: opts.taskFile } : {}),
    ...(opts.worktree !== undefined ? { worktree: opts.worktree } : {}),
    ...(opts.noRelay !== undefined ? { noRelay: opts.noRelay } : {}),
    ...(opts.noAttach !== undefined ? { noAttach: opts.noAttach } : {}),
  };
}

/** Re-invoke THIS crew as the Relay window command, so the launched Relay is the same build. */
function relayBinArgv(): readonly string[] {
  const script = process.argv[1];
  return script === undefined ? ['crew'] : [process.execPath, script];
}

/** Emit the live launch result (dual format). Exported for the output-contract test. */
export function renderLaunchResult(io: Io, result: LaunchResult, json: boolean): void {
  if (json) {
    io.stdout(
      `${JSON.stringify({
        type: 'launch_result',
        schema_version: 1,
        session_name: result.sessionName,
        panes: result.panes,
        relay: result.relay,
        attached: result.attached,
      })}\n`,
    );
    return;
  }
  io.stdout(
    `Launched session ${result.sessionName} (${result.panes} panes, relay ${result.relay ? 'on' : 'off'}).\n`,
  );
  if (!result.attached) {
    io.stdout(`Attach with: tmux attach -t ${result.sessionName}\n`);
  }
}

/** `crew team <name> --launch …`: with `--print` emit the plan; otherwise drive the live launch. */
export async function runLaunch(io: Io, name: string, opts: LaunchOptions): Promise<void> {
  const root = resolveWorkspaceRoot(io.cwd);
  const file = loadLauncherConfig(root);
  const config = mergeEffectiveConfig(file, toFlags(opts));
  const assembly = buildLaunchPlan(io, name, config);

  if (opts.print) {
    if (opts.json) {
      writeLaunchPlanJson(io, assembly.plan);
    } else {
      renderLaunchPlanHuman(io, assembly);
    }
    return;
  }

  const deps: LiveLaunchDeps = {
    adapter: createTmuxAdapter(io),
    delay: realDelay,
    relayBin: relayBinArgv(),
    // Render the result before the (blocking) attach, so a `--json` consumer sees
    // the launch_result even on the default attach path.
    onLaunched: (result) => {
      renderLaunchResult(io, result, opts.json);
    },
  };
  await runLiveLaunch(io, deps, assembly);
}
