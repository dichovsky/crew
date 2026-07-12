/**
 * The Program seam: `run(argv, io)` is the single entry point exercised by the
 * bin shim and by every Program-level test. It takes user arguments (no
 * node/script prefix), drives the commander program, and maps all outcomes to
 * an exit status plus crew-owned output. It never calls `process.exit`.
 */
import { type Command, CommanderError } from 'commander';
import { buildProgram, buildValidator } from './cli.js';
import { CrewError, exitCodeForError } from './errors.js';
import { writeError } from './format.js';
import type { Io } from './io.js';

/** Commander error codes that mean "help/version was shown" — a success path. */
const SUCCESS_COMMANDER_CODES = new Set([
  'commander.helpDisplayed',
  'commander.help',
  'commander.version',
]);

/** The top-level help/version flag tokens. */
const HELP_VERSION_FLAGS = new Set(['-h', '--help', '-V', '--version']);

/** Tokens before a `--` terminator; everything after `--` is operand data. */
function beforeTerminator(argv: readonly string[]): readonly string[] {
  const end = argv.indexOf('--');
  return end === -1 ? argv : argv.slice(0, end);
}

/** True when this invocation requests help or version. */
function requestsHelpOrVersion(argv: readonly string[]): boolean {
  return beforeTerminator(argv).some((t) => HELP_VERSION_FLAGS.has(t));
}

/** argv with the help/version flags removed (keeping operands after `--`). */
function stripHelpVersion(argv: readonly string[]): string[] {
  const end = argv.indexOf('--');
  const head = (end === -1 ? argv : argv.slice(0, end)).filter((t) => !HELP_VERSION_FLAGS.has(t));
  const tail = end === -1 ? [] : argv.slice(end);
  return [...head, ...tail];
}

function isCommanderSuccess(err: CommanderError): boolean {
  return SUCCESS_COMMANDER_CODES.has(err.code) || err.exitCode === 0;
}

/**
 * A `--X` paired with its `--no-X` negation in the same invocation is contradictory.
 * Commander collapses a negatable option and its negation into one destination
 * (last-wins, undetectable post-parse), so this is checked on the raw argv. Returns the
 * conflicting base name (e.g. `worktree`) or null. Only flags before a `--` terminator count.
 */
function conflictingNegation(argv: readonly string[]): string | null {
  const positive = new Set<string>();
  const negative = new Set<string>();
  for (const token of beforeTerminator(argv)) {
    if (!token.startsWith('--') || token === '--') continue;
    const name = token.slice(2).split('=')[0] ?? '';
    if (name.startsWith('no-')) negative.add(name.slice(3));
    else if (name.length > 0) positive.add(name);
  }
  for (const name of negative) {
    if (positive.has(name)) return name;
  }
  return null;
}

/**
 * FR-A11: honor help/version only when the rest of the invocation is a valid
 * command/option sequence. Validate the help/version-stripped argv through the
 * silent validator; return a USAGE error when it is not valid, else null.
 */
async function validateHelpVersion(argv: readonly string[], io: Io): Promise<CrewError | null> {
  try {
    await buildValidator(io).parseAsync(stripHelpVersion(argv), { from: 'user' });
    return null;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (isCommanderSuccess(err)) {
        return null; // empty/help-only remainder — a legitimate help/version request
      }
      // An explicit help request is specifically allowed to omit the operand
      // it is asking the user to discover. All command/option validation still
      // ran, so unknown commands and options remain USAGE errors.
      if (err.code === 'commander.missingArgument') return null;
      return new CrewError('USAGE', usageMessageFor(err));
    }
    return new CrewError('USAGE', 'invalid usage; run "crew --help" for usage');
  }
}

function usageMessageFor(err: CommanderError): string {
  switch (err.code) {
    case 'commander.unknownOption':
      return 'unknown option; run "crew --help" for usage';
    case 'commander.unknownCommand':
    case 'commander.excessArguments':
      return 'unknown command; run "crew --help" for usage';
    default:
      return 'invalid usage; run "crew --help" for usage';
  }
}

function parsedJsonState(command: Command): { flag: boolean; valueCount: number } {
  let flag = false;
  let valueCount = 0;
  const options = command.opts<Record<string, unknown>>();
  for (const [name, value] of Object.entries(options)) {
    if (name === 'json' && value === true) flag = true;
    if (name !== 'json' && value === '--json') valueCount++;
    if (name !== 'json' && Array.isArray(value)) {
      valueCount += value.filter((item) => item === '--json').length;
    }
  }
  for (const child of command.commands) {
    const state = parsedJsonState(child);
    flag ||= state.flag;
    valueCount += state.valueCount;
  }
  return { flag, valueCount };
}

/**
 * Detect JSON error rendering through the same option grammar as execution.
 * The silent parser records whether `--json` was a flag or a value even on many
 * error paths. A residual raw token keeps JSON errors working when parsing stops
 * before reaching the flag (for example, after an unknown command).
 */
async function wantsJson(argv: readonly string[], io: Io): Promise<boolean> {
  const program = buildValidator(io);
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch {
    // Parsed option state up to the failure is still available below.
  }
  const state = parsedJsonState(program);
  if (state.flag) return true;
  const rawTokens = beforeTerminator(argv).filter((token) => token === '--json').length;
  return rawTokens > state.valueCount;
}

export async function run(argv: readonly string[], io: Io): Promise<number> {
  const json = await wantsJson(argv, io);

  // Reject a flag combined with its own negation (e.g. --worktree and --no-worktree)
  // before parsing, since commander would otherwise silently apply last-wins.
  const conflict = conflictingNegation(argv);
  if (conflict) {
    writeError(
      io,
      new CrewError('USAGE', `cannot combine --${conflict} and --no-${conflict}`),
      json,
    );
    return 2;
  }

  // FR-A11: a help/version request is honored only when the surrounding
  // command/option sequence is valid, so `crew bad --help` (etc.) is USAGE, not
  // a success that masks an unknown command or option.
  if (requestsHelpOrVersion(argv)) {
    const usage = await validateHelpVersion(argv, io);
    if (usage) {
      writeError(io, usage, json);
      return 2;
    }
  }

  try {
    const program = buildProgram(io);
    // A bare invocation is rejected by the program's root action (see cli.ts);
    // a matched subcommand resolves here and exits 0.
    await program.parseAsync([...argv], { from: 'user' });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (SUCCESS_COMMANDER_CODES.has(err.code) || err.exitCode === 0) {
        return 0;
      }
      const usage = new CrewError('USAGE', usageMessageFor(err));
      writeError(io, usage, json);
      return 2;
    }
    writeError(io, err, json);
    return exitCodeForError(err);
  }
}
