/**
 * The architecture diagram draws its agent row from the registry rather than a
 * fixed list, and marks exactly four seams. Both are claims the page makes in
 * prose, so both are asserted here.
 */
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { facts } from '../facts';
import { Modules } from './modules';

function mount(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(<Modules />, host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('architecture diagram', () => {
  it('shows every Participant the registry declares', () => {
    const host = mount();
    const labels = [...host.querySelectorAll('.chip-node text')].map((node) => node.textContent);
    expect(labels).toEqual(facts.registry.participants.map((participant) => participant.id));
  });

  it('marks exactly the four seams the section claims', () => {
    const host = mount();
    expect(host.querySelectorAll('.seam-dot')).toHaveLength(4);
  });

  it('makes every box selectable', () => {
    const host = mount();
    const boxes = host.querySelectorAll('[role="button"][aria-pressed]');
    expect(boxes.length).toBeGreaterThanOrEqual(15);
  });

  it('reveals a box detail when selected', async () => {
    const host = mount();
    const store = [...host.querySelectorAll('[role="button"]')].find(
      (node) => node.getAttribute('aria-label') === 'Store',
    );
    (store as SVGGElement | undefined)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const { vi } = await import('vitest');
    await vi.waitFor(() => {
      expect(host.querySelector('.explorer-detail')?.textContent).toContain('node:sqlite');
    });
  });
});
