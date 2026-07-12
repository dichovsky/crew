/**
 * One-click confirm dialog tests (FR-U25 relaxed): Confirm fires the action;
 * Cancel, Escape, and a backdrop click all dismiss; focus lands on Confirm and
 * restores on close; pending disables both buttons; an error line renders.
 * Effects (focus, the document keydown listener) run asynchronously in Preact,
 * so the focus/Escape assertions poll with vi.waitFor.
 */
import { render } from 'preact';
import { useState } from 'preact/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, type ConfirmDialogProps } from './confirm-dialog';

function mount(overrides: Partial<ConfirmDialogProps> = {}): {
  host: HTMLElement;
  onConfirm: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
} {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(
    <ConfirmDialog
      open
      title="Remove the State Store"
      description="This cannot be undone."
      confirmLabel="Clean"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />,
    host,
  );
  return { host, onConfirm, onCancel };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ConfirmDialog (one-click)', () => {
  it('renders nothing when closed', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(
      <ConfirmDialog
        open={false}
        title="t"
        description="d"
        confirmLabel="Go"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      host,
    );
    expect(host.querySelector('.modal')).toBeNull();
    host.remove();
  });

  it('shows the title, description and confirm label, and fires onConfirm', () => {
    const { host, onConfirm } = mount();
    expect(host.querySelector('#confirm-dialog-title')?.textContent).toBe('Remove the State Store');
    const confirm = host.querySelector('.btn-confirm') as HTMLButtonElement;
    expect(confirm.textContent).toBe('Clean');
    confirm.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    host.remove();
  });

  it('moves focus to the confirm button on open', async () => {
    const { host } = mount();
    await vi.waitFor(() => expect(document.activeElement).toBe(host.querySelector('.btn-confirm')));
    host.remove();
  });

  it('cancels on the Cancel button and a backdrop click', () => {
    const { host, onCancel } = mount();
    host.querySelector('.btn-ghost')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    host
      .querySelector('.modal-backdrop')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    host.remove();
  });

  it('cancels on Escape once the keydown listener attaches', async () => {
    const { host, onCancel } = mount();
    // The document keydown listener attaches in an effect; poll until it fires.
    await vi.waitFor(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(onCancel).toHaveBeenCalled();
    });
    host.remove();
  });

  it('disables both buttons while pending and shows an error line', () => {
    const { host } = mount({ pending: true, error: 'boom' });
    expect((host.querySelector('.btn-confirm') as HTMLButtonElement).disabled).toBe(true);
    expect((host.querySelector('.btn-ghost') as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelector('.modal-error')?.textContent).toBe('boom');
    expect(host.querySelector('.btn-confirm')?.textContent).toBe('Working…');
    host.remove();
  });

  it('restores focus to the opener when it closes', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const props: ConfirmDialogProps = {
      open: true,
      title: 't',
      description: 'd',
      confirmLabel: 'Go',
      onConfirm: () => {},
      onCancel: () => {},
    };
    render(<ConfirmDialog {...props} />, host);
    await vi.waitFor(() => expect(document.activeElement).toBe(host.querySelector('.btn-confirm')));
    render(<ConfirmDialog {...props} open={false} />, host);
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    host.remove();
    opener.remove();
  });

  it('falls back to the marked region when the opener disables on confirm', async () => {
    // The real confirm path: accepting a destructive action closes the dialog
    // and disables its trigger in the same render, so the plain restore
    // no-ops. Focus must land on the [data-focus-fallback] region, not <body>.
    function Harness() {
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState(false);
      return (
        <div>
          <div class="region" data-focus-fallback tabIndex={-1} />
          <button class="trigger" disabled={busy} onClick={() => setOpen(true)}>
            Prune…
          </button>
          <ConfirmDialog
            open={open}
            title="Prune workspace history"
            description="This cannot be undone."
            confirmLabel="Prune"
            onConfirm={() => {
              setOpen(false);
              setBusy(true);
            }}
            onCancel={() => setOpen(false)}
          />
        </div>
      );
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(<Harness />, host);

    const trigger = host.querySelector('.trigger') as HTMLButtonElement;
    trigger.focus();
    trigger.click();
    await vi.waitFor(() => expect(document.activeElement).toBe(host.querySelector('.btn-confirm')));

    (host.querySelector('.btn-confirm') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(host.querySelector('.modal')).toBeNull());
    expect(trigger.disabled).toBe(true);
    await vi.waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(host.querySelector('.region'));
    });
    host.remove();
  });
});
