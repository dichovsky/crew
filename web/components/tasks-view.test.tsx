/**
 * Tasks view tests: the five honest status columns (including a real,
 * selectable Abandoned column), selection, and the FR-U16/U17
 * approve/requeue controls with their enable matrix and the required requeue
 * reason. The POST is a passed-in async callback; these assert wiring only.
 */
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskSnapshotRecord } from '../types.js';
import { TasksView } from './tasks-view';

/** Fire a bubbling click on a (possibly just-re-queried) element. */
function click(el: Element | null | undefined): void {
  el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

const OPERATOR = 'operator';
const HOSTILE = '<img src=x onerror=alert(1)>';

function task(overrides: Partial<TaskSnapshotRecord> = {}): TaskSnapshotRecord {
  return {
    type: 'task',
    schema_version: 1,
    id: 'a'.repeat(36),
    title: 'Add X',
    body: 'body text',
    creator_id: 'manager',
    assignee_id: 'worker',
    reviewer_id: 'inspector',
    status: 'queued',
    revision: 0,
    lease_owner_id: null,
    lease_expires_at: null,
    submission_summary: null,
    submitted_at: null,
    review_summary: null,
    completed_at: null,
    abandoned_at: null,
    created_at: 0,
    updated_at: 0,
    stale_lease: false,
    events: [],
    ...overrides,
  };
}

interface Overrides {
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  onApprove?: (id: string) => Promise<void>;
  onRequeue?: (id: string, input: { reason: string; to?: string }) => Promise<void>;
}

function mount(tasks: readonly TaskSnapshotRecord[], opts: Overrides = {}): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(
    <TasksView
      tasks={tasks}
      selectedId={opts.selectedId ?? null}
      now={0}
      dark={false}
      disabled={false}
      recipientOptions={[{ id: 'grace', label: 'grace · worker' }]}
      onSelect={opts.onSelect ?? (() => {})}
      onApprove={opts.onApprove ?? (() => Promise.resolve())}
      onRequeue={opts.onRequeue ?? (() => Promise.resolve())}
    />,
    host,
  );
  return host;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('TasksView board', () => {
  it('renders five columns including Abandoned', () => {
    const host = mount([]);
    const columns = [...host.querySelectorAll('section[data-status]')].map((c) =>
      c.getAttribute('data-status'),
    );
    expect(columns).toEqual(['queued', 'in_progress', 'submitted', 'completed', 'abandoned']);
    host.remove();
  });

  it('renders an abandoned Task as a real, selectable card', () => {
    const onSelect = vi.fn();
    const host = mount([task({ id: 'z'.repeat(36), status: 'abandoned', title: 'dropped' })], {
      onSelect,
    });
    const abandoned = host.querySelector('section[data-status="abandoned"]');
    expect(abandoned?.textContent).toContain('dropped');
    const card = abandoned?.querySelector('button.task-card') as HTMLButtonElement;
    expect(card).not.toBeNull();
    card.click();
    expect(onSelect).toHaveBeenCalledWith('z'.repeat(36));
    host.remove();
  });

  it('marks the selected card and shows an empty prompt when nothing is selected', () => {
    const host = mount([task({ status: 'queued' })]);
    expect(host.querySelector('.task-card.selected')).toBeNull();
    expect(host.querySelector('.detail-empty')?.textContent).toContain('Select a task');
    host.remove();
  });

  it('renders hostile stored titles as inert text', () => {
    const host = mount([task({ title: HOSTILE })]);
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(host.querySelector('img')).toBeNull();
    host.remove();
  });
});

describe('TasksView detail actions', () => {
  it('offers Approve for a submitted task the operator reviews and fires the callback', async () => {
    const onApprove = vi.fn(() => Promise.resolve());
    const id = 's'.repeat(36);
    const host = mount([task({ id, status: 'submitted', reviewer_id: OPERATOR })], {
      selectedId: id,
      onApprove,
    });
    const approve = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Approve'),
    ) as HTMLButtonElement;
    expect(approve).toBeTruthy();
    approve.click();
    await Promise.resolve();
    expect(onApprove).toHaveBeenCalledWith(id);
    host.remove();
  });

  it('shows the submission summary and timeline for the selected task', () => {
    const id = 's'.repeat(36);
    const host = mount(
      [
        task({
          id,
          status: 'submitted',
          reviewer_id: OPERATOR,
          submission_summary: 'did the work',
          events: [
            {
              type: 'task_event',
              schema_version: 1,
              id: 1,
              task_id: id,
              revision: 0,
              event_type: 'submitted',
              actor_id: 'worker',
              from_status: 'in_progress',
              to_status: 'submitted',
              detail: 'submitted for review',
              created_at: 0,
            },
          ],
        }),
      ],
      { selectedId: id },
    );
    expect(host.querySelector('.submission')?.textContent).toContain('did the work');
    expect(host.querySelector('.timeline')?.textContent).toContain('submitted for review');
    host.remove();
  });

  it('requires a reason before requeue and passes reason + reassignee', async () => {
    const onRequeue = vi.fn(() => Promise.resolve());
    const id = 'p'.repeat(36);
    const host = mount([task({ id, status: 'in_progress', creator_id: OPERATOR })], {
      selectedId: id,
      onRequeue,
    });
    const requeueBtn = (): Element | undefined =>
      [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Requeue task'));
    // No reason yet: clicking surfaces the validation and does not call back.
    // Re-click inside waitFor so the one-time selection-reset effect (which
    // clears error on mount) cannot race the assertion.
    await vi.waitFor(() => {
      click(requeueBtn());
      expect(host.querySelector('.modal-error')?.textContent).toContain('reason');
    });
    expect(onRequeue).not.toHaveBeenCalled();

    const reason = host.querySelector('.requeue-box input') as HTMLInputElement;
    reason.value = 'needs rework';
    reason.dispatchEvent(new Event('input'));
    const select = host.querySelector('.requeue-box select') as HTMLSelectElement;
    select.value = 'grace';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(reason.value).toBe('needs rework');
      expect(select.value).toBe('grace');
    });
    click(requeueBtn());
    await vi.waitFor(() =>
      expect(onRequeue).toHaveBeenCalledWith(id, { reason: 'needs rework', to: 'grace' }),
    );
    host.remove();
  });

  it('shows a read-only note when the operator can neither approve nor requeue', () => {
    const id = 'c'.repeat(36);
    const host = mount([task({ id, status: 'completed' })], { selectedId: id });
    expect(host.querySelector('.readonly-note')?.textContent).toContain('view only');
    expect(
      [...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Approve')),
    ).toBe(false);
    host.remove();
  });
});
