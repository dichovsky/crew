/** The bounded, closed query language accepted by `crew search`. */
import { CrewError } from './errors.js';

const MAX_SEARCH_QUERY_CODE_POINTS = 500;

/** An FTS5 expression produced only by the safe compiler below. */
export interface CompiledSearchQuery {
  readonly match: string;
}

/**
 * Compile Commander-preserved argv clauses into a bound FTS5 expression.
 *
 * One argv element is one clause: unquoted shell words arrive separately and
 * become AND clauses, while a shell-quoted phrase arrives as one element. Each
 * clause is an FTS5 string literal, so operator words and punctuation can never
 * escape into FTS syntax. A final `*` is the one supported operator and is
 * deliberately placed outside the quoted literal.
 */
export function compileSearchQuery(clauses: readonly string[]): CompiledSearchQuery {
  const joined = clauses.join(' ');
  const length = Array.from(joined).length;
  if (length < 1 || length > MAX_SEARCH_QUERY_CODE_POINTS) {
    throw new CrewError('USAGE', 'search query must be between 1 and 500 Unicode code points');
  }
  // A NUL cannot occur in a real process argv, and FTS5 treats it as the end of
  // its query string. Reject test/programmatic callers explicitly so this
  // compiler retains its guarantee that it cannot emit malformed MATCH syntax.
  if (joined.includes('\0')) {
    throw new CrewError('USAGE', 'search query must not contain NUL');
  }

  const match = clauses
    .map((clause) => {
      const prefix = clause.endsWith('*');
      const literal = prefix ? clause.slice(0, -1) : clause;
      const escaped = literal.replaceAll('"', '""');
      return `"${escaped}"${prefix ? '*' : ''}`;
    })
    .join(' AND ');
  return Object.freeze({ match });
}
