/**
 * Drift guard for hand-written prose that is keyed by a generated fact: the
 * `task` subcommands come from `src/cli.ts` through `generated/facts.json`, and
 * every one of them that moves a Task from one status to another must be a step
 * on this page. The page shipped without `abandon` for exactly as long as
 * nothing checked (issue #42).
 */
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { facts } from '../facts';
import { Lifecycle, STEPS } from './lifecycle';

/**
 * The `task` subcommands that deliberately have no step: `list` and `show` are
 * read-only, and `review` and `land` act on a Task without changing its status
 * (`review` checks out a submitted Task's branch in the Inspector's Review
 * Worktree; `land` clears a completed Task's worktree bookkeeping and sends the
 * Sign-off).
 */
const NOT_TRANSITIONS = ['land', 'list', 'review', 'show'];

function taskSubcommands(): readonly string[] {
  return facts.commands.find((command) => command.name === 'task')?.subcommands ?? [];
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Task lifecycle', () => {
  it('steps through every status-changing task subcommand', () => {
    const transitions = taskSubcommands().filter((name) => !NOT_TRANSITIONS.includes(name));
    expect([...STEPS.map((step) => step.id)].sort()).toEqual([...transitions].sort());
  });

  it('excludes only subcommands the CLI still registers', () => {
    const stale = NOT_TRANSITIONS.filter((name) => !taskSubcommands().includes(name));
    expect(stale).toEqual([]);
  });

  it('draws a state box for every status a step activates', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(<Lifecycle />, host);
    const drawn = [...host.querySelectorAll('.node text')].map((node) => node.textContent);
    const activated = [...new Set(STEPS.map((step): string => step.active))];
    expect(activated.filter((state) => !drawn.includes(state))).toEqual([]);
  });
});
