/**
 * PeekView tests (folded into Operations): GET /api/peek with the page token,
 * the sanitized capture rendered inside a <pre> (hostile lines inert), the
 * required-session guard, bounded error envelopes, and disabled controls.
 */
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PeekView } from './peek-view';

vi.mock('../api.js', () => ({ getToken: () => 'test-token' }));

function mount(disabled = false): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(<PeekView disabled={disabled} />, host);
  return host;
}

async function setSession(host: HTMLElement, value: string): Promise<void> {
  const el = host.querySelector('.peek-session-input') as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event('input'));
  // Wait for the controlled state to commit before submit reads it.
  await vi.waitFor(() => expect(el.value).toBe(value));
}

function submit(host: HTMLElement): void {
  host
    .querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('PeekView', () => {
  it('blocks an empty session client-side without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const host = mount();
    submit(host);
    await vi.waitFor(() =>
      expect(host.querySelector('.modal-error')?.textContent).toContain('Session name is required'),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    host.remove();
  });

  it('GETs /api/peek with the session and renders the sanitized capture', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ peek: { target: 'crew-dev:crew', text: 'pane output' } }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const host = mount();
    await setSession(host, 'crew-dev');
    submit(host);
    await vi.waitFor(() =>
      expect(host.querySelector('.peek-text')?.textContent).toBe('pane output'),
    );
    expect(host.querySelector('.peek-target')?.textContent).toBe('crew-dev:crew');
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain('/api/peek?session=crew-dev');
    host.remove();
  });

  it('renders hostile capture lines as inert text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ peek: { target: 't', text: '<img src=x onerror=alert(1)>' } }),
        } as unknown as Response),
      ),
    );
    const host = mount();
    await setSession(host, 'crew-dev');
    submit(host);
    await vi.waitFor(() => expect(host.querySelector('.peek-text')).not.toBeNull());
    expect(host.querySelector('.peek-text')?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(host.querySelector('img')).toBeNull();
    host.remove();
  });

  it('renders a bounded error envelope for an unowned session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ error: { code: 'NOT_FOUND', message: 'no such session' } }),
        } as unknown as Response),
      ),
    );
    const host = mount();
    await setSession(host, 'ghost');
    submit(host);
    await vi.waitFor(() =>
      expect(host.querySelector('.modal-error')?.textContent).toContain('no such session'),
    );
    host.remove();
  });

  it('disables the controls when the panel is disabled', () => {
    const host = mount(true);
    expect((host.querySelector('.peek-session-input') as HTMLInputElement).disabled).toBe(true);
    const peek = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Peek');
    expect(peek?.disabled).toBe(true);
    host.remove();
  });
});
