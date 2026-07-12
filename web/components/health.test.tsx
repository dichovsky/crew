/**
 * HealthList tests: one row per finding with the severity dot/tag, an honest
 * empty state, and inert rendering of hostile stored messages.
 */
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { HealthList, type HealthFindingView } from './health';

function mount(findings: readonly HealthFindingView[]): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(<HealthList findings={findings} />, host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('HealthList', () => {
  it('renders an honest empty state when there are no findings', () => {
    const host = mount([]);
    expect(host.textContent).toContain('healthy');
    expect(host.querySelector('.health-row')).toBeNull();
    host.remove();
  });

  it('renders a row per finding with its code, message, and severity tag', () => {
    const host = mount([
      { severity: 'warn', code: 'STALE_LEASE', message: 'rob holds an expired lease' },
      { severity: 'error', code: 'STORE_CORRUPT', message: 'a corrupt page' },
      { severity: 'info', code: 'NODE_OK', message: 'runtime meets the floor' },
    ]);
    const rows = [...host.querySelectorAll('.health-row')];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('STALE_LEASE');
    expect(rows[0]?.textContent).toContain('rob holds an expired lease');
    const tags = [...host.querySelectorAll('.pill')].map((p) => p.textContent);
    expect(tags).toEqual(['WARN', 'ERROR', 'INFO']);
    host.remove();
  });

  it('renders hostile finding messages as inert text', () => {
    const host = mount([{ severity: 'warn', code: 'X', message: '<img src=x onerror=alert(1)>' }]);
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(host.querySelector('img')).toBeNull();
    host.remove();
  });
});
