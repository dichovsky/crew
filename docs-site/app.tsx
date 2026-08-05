/**
 * The shell: a sidebar grouped by track, a hash-routed view, and a theme toggle.
 * Adapted from the Console's sidebar-and-router arrangement (web/app.tsx), but
 * this site shares no layout classes with it — only the design tokens.
 */
import { facts } from './facts';
import { useHashRoute } from './router';
import { DEFAULT_SECTION, SECTIONS, TRACKS, sectionById } from './sections';
import { useTheme } from './theme';

export function App() {
  const route = useHashRoute(DEFAULT_SECTION);
  const { theme, toggle } = useTheme();
  const active = sectionById(route) ?? sectionById(DEFAULT_SECTION);
  const unknown = sectionById(route) === undefined && route !== DEFAULT_SECTION;

  return (
    <div class="shell">
      <a class="skip" href="#main">
        Skip to content
      </a>

      <nav class="sidebar" aria-label="Documentation sections">
        <div class="brand">
          <span class="brand-name">crew</span>
          <span class="brand-version">{facts.package.version}</span>
        </div>
        <p class="brand-blurb">Local coordination for terminal coding agents.</p>

        {TRACKS.map((track) => (
          <div key={track.id} class="nav-group">
            <h2>{track.label}</h2>
            <p class="nav-blurb">{track.blurb}</p>
            <ul>
              {SECTIONS.filter((section) => section.track === track.id).map((section) => (
                <li key={section.id}>
                  <a
                    href={`#/${section.id}`}
                    class={active?.id === section.id ? 'is-current' : undefined}
                    aria-current={active?.id === section.id ? 'page' : undefined}
                  >
                    {section.nav}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}

        <div class="sidebar-foot">
          <button type="button" class="theme-toggle" onClick={toggle}>
            {theme === 'dark' ? '☀ Light' : '☾ Dark'}
          </button>
          <a href="https://github.com/dichovsky/crew" target="_blank" rel="noreferrer">
            Repository →
          </a>
        </div>
      </nav>

      <main id="main" class="content" tabIndex={-1}>
        {unknown && (
          <p class="unknown-route">
            No section named <code>{route}</code> — showing the first one instead.
          </p>
        )}
        {active !== undefined && <active.Component />}
      </main>
    </div>
  );
}
