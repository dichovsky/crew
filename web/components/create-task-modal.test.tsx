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
}

function mount(opts: Overrides = {}): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(
    <CreateTaskModal
      recipientOptions={[
        { id: 'grace', label: 'grace · worker' },
        { id: 'linus', label: 'linus · inspector' },
      ]}
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
  it('offers every roster agent as assignee and reviewer', () => {
    const host = mount();
    const values = (id: string): string[] =>
      [...host.querySelectorAll<HTMLOptionElement>(`#${id} option`)].map((o) => o.value);
    expect(values('create-task-assignee')).toEqual(['', 'grace', 'linus']);
    expect(values('create-task-reviewer')).toEqual(['', 'grace', 'linus']);
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
    host.remove();
  });

  it('cancels on Escape', async () => {
    const onClose = vi.fn();
    const host = mount({ onClose });
    // Re-dispatch inside waitFor: the keydown listener is registered by an
    // effect, which Preact defers past the synchronous render.
    await vi.waitFor(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(onClose).toHaveBeenCalled();
    });
    host.remove();
  });
});
