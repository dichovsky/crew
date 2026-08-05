/**
 * Light/dark presentation, mirroring the Console's approach (ADR-0017): the
 * stored preference is stamped onto `data-theme` on <html> so the browser's own
 * chrome matches, and only the neutral token scale flips.
 */
import { useCallback, useEffect, useState } from 'preact/hooks';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'crew-docs-theme';

/**
 * The stored preference, else light — the same default the Console uses
 * (FR-U38). Deliberately not derived from prefers-color-scheme, so the two
 * surfaces open the same way for the same reader.
 */
export function initialTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Private-mode storage denial is not an error worth surfacing to a reader.
  }
  return 'light';
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Preference simply does not persist; the page still renders correctly.
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggle };
}
