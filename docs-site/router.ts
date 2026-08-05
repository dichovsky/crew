/** Hash routing: every section is deep-linkable as `#/<id>`. */
import { useEffect, useState } from 'preact/hooks';

/** The section id in the current URL hash, or `fallback` when there is none. */
export function routeFromHash(hash: string, fallback: string): string {
  const id = hash.replace(/^#\/?/, '').trim();
  return id === '' ? fallback : id;
}

/** Subscribe to hash changes, re-rendering when the reader navigates. */
export function useHashRoute(fallback: string): string {
  const [route, setRoute] = useState(() => routeFromHash(window.location.hash, fallback));
  useEffect(() => {
    const onChange = () => {
      setRoute(routeFromHash(window.location.hash, fallback));
    };
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, [fallback]);
  return route;
}
