/**
 * RecoveryBanner tests (FR-U32): hidden when not visible; a role=alert with the
 * honest workspace-gone wording when visible; the optional reason renders and
 * hostile content stays inert.
 */
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { RecoveryBanner } from './recovery-banner';

function mount(props: { visible: boolean; reason?: string }): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(<RecoveryBanner {...props} />, host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('RecoveryBanner', () => {
  it('renders nothing when not visible', () => {
    const host = mount({ visible: false });
    expect(host.querySelector('.recovery')).toBeNull();
    host.remove();
  });

  it('renders a role=alert with the workspace-gone wording when visible', () => {
    const host = mount({ visible: true });
    const banner = host.querySelector('.recovery')!;
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.querySelector('.recovery-title')?.textContent).toBe('Workspace unavailable');
    expect(banner.textContent).toContain('last-known snapshot');
    host.remove();
  });

  it('renders an optional reason as inert text', () => {
    const host = mount({ visible: true, reason: '<img src=x onerror=alert(1)>' });
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(host.querySelector('img')).toBeNull();
    host.remove();
  });
});
