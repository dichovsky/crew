import { render } from 'preact';
import { useRef } from 'preact/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dialogFocusableNodes, useDialogFocus } from './dialog-focus.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('dialog focus', () => {
  it('builds one focus ring from links and every supported form control', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <a class="link" href="#destination">Link</a>
      <map><area class="area" href="#destination" /></map>
      <button class="button">Button</button>
      <input class="input" />
      <textarea class="textarea"></textarea>
      <select class="select"><option>Option</option></select>
      <div class="tabindex" tabindex="0">Custom control</div>
      <a class="no-href">Not a link</a>
      <button class="disabled" disabled>Disabled</button>
      <input class="hidden-input" type="hidden" tabindex="0" />
      <div class="negative-tabindex" tabindex="-1">Programmatic only</div>
      <div hidden><button class="hidden">Hidden</button></div>
    `;

    expect(dialogFocusableNodes(container).map((node) => node.className)).toEqual([
      'link',
      'area',
      'button',
      'input',
      'textarea',
      'select',
      'tabindex',
    ]);
  });

  it('wraps Tab and Shift-Tab at the ends of the shared focus ring', async () => {
    function Harness() {
      const containerRef = useRef<HTMLDivElement>(null);
      const initialFocusRef = useRef<HTMLInputElement>(null);
      useDialogFocus({
        open: true,
        containerRef,
        initialFocusRef,
        onDismiss: () => {},
      });
      return (
        <div ref={containerRef}>
          <a class="first" href="#first">
            First
          </a>
          <input ref={initialFocusRef} aria-label="Initial" />
          <textarea aria-label="Brief" />
          <select aria-label="Recipient">
            <option>Agent</option>
          </select>
          <div class="last" tabIndex={0}>
            Last
          </div>
        </div>
      );
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    render(<Harness />, host);
    await vi.waitFor(() => expect(document.activeElement).toBe(host.querySelector('input')));

    await vi.waitFor(() => {
      (host.querySelector('.last') as HTMLElement).focus();
      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      document.dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(host.querySelector('.first'));
    });

    (host.querySelector('.first') as HTMLElement).focus();
    const shiftTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(shiftTab);
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(host.querySelector('.last'));
    render(null, host);
    host.remove();
  });

  it('reads the latest dismiss callback and guard before effects flush', async () => {
    interface HarnessProps {
      readonly dismissDisabled: boolean;
      readonly onDismiss: () => void;
    }

    function Harness({ dismissDisabled, onDismiss }: HarnessProps) {
      const containerRef = useRef<HTMLDivElement>(null);
      const initialFocusRef = useRef<HTMLButtonElement>(null);
      useDialogFocus({
        open: true,
        containerRef,
        initialFocusRef,
        onDismiss,
        dismissDisabled,
      });
      return (
        <div ref={containerRef} tabIndex={-1}>
          <button ref={initialFocusRef}>Initial</button>
        </div>
      );
    }

    const firstDismiss = vi.fn();
    const latestDismiss = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(<Harness dismissDisabled={false} onDismiss={firstDismiss} />, host);
    await vi.waitFor(() => expect(document.activeElement).toBe(host.querySelector('button')));

    render(<Harness dismissDisabled onDismiss={latestDismiss} />, host);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(firstDismiss).not.toHaveBeenCalled();
    expect(latestDismiss).not.toHaveBeenCalled();

    render(<Harness dismissDisabled={false} onDismiss={latestDismiss} />, host);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(firstDismiss).not.toHaveBeenCalled();
    expect(latestDismiss).toHaveBeenCalledTimes(1);
    render(null, host);
    host.remove();
  });
});
