/**
 * Pure git branch/revision syntax validation (FR-H10/H22).
 *
 * Validating refs in-process lets `--print` keep its "fully validated plan" promise
 * WITHOUT a subprocess, and closes two gaps: a value git would parse as an option
 * (e.g. `--upload-pack=…`, `--help`) — argument injection into the git binary that
 * `shell:false` does not prevent — and a malformed ref (e.g. `bad..name`) that git
 * cannot execute. The rules are the subset of `git check-ref-format` crew relies on.
 */
import { CrewError } from '../errors.js';

// ASCII control characters (C0 range plus DEL): invalid in refs and unsafe in output.
// Built from escape sequences so the source carries no literal control byte; matching
// control characters IS the intent, so the no-control-regex rule is disabled here.
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f]');

function invalid(label: string, detail: string): never {
  throw new CrewError('INVALID_CONFIG', `${label}: ${detail}`);
}

/**
 * Reject a value git would read as an option, or that carries control characters or
 * whitespace. Shared by branch and revision validation; also the option-injection guard.
 */
function assertArgSafe(value: string, label: string): void {
  if (value.length === 0) invalid(label, 'must not be empty');
  if (value.startsWith('-')) {
    invalid(label, `must not start with "-" (git option injection): ${value}`);
  }
  if (CONTROL.test(value)) invalid(label, 'must not contain control characters');
  if (/\s/.test(value)) invalid(label, `must not contain whitespace: ${value}`);
}

/** Validate a git branch NAME (the `git check-ref-format --branch` subset crew needs). */
export function assertValidBranch(name: string, label: string): void {
  assertArgSafe(name, label);
  if (
    name === '@' ||
    name.includes('..') ||
    name.includes('@{') ||
    name.includes('//') ||
    /[~^:?*[\\]/.test(name) ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.endsWith('.lock')
  ) {
    invalid(label, `is not a valid git branch name: ${name}`);
  }
  // `git check-ref-format --branch` additionally applies these rules to every
  // slash-separated component, not only to the complete ref.
  if (
    name.split('/').some((component) => component.startsWith('.') || component.endsWith('.lock'))
  ) {
    invalid(label, `is not a valid git branch name: ${name}`);
  }
}

/** Validate a base revision (branch/tag/SHA/`HEAD`): argument-safe, no range/reflog syntax. */
export function assertValidRevision(rev: string, label: string): void {
  assertArgSafe(rev, label);
  if (rev.includes('..') || rev.includes('@{')) {
    invalid(label, `is not a valid base revision: ${rev}`);
  }
}
