/**
 * Quick-message modal tests: closed renders nothing; shows the addressed
 * Agent id and fires onSend/onTextChange; Cancel, Escape, and a backdrop
 * click all close it; focus lands on the textarea and restores on close;
 * pending disables input and both buttons; an error line renders. Effects
 * (focus, the document keydown listener) run asynchronously in Preact, so
 * the focus/Escape assertions poll with vi.waitFor.
 */
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageModal, type MessageModalProps } from './message-modal';

function mount(overrides: Partial<MessageModalProps> = {}): {
  host: HTMLElement;
  onTextChange: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  onSend: ReturnType<typeof vi.fn>;
} {
  const onTextChange = vi.fn();
  const onClose = vi.fn();
  const onSend = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(
    <MessageModal
      to="grace"
      text=""
      onTextChange={onTextChange}
      onClose={onClose}
      onSend={onSend}
      {...overrides}
    />,
    host,
  );
  return { host, onTextChange, onClose, onSend };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('MessageModal', () => {
  it('renders nothing when `to` is null', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(
      <MessageModal
        to={null}
        text=""
        onTextChange={() => {}}
        onClose={() => {}}
        onSend={() => {}}
      />,
      host,
    );
    expect(host.querySelector('.modal')).toBeNull();
    host.remove();
  });

  it('addresses the modal to the given Agent and fires onSend', () => {
    const { host, onSend } = mount();
    expect(host.querySelector('#message-modal-title')?.textContent).toBe('Message grace');
    (host.querySelector('.btn-primary') as HTMLButtonElement).click();
    expect(onSend).toHaveBeenCalledTimes(1);
    host.remove();
  });

  it('renders a hostile stored Agent id and error line as inert text', () => {
    const host = mount({
      to: '<img src=x onerror=alert(1)>',
      error: '<script>alert(2)</script>',
    }).host;
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(host.textContent).toContain('<script>alert(2)</script>');
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('script')).toBeNull();
    host.remove();
  });

  it('reports textarea input via onTextChange', () => {
    const { host, onTextChange } = mount();
    const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'hello';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onTextChange).toHaveBeenCalledWith('hello');
    host.remove();
  });

  it('moves focus to the textarea on open', async () => {
    const { host } = mount();
    await vi.waitFor(() => expect(document.activeElement).toBe(host.querySelector('textarea')));
    host.remove();
  });

  it('closes on the Cancel button, the close button, and a backdrop click', () => {
    const { host, onClose } = mount();
    host.querySelector('.btn-ghost')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    host.querySelector('.modal-close')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    host
      .querySelector('.modal-backdrop')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(3);
    host.remove();
  });

  it('closes on Escape once the keydown listener attaches', async () => {
    const { host, onClose } = mount();
    await vi.waitFor(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(onClose).toHaveBeenCalled();
    });
    host.remove();
  });

  it('disables the textarea and both buttons while pending and shows an error line', () => {
    const { host } = mount({ pending: true, error: 'Message is empty' });
    expect((host.querySelector('textarea') as HTMLTextAreaElement).disabled).toBe(true);
    expect((host.querySelector('.btn-primary') as HTMLButtonElement).disabled).toBe(true);
    expect((host.querySelector('.btn-ghost') as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelector('.modal-error')?.textContent).toBe('Message is empty');
    expect(host.querySelector('.btn-primary')?.textContent).toBe('Sending…');
    host.remove();
  });

  it('restores focus to the opener when it closes', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const props: MessageModalProps = {
      to: 'grace',
      text: '',
      onTextChange: () => {},
      onClose: () => {},
      onSend: () => {},
    };
    render(<MessageModal {...props} />, host);
    await vi.waitFor(() => expect(document.activeElement).toBe(host.querySelector('textarea')));
    render(<MessageModal {...props} to={null} />, host);
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    host.remove();
    opener.remove();
  });
});
