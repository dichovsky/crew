/**
 * Create-Task modal tests (FR-U15): the roster-backed assignee/reviewer
 * selects, the client-side guard that keeps an obviously-invalid POST off the
 * wire (missing title/assignee/reviewer), the optional brief, and the failure
 * path — a rejected create leaves the modal open with the server's message
 * shown, never silently swallowed. The POST itself is a passed-in async
 * callback; these assert wiring only.
 */
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateTaskModal, type CreateTaskInput } from './create-task-modal.js';

/** Fire a bubbling click on a (possibly just-re-queried) element. */
function click(el: Element | null | undefined): void {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

interface Overrides {
  onClose?: () => void;
  onCreate?: (input: CreateTaskInput) => Promise<void>;
  recipientOptions?: readonly { readonly id: string; readonly label: string }[];
}

const RECIPIENT_OPTIONS = [
  { id: 'grace', label: 'grace · worker' },
  { id: 'linus', label: 'linus · inspector' },
] as const;

function mount(opts: Overrides = {}): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(
    <CreateTaskModal
      recipientOptions={opts.recipientOptions ?? RECIPIENT_OPTIONS}
      onClose={opts.onClose ?? (() => {})}
      onCreate={opts.onCreate ?? (() => Promise.resolve())}
    />,
    host,
  );
  return host;
}

/**
 * Fill the draft fields; a `null` title leaves the input untouched. Awaits a
 * macrotask so the controlled-input state commits before the create reads it.
 */
async function fill(
  host: HTMLElement,
  title: string | null,
  assignee: string,
  reviewer: string,
): Promise<void> {
  if (title !== null) {
    const input = host.querySelector('#create-task-title') as HTMLInputElement;
    input.value = title;
    input.dispatchEvent(new Event('input'));
  }
  const assigneeSelect = host.querySelector('#create-task-assignee') as HTMLSelectElement;
  assigneeSelect.value = assignee;
  assigneeSelect.dispatchEvent(new Event('change'));
  const reviewerSelect = host.querySelector('#create-task-reviewer') as HTMLSelectElement;
  reviewerSelect.value = reviewer;
  reviewerSelect.dispatchEvent(new Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The modal's submit button (its label flips to "Creating…" while pending). */
function createButton(host: HTMLElement): Element | undefined {
  return [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Create task'));
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('CreateTaskModal', () => {
  it('moves focus to the title and restores the opener when unmounted', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const host = mount();

    await vi.waitFor(() =>
      expect(document.activeElement).toBe(host.querySelector('#create-task-title')),
    );
    render(null, host);
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    host.remove();
    opener.remove();
  });

  it('offers every roster agent as assignee and reviewer', () => {
    const host = mount();
    const values = (id: string): string[] =>
      [...host.querySelectorAll<HTMLOptionElement>(`#${id} option`)].map((o) => o.value);
    expect(values('create-task-assignee')).toEqual(['', 'grace', 'linus']);
    expect(values('create-task-reviewer')).toEqual(['', 'grace', 'linus']);
    host.remove();
  });

  it('explains and blocks creation when no active Agents are available', async () => {
    const onCreate = vi.fn(() => Promise.resolve());
    const host = mount({ recipientOptions: [], onCreate });
    const assignee = host.querySelector('#create-task-assignee') as HTMLSelectElement;
    const reviewer = host.querySelector('#create-task-reviewer') as HTMLSelectElement;
    expect(assignee.options[0]?.textContent).toBe('No active agents available');
    expect(assignee.disabled).toBe(true);
    expect(reviewer.disabled).toBe(true);
    expect((createButton(host) as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toContain(
      'Restore an Agent before creating a Task',
    );
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(host.querySelector('#create-task-title')),
    );
    expect(onCreate).not.toHaveBeenCalled();
    host.remove();
  });

  it('posts the trimmed draft with the optional brief and closes', async () => {
    const onCreate = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();
    const host = mount({ onCreate, onClose });
    await fill(host, '  Add X  ', 'grace', 'linus');
    const body = host.querySelector('#create-task-body') as HTMLTextAreaElement;
    body.value = ' the brief ';
    body.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(body.value).toBe(' the brief '));

    click(createButton(host));
    await vi.waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        assignee: 'grace',
        reviewer: 'linus',
        title: 'Add X',
        body: 'the brief',
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    host.remove();
  });

  it('omits an empty brief so the server applies its own default', async () => {
    const onCreate = vi.fn(() => Promise.resolve());
    const host = mount({ onCreate });
    await fill(host, 'No brief', 'grace', 'grace');
    click(createButton(host));
    await vi.waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        assignee: 'grace',
        reviewer: 'grace',
        title: 'No brief',
      }),
    );
    host.remove();
  });

  it('keeps an obviously-invalid draft off the wire', async () => {
    const onCreate = vi.fn(() => Promise.resolve());
    const host = mount({ onCreate });

    // Re-click inside waitFor so the render that shows the error cannot race
    // the assertion (the same idiom as the requeue-reason test).
    await vi.waitFor(() => {
      click(createButton(host));
      expect(host.querySelector('.modal-error')?.textContent).toContain('title is required');
    });

    await fill(host, 'Add X', '', '');
    await vi.waitFor(() => {
      click(createButton(host));
      expect(host.querySelector('.modal-error')?.textContent).toContain('Pick an assignee');
    });

    await fill(host, null, 'grace', '');
    await vi.waitFor(() => {
      click(createButton(host));
      expect(host.querySelector('.modal-error')?.textContent).toContain('Pick a reviewer');
    });
    expect(onCreate).not.toHaveBeenCalled();
    host.remove();
  });

  it('clears a selected Agent removed by a live roster refresh and does not create', async () => {
    const onCreate = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();
    const host = mount({ onCreate, onClose });
    await fill(host, 'Add X', 'grace', 'linus');

    // Preserve the mounted modal and its local draft while replacing the
    // snapshot-backed options. Before reconciliation, the select looked empty
    // but the retained `reviewer` still posted "linus".
    render(
      <CreateTaskModal
        recipientOptions={[{ id: 'grace', label: 'grace · worker' }]}
        onClose={onClose}
        onCreate={onCreate}
      />,
      host,
    );
    click(createButton(host));

    await vi.waitFor(() => {
      expect(host.querySelector('.modal-error')?.textContent).toContain('reviewer');
      expect(host.querySelector<HTMLSelectElement>('#create-task-reviewer')?.value).toBe('');
    });
    expect(onCreate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    host.remove();
  });

  it('surfaces a failed create and leaves the modal open', async () => {
    const onCreate = vi.fn(() => Promise.reject(new Error('[NOT_FOUND] no such agent "grace"')));
    const onClose = vi.fn();
    const host = mount({ onCreate, onClose });
    await fill(host, 'Add X', 'grace', 'linus');
    click(createButton(host));

    await vi.waitFor(() =>
      expect(host.querySelector('.modal-error')?.textContent).toContain('no such agent'),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(host.querySelector('.create-task-modal')).not.toBeNull();
    // The point of staying open is that the Operator can fix and retry, so pin the two
    // properties that make that possible rather than just the modal's presence.
    expect(host.querySelector<HTMLInputElement>('#create-task-title')?.value).toBe('Add X');
    expect(host.querySelector<HTMLSelectElement>('#create-task-assignee')?.value).toBe('grace');
    const retry = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Create task'),
    );
    expect(retry?.disabled).toBe(false);
    host.remove();
  });

  it('ignores Escape and backdrop dismissal while a create is in flight', async () => {
    let settle: () => void = () => {};
    const onCreate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const onClose = vi.fn();
    const host = mount({ onCreate, onClose });
    await fill(host, 'Add X', 'grace', 'linus');
    click(createButton(host));
    // Wait for the rendered pending state, not just the call. The submit label
    // flipping to "Creating…" proves the render-updated guard now reads true.
    await vi.waitFor(() => expect(host.textContent).toContain('Creating…'));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    click(host.querySelector('.modal-backdrop'));
    expect(onClose).not.toHaveBeenCalled();
    expect(host.querySelector('.create-task-modal')).not.toBeNull();

    settle();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    host.remove();
  });

  it('cancels on Escape and a backdrop click', async () => {
    const onClose = vi.fn();
    const host = mount({ onClose });
    // Re-dispatch inside waitFor: the keydown listener is registered by an
    // effect, which Preact defers past the synchronous render.
    await vi.waitFor(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(onClose).toHaveBeenCalled();
    });
    click(host.querySelector('.modal-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(2);
    host.remove();
  });
});
