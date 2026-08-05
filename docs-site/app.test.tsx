/**
 * The shell: the sidebar lists every section under its track, the hash selects
 * which one renders, and an unknown hash degrades to the first section with a
 * visible explanation rather than a blank page.
 */
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { DEFAULT_SECTION, SECTIONS, TRACKS } from './sections';

function mount(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(<App />, host);
  return host;
}

beforeEach(() => {
  window.location.hash = '';
  document.documentElement.removeAttribute('data-theme');
  window.localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('App shell', () => {
  it('links to every section, grouped by track', () => {
    const host = mount();
    const links = [...host.querySelectorAll('.nav-group a')].map((a) => a.getAttribute('href'));
    expect(links).toHaveLength(SECTIONS.length);
    for (const section of SECTIONS) {
      expect(links).toContain(`#/${section.id}`);
    }
    expect(host.querySelectorAll('.nav-group')).toHaveLength(TRACKS.length);
  });

  it('renders the default section when there is no hash', () => {
    const host = mount();
    const heading = host.querySelector('.section h1')?.textContent;
    expect(heading).toBe('What crew is');
    expect(host.querySelector(`a[href="#/${DEFAULT_SECTION}"]`)?.className).toContain('is-current');
  });

  it('renders the section named in the hash', () => {
    window.location.hash = '#/schema';
    const host = mount();
    expect(host.querySelector('.section h1')?.textContent).toBe('The State Store');
    expect(host.querySelector('a[href="#/schema"]')?.getAttribute('aria-current')).toBe('page');
  });

  it('explains an unknown hash instead of rendering nothing', () => {
    window.location.hash = '#/does-not-exist';
    const host = mount();
    expect(host.querySelector('.unknown-route')?.textContent).toContain('does-not-exist');
    expect(host.querySelector('.section h1')).not.toBeNull();
  });

  it('applies and persists the theme', async () => {
    const host = mount();
    // The theme is stamped from a post-mount effect, so wait for the default
    // before toggling — reading synchronously would see no attribute at all.
    await vi.waitFor(() => {
      expect(document.documentElement.dataset['theme']).toBe('light');
    });

    host.querySelector<HTMLButtonElement>('.theme-toggle')?.click();
    await vi.waitFor(() => {
      expect(document.documentElement.dataset['theme']).toBe('dark');
      expect(window.localStorage.getItem('crew-docs-theme')).toBe('dark');
    });
  });

  it('renders every section without throwing', () => {
    for (const section of SECTIONS) {
      window.location.hash = `#/${section.id}`;
      const host = mount();
      expect(host.querySelector('.section h1')?.textContent ?? '').not.toBe('');
      expect(host.querySelector('.sources')).not.toBeNull();
      document.body.innerHTML = '';
    }
  });
});
