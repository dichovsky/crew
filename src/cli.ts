/**
 * Commander construction for crew (DEC-9). Handlers stay thin and the command
 * surface is built here; `run.ts` owns argument intake and error mapping.
 *
 * Two programs are built from one command registration: the live program (with
 * version, help, and the bare-invocation USAGE action) and a silent validator
 * (no-op actions, no version, no root action) used by `run.ts` to enforce
 * FR-A11 — help/version is honored only when the rest of the invocation is a
 * valid command/option sequence.
 */
import { Command, Option } from 'commander';
import { realDelay } from './delay.js';
import { runAgentsList, runJoin, runLeave } from './agents.js';
import { runDoctor } from './doctor.js';
import { CrewError } from './errors.js';
import { runInit } from './init.js';
import { runLaunch, type LaunchOptions } from './launcher/index.js';
import { runTeamResume } from './launcher/resume.js';
import { runTeamStop } from './launcher/stop.js';
import { createTmuxAdapter } from './launcher/tmux.js';
import { runClean, runPrune } from './maintenance.js';
import { runHistory, runPending, runReceive, runSend } from './messages.js';
import { runRelay } from './relay.js';
import { runRoleExport, runRolesList, runRoleShow } from './roles.js';
import { runSetup } from './setup/index.js';
import {
  runTaskAbandon,
  runTaskApprove,
  runTaskCreate,
  runTaskLand,
  runTaskList,
  runTaskRequeue,
  runTaskReview,
  runTaskShow,
  runTaskStart,
  runTaskSubmit,
} from './tasks.js';
import type { TaskStatus } from './store/index.js';
import { runTeamShow, runTeamsList } from './teams.js';
import { runUi } from './ui/index.js';
import type { Io } from './io.js';
import { readVersion } from './version.js';

function configure(program: Command, io: Io, silent: boolean): void {
  program
    .name('crew')
    .description('Local coordination for terminal coding agents')
    .allowUnknownOption(false)
    .allowExcessArguments(false)
    .configureOutput({
      // crew renders its own errors in run.ts; swallow commander's chatter so
      // output is a single crew-owned line. The validator swallows stdout too.
      writeOut: silent
        ? () => {}
        : (s) => {
            io.stdout(s);
          },
      writeErr: () => {},
    })
    .exitOverride();
}

function relayBinArgv(): readonly string[] {
  const script = process.argv[1];
  return script === undefined ? ['crew'] : [process.execPath, script];
}

function addBareGroupUsageGuard(command: Command, execute: boolean, argvHelp: string): void {
  command.action(() => {
    if (!execute) return;
    throw new CrewError('USAGE', `no subcommand given; run "${argvHelp}" for usage`);
  });
}

/** Register the crew command surface. When `execute` is false, actions are no-ops. */
function registerCommands(program: Command, io: Io, execute: boolean): void {
  program
    .command('init')
    .description('Create or update the .crew workspace in the current directory')
    .option(
      '--with-guides',
      'append a marked crew section to existing CLAUDE.md/AGENTS.md/GEMINI.md',
    )
    .option('--json', 'emit machine-readable JSON')
    .action((opts: { withGuides?: boolean; json?: boolean }) => {
      if (execute) runInit(io, { withGuides: opts.withGuides ?? false, json: opts.json ?? false });
    });

  program
    .command('setup [target]')
    .description(
      'Detect Setup Targets, or install one Participant artifact / print a Backend recipe',
    )
    .option('--list', 'detect all targets and write nothing (the default with no target)')
    .option('--project', 'install the project-scoped artifact instead of the global one')
    .option('--force', 'back up and overwrite an edited or unmanaged file')
    .option('--json', 'emit machine-readable JSON')
    .action(
      async (
        target: string | undefined,
        opts: { list?: boolean; project?: boolean; force?: boolean; json?: boolean },
      ) => {
        if (execute) {
          await runSetup(io, {
            ...(target !== undefined ? { target } : {}),
            list: opts.list ?? false,
            project: opts.project ?? false,
            force: opts.force ?? false,
            json: opts.json ?? false,
          });
        }
      },
    );

  program
    .command('doctor')
    .description('Run read-only diagnostics on the system and Workspace')
    .option('--system', 'check only system dependencies; no Workspace required')
    .option('--json', 'emit machine-readable JSON')
    .action(async (opts: { system?: boolean; json?: boolean }) => {
      if (execute) await runDoctor(io, { system: opts.system ?? false, json: opts.json ?? false });
    });

  program
    .command('join <id>')
    .description('Join the Crew as an Agent')
    .option('--role <role>', 'assign a resolvable Role (defaults to the requested id)')
    .option('--platform <platform>', 'record the Participant CLI id')
    .option('--resume', 'reactivate this exact archived Agent id')
    .option('--json', 'emit machine-readable JSON')
    .action(
      (
        id: string,
        opts: { role?: string; platform?: string; resume?: boolean; json?: boolean },
      ) => {
        if (execute)
          runJoin(io, id, {
            ...(opts.role !== undefined ? { role: opts.role } : {}),
            ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
            resume: opts.resume ?? false,
            json: opts.json ?? false,
          });
      },
    );

  program
    .command('leave <id>')
    .description('Archive an active Agent')
    .option('--json', 'emit machine-readable JSON')
    .action((id: string, opts: { json?: boolean }) => {
      if (execute) runLeave(io, id, { json: opts.json ?? false });
    });

  program
    .command('agents')
    .description('List active Agents')
    .option('--all', 'include archived Agents')
    .option('--json', 'emit machine-readable JSON')
    .action((opts: { all?: boolean; json?: boolean }) => {
      if (execute) runAgentsList(io, { all: opts.all ?? false, json: opts.json ?? false });
    });

  program
    .command('send <from> <to> [message...]')
    .description('Send a direct Message or broadcast to @all')
    .option('--file <path>', 'read Message content from a UTF-8 file, or - for stdin')
    .option('--reply-to <message-id>', 'link a direct Message to an accessible prior Message')
    .option('--json', 'emit machine-readable JSON')
    .action(
      async (
        from: string,
        to: string,
        message: string[] | undefined,
        opts: { file?: string; replyTo?: string; json?: boolean },
      ) => {
        if (execute)
          await runSend(io, from, to, message ?? [], {
            ...(opts.file !== undefined ? { file: opts.file } : {}),
            ...(opts.replyTo !== undefined ? { replyTo: opts.replyTo } : {}),
            json: opts.json ?? false,
          });
      },
    );

  program
    .command('receive <id>')
    .description('Atomically receive unread Messages for an Agent')
    .option('--limit <count>', 'maximum Messages to receive (1..500)')
    .option('--json', 'emit machine-readable JSON')
    .action((id: string, opts: { limit?: string; json?: boolean }) => {
      if (execute)
        runReceive(io, id, {
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          json: opts.json ?? false,
        });
    });

  program
    .command('pending')
    .description('Inspect unread Messages without consuming them')
    .option('--agent <id>', 'filter by recipient Agent')
    .option('--summary', 'emit a content-free complete Inbox summary')
    .option('--limit <count>', 'maximum Messages to list (1..500)')
    .option('--json', 'emit machine-readable JSON')
    .action((opts: { agent?: string; summary?: boolean; limit?: string; json?: boolean }) => {
      if (execute)
        runPending(io, {
          ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
          summary: opts.summary ?? false,
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          json: opts.json ?? false,
        });
    });

  program
    .command('history')
    .description('List Message history, including read and unread rows')
    .option('--agent <id>', 'filter where Agent is sender or recipient')
    .option('--from <id>', 'filter by sender Agent')
    .option('--to <id>', 'filter by recipient Agent')
    .option('--since <timestamp>', 'inclusive epoch-second or exact ISO-8601 timestamp')
    .option('--limit <count>', 'maximum Messages in newest window (1..1000)')
    .option('--json', 'emit machine-readable JSON')
    .action(
      (opts: {
        agent?: string;
        from?: string;
        to?: string;
        since?: string;
        limit?: string;
        json?: boolean;
      }) => {
        if (execute)
          runHistory(io, {
            ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
            ...(opts.from !== undefined ? { from: opts.from } : {}),
            ...(opts.to !== undefined ? { to: opts.to } : {}),
            ...(opts.since !== undefined ? { since: opts.since } : {}),
            ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
            json: opts.json ?? false,
          });
      },
    );

  program
    .command('roles')
    .description('List available Roles (packaged and project overrides)')
    .option('--json', 'emit machine-readable JSON')
    .action((opts: { json?: boolean }) => {
      if (execute) runRolesList(io, { json: opts.json ?? false });
    });

  const role = program.command('role').description('Inspect and export Roles').usage('<command>');
  role
    .command('show <name>')
    .description('Print a Role and its source')
    .option('--json', 'emit machine-readable JSON')
    .action((name: string, opts: { json?: boolean }) => {
      if (execute) runRoleShow(io, name, { json: opts.json ?? false });
    });
  role
    .command('export <name>')
    .description('Copy a packaged Role into .crew/roles/')
    .option('--force', 'overwrite an existing project Role')
    .option('--json', 'emit machine-readable JSON')
    .action((name: string, opts: { force?: boolean; json?: boolean }) => {
      if (execute)
        runRoleExport(io, name, { force: opts.force ?? false, json: opts.json ?? false });
    });
  addBareGroupUsageGuard(role, execute, 'crew role --help');

  program
    .command('teams')
    .description('List available Teams (packaged and project overrides)')
    .option('--json', 'emit machine-readable JSON')
    .action((opts: { json?: boolean }) => {
      if (execute) runTeamsList(io, { json: opts.json ?? false });
    });

  program
    .command('team <name> [session]')
    .description('Display a Team roster, or build a deterministic launch plan with --launch')
    .option('--client <platform>', 'override the launch/display Participant CLI')
    .option('--launch', 'build the deterministic launch plan (use --print to emit it)')
    // Every launch-only flag implies --launch, so `crew team dev --print` builds the plan
    // instead of silently rendering the roster (the flags are honored in both programs).
    .addOption(
      new Option('--workers <n>', 'override the Worker replica count (1-32)').implies({
        launch: true,
      }),
    )
    .addOption(
      new Option('--task-file <path>', 'use a Task brief from any readable path').implies({
        launch: true,
      }),
    )
    .addOption(
      new Option('--worktree <branch>', 'launch in a whole-Crew worktree on <branch>').implies({
        launch: true,
      }),
    )
    .addOption(
      new Option(
        '--no-worktree',
        'force-disable the worktree even if tracked config enables it',
      ).implies({ launch: true }),
    )
    .addOption(new Option('--no-relay', 'plan no Relay window').implies({ launch: true }))
    .addOption(
      new Option('--no-attach', 'plan a session that is not attached').implies({ launch: true }),
    )
    .addOption(
      new Option('--print', 'emit the validated launch plan with no side effects').implies({
        launch: true,
      }),
    )
    .option('--json', 'emit machine-readable JSON')
    .action(
      async (
        name: string,
        session: string | undefined,
        opts: {
          client?: string;
          launch?: boolean;
          workers?: string;
          taskFile?: string;
          worktree?: string | false;
          relay?: boolean;
          attach?: boolean;
          print?: boolean;
          json?: boolean;
        },
      ) => {
        if (name === 'stop') {
          if (session === undefined) {
            throw new CrewError('USAGE', 'team stop requires a session name');
          }
          if (!execute) return;
          await runTeamStop(io, session, { json: opts.json ?? false });
          return;
        }
        if (name === 'resume') {
          if (session === undefined) {
            throw new CrewError('USAGE', 'team resume requires a session name');
          }
          if (!execute) return;
          await runTeamResume(
            io,
            session,
            { json: opts.json ?? false },
            {
              adapter: createTmuxAdapter(io),
              delay: realDelay,
              relayBin: relayBinArgv(),
            },
          );
          return;
        }
        if (session !== undefined) {
          throw new CrewError('USAGE', `team "${name}" does not accept a session argument`);
        }
        if (!execute) return;
        if (opts.launch) {
          const launchOpts: LaunchOptions = {
            ...(opts.client !== undefined ? { client: opts.client } : {}),
            ...(opts.workers !== undefined ? { workers: opts.workers } : {}),
            ...(opts.taskFile !== undefined ? { taskFile: opts.taskFile } : {}),
            ...(opts.worktree !== undefined ? { worktree: opts.worktree } : {}),
            ...(opts.relay === false ? { noRelay: true } : {}),
            ...(opts.attach === false ? { noAttach: true } : {}),
            print: opts.print ?? false,
            json: opts.json ?? false,
          };
          await runLaunch(io, name, launchOpts);
          return;
        }
        runTeamShow(io, name, {
          ...(opts.client !== undefined ? { client: opts.client } : {}),
          json: opts.json ?? false,
        });
      },
    );

  // Internal: the session-scoped Relay started automatically by `team --launch`.
  // Hidden from help — it is not a user-facing command.
  program
    .command('relay', { hidden: true })
    .description('internal: service a launched tmux session with Inbox nudges')
    .option('--internal', 'confirm this is the Launcher-started internal Relay')
    .requiredOption('--session <name>', 'the tmux session to service')
    .action(async (opts: { internal?: boolean; session: string }) => {
      if (!execute) return;
      await runRelay(io, {
        ...(opts.internal === true ? { internal: true } : {}),
        session: opts.session,
      });
    });

  const task = program
    .command('task')
    .description('Create and drive reviewed Tasks')
    .usage('<command>');
  task
    .command('create <creator> <assignee>')
    .description('Create a queued Task assigned to <assignee> for review by --reviewer')
    .requiredOption('--reviewer <agent>', 'the reviewing Agent')
    .requiredOption('--title <text>', 'the Task title (1..500 Unicode code points)')
    .option('--body <text>', 'optional Task body (up to 100000 code points)')
    .option('--json', 'emit machine-readable JSON')
    .action(
      (
        creator: string,
        assignee: string,
        opts: { reviewer: string; title: string; body?: string; json?: boolean },
      ) => {
        if (execute)
          runTaskCreate(io, creator, assignee, {
            reviewer: opts.reviewer,
            title: opts.title,
            ...(opts.body !== undefined ? { body: opts.body } : {}),
            json: opts.json ?? false,
          });
      },
    );
  task
    .command('start <agent> <task-id>')
    .description('Assignee claims a queued Task and starts a 15-minute Lease')
    .option('--json', 'emit machine-readable JSON')
    .action(async (agent: string, taskId: string, opts: { json?: boolean }) => {
      if (execute) await runTaskStart(io, agent, taskId, { json: opts.json ?? false });
    });
  task
    .command('submit <agent> <task-id>')
    .description('Lease owner records a Submission summary')
    .requiredOption('--summary <text>', 'the Submission summary')
    .option('--json', 'emit machine-readable JSON')
    .action((agent: string, taskId: string, opts: { summary: string; json?: boolean }) => {
      if (execute)
        runTaskSubmit(io, agent, taskId, { summary: opts.summary, json: opts.json ?? false });
    });
  task
    .command('review <agent> <task-id>')
    .description("Reviewer checks out a submitted Task's branch in their dedicated review worktree")
    .option('--json', 'emit machine-readable JSON')
    .action(async (agent: string, taskId: string, opts: { json?: boolean }) => {
      if (execute) await runTaskReview(io, agent, taskId, { json: opts.json ?? false });
    });
  task
    .command('approve <reviewer> <task-id>')
    .description('Reviewer completes a submitted Task')
    .option('--summary <text>', 'optional Review summary')
    .option('--json', 'emit machine-readable JSON')
    .action(
      async (reviewer: string, taskId: string, opts: { summary?: string; json?: boolean }) => {
        if (execute)
          await runTaskApprove(io, reviewer, taskId, {
            ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
            json: opts.json ?? false,
          });
      },
    );
  task
    .command('requeue <actor> <task-id>')
    .description('Creator/reviewer returns a Task to the queue')
    .requiredOption('--reason <text>', 'why the Task is being requeued')
    .option('--to <agent>', 'reassign to a new active assignee')
    .option('--json', 'emit machine-readable JSON')
    .action(
      async (
        actor: string,
        taskId: string,
        opts: { reason: string; to?: string; json?: boolean },
      ) => {
        if (execute)
          await runTaskRequeue(io, actor, taskId, {
            reason: opts.reason,
            ...(opts.to !== undefined ? { to: opts.to } : {}),
            json: opts.json ?? false,
          });
      },
    );
  task
    .command('abandon <actor> <task-id>')
    .description('Creator/reviewer retires a Task to the terminal abandoned status')
    .option('--reason <text>', 'optional reason the Task is being abandoned')
    .option('--json', 'emit machine-readable JSON')
    .action(async (actor: string, taskId: string, opts: { reason?: string; json?: boolean }) => {
      if (execute)
        await runTaskAbandon(io, actor, taskId, {
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
          json: opts.json ?? false,
        });
    });
  task
    .command('land <actor> <task-id>')
    .description(
      "Creator/reviewer removes a completed Task's worktree/branch and sends the Sign-off",
    )
    .option('--force', 'remove even if crew thinks the worktree has unlanded changes')
    .option('--json', 'emit machine-readable JSON')
    .action(async (actor: string, taskId: string, opts: { force?: boolean; json?: boolean }) => {
      if (execute)
        await runTaskLand(io, actor, taskId, {
          force: opts.force ?? false,
          json: opts.json ?? false,
        });
    });
  task
    .command('show <task-id>')
    .description('Show one Task, optionally with its Task Events')
    .option('--events', 'also list the immutable Task Events')
    .option('--json', 'emit machine-readable JSON')
    .action((taskId: string, opts: { events?: boolean; json?: boolean }) => {
      if (execute)
        runTaskShow(io, taskId, { events: opts.events ?? false, json: opts.json ?? false });
    });
  task
    .command('list')
    .description('List Tasks with optional filters')
    .option('--assignee <id>', 'filter by assignee Agent')
    .option('--reviewer <id>', 'filter by reviewer Agent')
    .addOption(
      new Option('--status <status>', 'filter by status').choices([
        'queued',
        'in_progress',
        'submitted',
        'completed',
        'abandoned',
      ]),
    )
    .option('--stale-lease', 'only in-progress Tasks whose Lease has expired')
    .option('--json', 'emit machine-readable JSON')
    .action(
      (opts: {
        assignee?: string;
        reviewer?: string;
        status?: string;
        staleLease?: boolean;
        json?: boolean;
      }) => {
        if (execute)
          runTaskList(io, {
            ...(opts.assignee !== undefined ? { assignee: opts.assignee } : {}),
            ...(opts.reviewer !== undefined ? { reviewer: opts.reviewer } : {}),
            ...(opts.status !== undefined ? { status: opts.status as TaskStatus } : {}),
            staleLease: opts.staleLease ?? false,
            json: opts.json ?? false,
          });
      },
    );
  addBareGroupUsageGuard(task, execute, 'crew task --help');

  program
    .command('ui')
    .description('Start the optional local Console server (foreground; Ctrl-C stops it)')
    .option('--port <n>', 'bind this exact TCP port (1-65535) instead of a random free one')
    .option('--no-open', 'do not open the Console URL in a browser')
    .option('--json', 'emit machine-readable JSON')
    .action(async (opts: { port?: string; open: boolean; json?: boolean }) => {
      if (execute)
        await runUi(io, {
          ...(opts.port !== undefined ? { port: opts.port } : {}),
          open: opts.open,
          json: opts.json ?? false,
        });
    });

  program
    .command('prune')
    .description('Delete old read Messages and completed or abandoned Tasks')
    .option('--messages-before <duration>', 'retain read Messages newer than this age')
    .option('--tasks-before <duration>', 'retain completed or abandoned Tasks newer than this age')
    .option('--vacuum', 'reclaim free pages after pruning (refused while Agents are active)')
    .option('--json', 'emit machine-readable JSON')
    .action(
      (opts: {
        messagesBefore?: string;
        tasksBefore?: string;
        vacuum?: boolean;
        json?: boolean;
      }) => {
        if (execute)
          runPrune(io, {
            ...(opts.messagesBefore !== undefined ? { messagesBefore: opts.messagesBefore } : {}),
            ...(opts.tasksBefore !== undefined ? { tasksBefore: opts.tasksBefore } : {}),
            vacuum: opts.vacuum ?? false,
            json: opts.json ?? false,
          });
      },
    );

  program
    .command('clean')
    .description('Remove the State Store files (refused while Agents are active)')
    .option('--force', 'remove State Store files without opening or guarding the database')
    .option('--json', 'emit machine-readable JSON')
    .action((opts: { force?: boolean; json?: boolean }) => {
      if (execute) runClean(io, { force: opts.force ?? false, json: opts.json ?? false });
    });
}

/** The live program: version, help, and a bare-invocation USAGE action. */
export function buildProgram(io: Io): Command {
  const program = new Command();
  configure(program, io, false);
  program.version(readVersion());
  registerCommands(program, io, true);
  // The root action runs only when no subcommand matched (a bare invocation).
  program.action(() => {
    throw new CrewError('USAGE', 'no command given; run "crew --help" for usage');
  });
  return program;
}

/**
 * A silent validator with the same command surface but no-op actions, no version,
 * and no bare-invocation action. Parsing a command/option sequence through it
 * reports whether the sequence is valid, without side effects or output.
 */
export function buildValidator(io: Io): Command {
  const program = new Command();
  configure(program, io, true);
  registerCommands(program, io, false);
  return program;
}
