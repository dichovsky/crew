/**
 * Agent-guide facts: a drift guard for the repository's own `CLAUDE.md`,
 * `AGENTS.md`, and `CONTRIBUTING.md`.
 *
 * Those three files hand-copy facts that live authoritatively elsewhere — the
 * `package.json` scripts, the `ci.yml` gate list, `vitest.config.ts`'s coverage
 * configuration, and the `Io` interface in `src/io.ts`. That is exactly the
 * parallel-table failure ADR-0006 forbids for the platform registry, and every
 * one of those restatements has already drifted at least once (#41 corrected
 * five falsifiable claims at once, including an `Io` enumeration that listed six
 * of ten members while asserting the list was exhaustive).
 *
 * `tests/unit/docs-facts.test.ts` prevents the same class of drift for
 * `docs-site/`; this is its sibling for the guides. The rule it follows is the
 * same one: every expectation is DERIVED from the authoritative source, never
 * written out here. A guard that hardcodes "4 tsconfigs" is a second copy of
 * the same bug.
 *
 * Every derivation is LAZY and memoized, and is performed inside an `it` rather
 * than in a `describe` body or at module scope. A guard whose parse can fail
 * during collection stops guarding EVERYTHING the moment a sentence it anchors
 * on is reworded — the mirror invariant and the `Io` enumeration would go down
 * with the CI paragraph. Keeping each parse inside its own test bounds the blast
 * radius of a stale anchor to the one fact it reads.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PARTICIPANT_TARGETS } from '../../src/platforms/registry.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** Cache a derivation so repeated tests parse once, without doing it eagerly. */
function memo<T>(build: () => T): () => T {
  let cached: T | undefined;
  return () => {
    if (cached === undefined) cached = build();
    return cached;
  };
}

/** The three files that restate the commands/CI facts, as [label, body]. */
const guides = memo((): ReadonlyArray<readonly [string, string]> => [
  ['CLAUDE.md', read('CLAUDE.md')],
  ['AGENTS.md', read('AGENTS.md')],
  ['CONTRIBUTING.md', read('CONTRIBUTING.md')],
]);

/** The mirrored pair: byte-identical apart from their identity lines. */
const mirrored = memo((): ReadonlyArray<readonly [string, string]> =>
  guides().filter(([label]) => label !== 'CONTRIBUTING.md'),
);

const pkg = memo(
  () =>
    JSON.parse(read('package.json')) as {
      readonly scripts: Record<string, string>;
      readonly engines: { readonly node: string };
    },
);
const vitestConfig = memo(() => read('vitest.config.ts'));
const ciYaml = memo(() => read('.github/workflows/ci.yml'));
const ioSource = memo(() => read('src/io.ts'));

/** Collapse every whitespace run so a claim can be matched across line wraps. */
const flat = (markdown: string): string => markdown.replace(/\s+/g, ' ');

/** Cardinal words for the small counts the guides spell out in prose. */
const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
] as const;

function word(count: number): string {
  const spelled = NUMBER_WORDS[count];
  if (spelled === undefined) {
    throw new Error(`No cardinal word for ${count} — extend NUMBER_WORDS in guide-facts.test.ts`);
  }
  return spelled;
}

/** Read one required capture out of `source`, failing loudly when the shape moved. */
function required(source: string, pattern: RegExp, label: string): string {
  const captured = pattern.exec(source)?.[1];
  if (captured === undefined) {
    throw new Error(
      `Could not read ${label} — the wording this guard anchors on changed. ` +
        'Re-point the pattern in tests/unit/guide-facts.test.ts; the fact itself may be fine.',
    );
  }
  return captured;
}

/**
 * Compare a cardinal word the guide spells out against a derived count. Both
 * the claim and the count are named in the failure message, so a genuine
 * miscount is never confused with a reworded sentence (which throws above).
 */
function expectSpelledCount(
  body: string,
  pattern: RegExp,
  count: number,
  label: string,
  what: string,
): void {
  const claimed = required(body, pattern, `${label}'s ${what} sentence`);
  expect(
    claimed,
    `${label} spells the ${what} as "${claimed}" but the source declares ${count} (${word(count)})`,
  ).toBe(word(count));
}

// ---------------------------------------------------------------------------
// The `## Commands` block
// ---------------------------------------------------------------------------

/**
 * The `npm` lines of a guide's `## Commands` fenced block, as command →
 * trailing `#` annotation. Non-`npm` lines (the `npx vitest` examples) and bare
 * comment lines are not restatements of a script, so they are skipped.
 */
function commandAnnotations(markdown: string, label: string): Map<string, string> {
  const heading = markdown.indexOf('## Commands');
  if (heading < 0) throw new Error(`${label} has no "## Commands" heading`);
  const open = markdown.indexOf('```sh', heading);
  const close = markdown.indexOf('```', open + 5);
  if (open < 0 || close < 0) throw new Error(`${label}'s Commands section has no \`\`\`sh block`);
  const annotations = new Map<string, string>();
  for (const line of markdown.slice(open, close).split('\n')) {
    const match = /^npm (?:run )?([\w:-]+)\s+#\s*(.+?)\s*$/.exec(line);
    if (match !== null) annotations.set(match[1]!, match[2]!);
  }
  if (annotations.size === 0) throw new Error(`${label}'s Commands block annotates no npm script`);
  return annotations;
}

const commands = memo(
  () => new Map(guides().map(([label, body]) => [label, commandAnnotations(body, label)] as const)),
);

/** Assert `script` is annotated somewhere, and hand back that annotation. */
function requireAnnotation(script: string): string {
  for (const block of commands().values()) {
    const annotation = block.get(script);
    if (annotation !== undefined) return annotation;
  }
  throw new Error(`No guide annotates the "${script}" script — the Commands block lost a gate`);
}

describe('guide Commands block vs package.json', () => {
  it('annotates only scripts package.json actually defines', () => {
    const scripts = pkg().scripts;
    for (const [label, block] of commands()) {
      const unknown = [...block.keys()].filter((script) => scripts[script] === undefined);
      expect(unknown, `${label} documents scripts that no longer exist`).toEqual([]);
    }
  });

  it('names only real scripts inside the annotations themselves', () => {
    // Every `x:y` token in an annotation is a script cross-reference
    // (`build:web`, `lint:fix`, `format:check`). Prose colons are always
    // followed by a space, so they never match.
    const scripts = pkg().scripts;
    for (const [label, block] of commands()) {
      for (const [script, annotation] of block) {
        for (const [, referenced] of annotation.matchAll(/\b([a-z][\w-]*:[a-z][\w-]*)\b/g)) {
          expect(
            scripts[referenced!],
            `${label}'s "${script}" annotation references the missing script "${referenced!}"`,
          ).toBeDefined();
        }
      }
    }
  });

  it('agrees word for word across every guide that documents the same script', () => {
    // CONTRIBUTING.md's Commands block is currently byte-identical to the same
    // lines of both agent guides; a one-file edit must fail rather than fork them.
    const blocks = commands();
    for (const script of new Set([...blocks.values()].flatMap((block) => [...block.keys()]))) {
      const wording = guides()
        .map(([label]) => blocks.get(label)!.get(script))
        .filter((annotation) => annotation !== undefined);
      expect(
        new Set(wording).size,
        `the guides disagree about "${script}": ${wording.join(' | ')}`,
      ).toBe(1);
    }
  });

  it('documents every CI gate in every guide, not just in one of them', () => {
    // `requireAnnotation` is satisfied by ANY guide, and the agreement test
    // above only compares guides that still document a script — so without
    // this, deleting a whole command line from one file passes silently.
    // CONTRIBUTING.md has no mirror invariant, so it is the exposed file.
    // A gate counts as documented when it is a command in the block or is named
    // inside an annotation (`format:check` lives in the `format` annotation).
    for (const gate of ciGates()) {
      for (const [label, block] of commands()) {
        const documented =
          block.has(gate) || [...block.values()].some((note) => note.includes(gate));
        expect(documented, `${label}'s Commands block never mentions the "${gate}" CI gate`).toBe(
          true,
        );
      }
    }
  });

  it('states the typecheck project count and every project directory', () => {
    // The fact that drifted: the annotation spells out how many tsconfig
    // projects the gate compiles. Both the count and the directory list are
    // read out of the script, so adding a project fails here until the
    // annotation is updated.
    const script = pkg().scripts['typecheck']!;
    const projects = [...script.matchAll(/tsc -p (\S+)/g)].map((match) => match[1]!);
    expect(projects.length, 'the typecheck script compiles no project').toBeGreaterThan(0);
    const annotation = requireAnnotation('typecheck');
    const claimed = Number(required(annotation, /(\d+) tsconfigs?/, 'the typecheck project count'));
    expect(
      claimed,
      `the typecheck annotation claims ${claimed} projects but the script compiles ${projects.length}: ${projects.join(', ')}`,
    ).toBe(projects.length);
    for (const project of projects) {
      const dir = dirname(project);
      const token = dir === '.' ? 'root' : `${dir}/`;
      expect(annotation, `the typecheck annotation omits ${project}`).toContain(token);
    }
  });

  it('names every project and sub-script the build gate runs', () => {
    const script = pkg().scripts['build']!;
    const annotation = requireAnnotation('build');
    for (const [, project] of script.matchAll(/tsc -p (\S+)/g)) {
      expect(annotation).toContain(`tsc -p ${project!}`);
    }
    for (const [, sub] of script.matchAll(/npm run ([\w:-]+)/g)) {
      expect(annotation, `the build annotation omits the ${sub!} step`).toContain(sub!);
    }
  });

  it('names the directory the docs bundle is written to', () => {
    const outdir = required(pkg().scripts['build:docs']!, /--outdir=(\S+)/, "build:docs' --outdir");
    expect(requireAnnotation('build:docs')).toContain(outdir);
  });

  it('states the coverage threshold and metrics the gate enforces', () => {
    const annotation = requireAnnotation('test:coverage');
    expect(annotation).toContain(`${coverageThreshold()}%`);
    for (const metric of COVERAGE_METRICS) expect(annotation).toContain(metric);
  });
});

// ---------------------------------------------------------------------------
// The CI paragraph
// ---------------------------------------------------------------------------

/**
 * The `jobs:` mapping of `ci.yml`, as job name → that job's block.
 *
 * Scoped to `jobs:` because `on:` also has two-space keys (`push`,
 * `pull_request`), which a bare indent match would pick up as jobs.
 */
const ciJobs = memo((): Map<string, string> => {
  const anchor = ciYaml().indexOf('\njobs:\n');
  if (anchor < 0) throw new Error('ci.yml has no `jobs:` mapping');
  const region = ciYaml().slice(anchor + '\njobs:\n'.length);
  const starts = [...region.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)];
  if (starts.length === 0) throw new Error('ci.yml declares no job');
  return new Map(
    starts.map((match, index) => [
      match[1]!,
      region.slice(match.index, starts[index + 1]?.index ?? region.length),
    ]),
  );
});

/**
 * The gate job: the FIRST job in the workflow. Selected structurally rather
 * than from the guides' prose, so a reworded sentence cannot take the gate
 * list, the gate count, and the Node version down with it — the guides' claim
 * about WHICH job it is carries its own test below.
 */
const ciGateJob = memo(() => [...ciJobs().values()][0]!);
const ciGateJobName = memo(() => [...ciJobs().keys()][0]!);
/** Every `npm run …` step of the gate job, in workflow order. */
const ciGates = memo(() =>
  [...ciGateJob().matchAll(/-\s*run:\s*npm run ([\w:-]+)/g)].map((match) => match[1]!),
);

describe('guide CI paragraph vs .github/workflows/ci.yml', () => {
  it('names the job that actually runs the gates', () => {
    for (const [label, body] of mirrored()) {
      const named = required(flat(body), /`([a-z][\w-]*)` job must pass/, `${label}'s CI job name`);
      expect(
        named,
        `${label} points at the "${named}" job, but the gates run in "${ciGateJobName()}"`,
      ).toBe(ciGateJobName());
    }
  });

  it('lists every gate the workflow runs, in workflow order', () => {
    const gates = ciGates();
    expect(gates.length, `the ${ciGateJobName()} job runs no npm script`).toBeGreaterThan(0);
    for (const [label, body] of guides()) {
      expect(flat(body), `${label}'s CI gate list drifted`).toContain(gates.join(' → '));
    }
  });

  it('counts those gates correctly in prose', () => {
    for (const [label, body] of mirrored()) {
      expectSpelledCount(
        flat(body),
        /All (\w+) of those gates/,
        ciGates().length,
        label,
        'CI gate count',
      );
    }
  });

  it('states the Node version the workflow pins', () => {
    const version = required(ciGateJob(), /node-version: '([\d.]+)'/, "the CI job's node-version");
    for (const [label, body] of guides()) {
      expect(flat(body), `${label} names the wrong CI Node version`).toContain(
        `Node \`${version}\``,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The coverage gate description
// ---------------------------------------------------------------------------

const COVERAGE_METRICS = ['statements', 'branches', 'functions', 'lines'] as const;

/** The `coverage: { … }` region of vitest.config.ts, above the projects list. */
const coverageConfig = memo(() => {
  const open = vitestConfig().indexOf('coverage: {');
  const close = vitestConfig().indexOf('projects:');
  if (open < 0 || close < 0) throw new Error('vitest.config.ts has no coverage block to read');
  return vitestConfig().slice(open, close);
});

/** The single threshold all four coverage metrics share. */
const coverageThreshold = memo(() => {
  const thresholds = COVERAGE_METRICS.map((metric) =>
    Number(required(coverageConfig(), new RegExp(`${metric}:\\s*(\\d+)`), `the ${metric} gate`)),
  );
  expect(
    new Set(thresholds).size,
    `the four coverage thresholds diverged: ${thresholds.join(', ')}`,
  ).toBe(1);
  return thresholds[0]!;
});

const coverageGlobs = (key: string): string[] =>
  [
    ...required(
      coverageConfig(),
      new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`),
      `coverage.${key}`,
    ).matchAll(/'([^']+)'/g),
  ].map((match) => match[1]!);

describe('guide coverage description vs vitest.config.ts', () => {
  /** The `## Tests` section of a guide, bounded by the next level-2 heading. */
  function testsSection(body: string, label: string): string {
    const open = body.indexOf('## Tests');
    if (open < 0) throw new Error(`${label} has no "## Tests" heading`);
    const rest = body.slice(open + 1);
    const close = rest.indexOf('\n## ');
    // A missing terminator would silently widen the window to the whole file,
    // so it is an error rather than a default.
    if (close < 0)
      throw new Error(`${label}'s "## Tests" section has no following level-2 heading`);
    return flat(rest.slice(0, close));
  }

  it('states the same threshold, included globs, and exclusion as the gate', () => {
    const threshold = coverageThreshold();
    const included = coverageGlobs('include');
    const excluded = coverageGlobs('exclude');
    expect(included.length, 'coverage.include is empty').toBeGreaterThan(0);
    expect(excluded.length, 'coverage.exclude is empty').toBeGreaterThan(0);

    for (const [label, body] of mirrored()) {
      const tests = testsSection(body, label);
      expect(tests, `${label} states the wrong coverage threshold`).toContain(`${threshold}%`);
      for (const glob of included) {
        expect(tests, `${label} omits the covered glob ${glob}`).toContain(`\`${glob}\``);
      }
      for (const path of excluded) {
        expect(tests, `${label} omits the coverage exclusion ${path}`).toContain('excluding');
        expect(tests, `${label} omits the coverage exclusion ${path}`).toContain(`\`${path}\``);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The `src/io.ts` seam bullet
// ---------------------------------------------------------------------------

/**
 * Every member declared directly on the `Io` interface, `readonly` or not.
 *
 * #103's Acceptance says "every `readonly` member", and every member is
 * `readonly` today — but a member that simply omitted the modifier would escape
 * a `readonly`-anchored parse while still making the guides' field count wrong,
 * so this matches the modifier optionally. Nested brace/paren groups are removed
 * first, so an inline parameter object (`opts: { readonly timeoutMs: number }`)
 * cannot be mistaken for a member of `Io` however it is later reformatted.
 */
function ioMembers(): string[] {
  const open = ioSource().indexOf('{', ioSource().indexOf('export interface Io'));
  if (open < 0) throw new Error('src/io.ts declares no `export interface Io`');
  let depth = 0;
  let close = open;
  for (; close < ioSource().length; close++) {
    const char = ioSource()[close];
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) break;
  }
  let interior = ioSource()
    .slice(open + 1, close)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  let previous = '';
  while (interior !== previous) {
    previous = interior;
    interior = interior.replace(/\{[^{}]*\}/g, '').replace(/\([^()]*\)/g, '');
  }
  return [...interior.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/gm)].map(
    (match) => match[1]!,
  );
}

describe('guide Io bullet vs src/io.ts', () => {
  /** The `- **`src/io.ts`**` bullet of a guide, up to the next top-level bullet. */
  function ioBullet(markdown: string, label: string): string {
    const start = markdown.indexOf('- **`src/io.ts`**');
    if (start < 0) throw new Error(`${label} has no \`src/io.ts\` seam bullet`);
    const rest = markdown.slice(start + 1);
    const next = rest.indexOf('\n- **');
    return flat(next < 0 ? rest : rest.slice(0, next));
  }

  it('declares members at all (the parse still matches src/io.ts)', () => {
    const members = ioMembers();
    expect(members).toContain('cwd');
    expect(members).toContain('runInteractive');
    // The inline `{ readonly timeoutMs: number }` parameter object is not a member.
    expect(members).not.toContain('timeoutMs');
  });

  it('enumerates exactly the interface members, no more and no fewer', () => {
    const members = ioMembers();
    for (const [label, body] of mirrored()) {
      const bullet = ioBullet(body, label);
      // The enumeration runs from the "boundary:" colon to the end of that
      // sentence. Parentheticals are stripped first: their backticked asides
      // (`Math.random`, `captureIo`) are glosses, not members.
      const sentence = bullet.slice(bullet.indexOf('boundary:'));
      if (!sentence.startsWith('boundary:')) {
        throw new Error(`${label}'s Io bullet no longer enumerates the fields after "boundary:"`);
      }
      let stripped = sentence;
      let previous = '';
      while (stripped !== previous) {
        previous = stripped;
        stripped = stripped.replace(/\([^()]*\)/g, '');
      }
      const enumeration = stripped.slice(0, stripped.indexOf('.'));
      const listed = [...enumeration.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
      expect([...listed].sort(), `${label}'s Io enumeration drifted from the interface`).toEqual(
        [...members].sort(),
      );
    }
  });

  it('counts those members correctly in prose', () => {
    const members = ioMembers();
    for (const [label, body] of mirrored()) {
      expectSpelledCount(
        ioBullet(body, label),
        /the (\w+) fields/,
        members.length,
        label,
        'Io field count',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Remaining derived claims + the mirror invariant
// ---------------------------------------------------------------------------

describe('guide claims derived from the authoritative modules', () => {
  it('counts the Participant CLIs the registry declares', () => {
    for (const [label, body] of mirrored()) {
      expectSpelledCount(
        flat(body),
        /the (\w+) Participant CLIs/,
        PARTICIPANT_TARGETS.length,
        label,
        'Participant CLI count',
      );
    }
  });

  it('states the Node floor package.json enforces', () => {
    const floor = pkg().engines.node;
    for (const [label, body] of guides()) {
      expect(flat(body), `${label} states the wrong Node floor`).toContain(`\`${floor}\``);
    }
  });
});

describe('CLAUDE.md and AGENTS.md are one file with two names', () => {
  it('differ only in the H1 and the guidance sentence beneath it', () => {
    // The mirror is enforced by author discipline alone today: every change has
    // to land in both, and nothing fails when a future edit touches only one.
    const claude = read('CLAUDE.md').split('\n');
    const agents = read('AGENTS.md').split('\n');
    expect(agents.length, 'the guides no longer have the same line count').toBe(claude.length);

    const differing = claude
      .map((line, index) => (line === agents[index] ? -1 : index))
      .filter((index) => index >= 0);
    // Line 1 is the H1, line 3 is the audience sentence; nothing else may fork.
    expect(differing.map((index) => index + 1)).toEqual([1, 3]);
    expect(claude[0]).toBe('# CLAUDE.md');
    expect(agents[0]).toBe('# AGENTS.md');
    expect(claude[2]).toMatch(/^This file provides guidance to /);
    expect(agents[2]).toMatch(/^This file provides guidance to /);
  });
});
