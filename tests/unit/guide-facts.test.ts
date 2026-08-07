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
 * written out here. A guard that hardcodes "3 tsconfigs" is a second copy of
 * the same bug.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PARTICIPANT_TARGETS } from '../../src/platforms/registry.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const CLAUDE_MD = read('CLAUDE.md');
const AGENTS_MD = read('AGENTS.md');
const CONTRIBUTING_MD = read('CONTRIBUTING.md');

/** The three files that restate the commands/CI facts, by path. */
const GUIDES: ReadonlyArray<readonly [string, string]> = [
  ['CLAUDE.md', CLAUDE_MD],
  ['AGENTS.md', AGENTS_MD],
  ['CONTRIBUTING.md', CONTRIBUTING_MD],
];

/** The mirrored pair: byte-identical apart from their identity lines. */
const MIRRORED: ReadonlyArray<readonly [string, string]> = [
  ['CLAUDE.md', CLAUDE_MD],
  ['AGENTS.md', AGENTS_MD],
];

const pkg = JSON.parse(read('package.json')) as {
  readonly scripts: Record<string, string>;
  readonly engines: { readonly node: string };
};
const VITEST_CONFIG = read('vitest.config.ts');
const CI_YAML = read('.github/workflows/ci.yml');
const IO_SOURCE = read('src/io.ts');

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
    throw new Error(`Could not read ${label} — update tests/unit/guide-facts.test.ts`);
  }
  return captured;
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

const COMMANDS = new Map(
  GUIDES.map(([label, body]) => [label, commandAnnotations(body, label)] as const),
);

/** The annotation every guide agrees on for `script`, or `undefined`. */
function annotationFor(script: string): string | undefined {
  for (const block of COMMANDS.values()) {
    const annotation = block.get(script);
    if (annotation !== undefined) return annotation;
  }
  return undefined;
}

/** Assert `script` is annotated somewhere, and hand back that annotation. */
function requireAnnotation(script: string): string {
  const annotation = annotationFor(script);
  if (annotation === undefined) {
    throw new Error(`No guide annotates the "${script}" script — the Commands block lost a gate`);
  }
  return annotation;
}

describe('guide Commands block vs package.json', () => {
  it('annotates only scripts package.json actually defines', () => {
    for (const [label, block] of COMMANDS) {
      const unknown = [...block.keys()].filter((script) => pkg.scripts[script] === undefined);
      expect(unknown, `${label} documents scripts that no longer exist`).toEqual([]);
    }
  });

  it('names only real scripts inside the annotations themselves', () => {
    // Every `x:y` token in an annotation is a script cross-reference
    // (`build:web`, `lint:fix`, `format:check`). Prose colons are always
    // followed by a space, so they never match.
    for (const [label, block] of COMMANDS) {
      for (const [script, annotation] of block) {
        for (const [, referenced] of annotation.matchAll(/\b([a-z][\w-]*:[a-z][\w-]*)\b/g)) {
          expect(
            pkg.scripts[referenced!],
            `${label}'s "${script}" annotation references the missing script "${referenced!}"`,
          ).toBeDefined();
        }
      }
    }
  });

  it('agrees word for word across every guide that documents the same script', () => {
    // CONTRIBUTING.md:24-26 is currently byte-identical to the same lines of
    // both agent guides; a one-file edit must fail rather than fork them.
    for (const script of new Set([...COMMANDS.values()].flatMap((b) => [...b.keys()]))) {
      const wording = GUIDES.map(([label]) => COMMANDS.get(label)!.get(script)).filter(
        (annotation) => annotation !== undefined,
      );
      expect(
        new Set(wording).size,
        `the guides disagree about "${script}": ${wording.join(' | ')}`,
      ).toBe(1);
    }
  });

  it('states the typecheck project count and every project directory', () => {
    // The fact that drifted: the annotation spells out how many tsconfig
    // projects the gate compiles. Both the count and the directory list are
    // read out of the script, so adding a fourth project fails here until the
    // annotation is updated.
    const script = pkg.scripts['typecheck']!;
    const projects = [...script.matchAll(/tsc -p (\S+)/g)].map((match) => match[1]!);
    expect(projects.length, 'the typecheck script compiles no project').toBeGreaterThan(0);
    const annotation = requireAnnotation('typecheck');
    expect(Number(required(annotation, /(\d+) tsconfigs?/, 'the typecheck project count'))).toBe(
      projects.length,
    );
    for (const project of projects) {
      const dir = dirname(project);
      const token = dir === '.' ? 'root' : `${dir}/`;
      expect(annotation, `the typecheck annotation omits ${project}`).toContain(token);
    }
  });

  it('names every project and sub-script the build gate runs', () => {
    const script = pkg.scripts['build']!;
    const annotation = requireAnnotation('build');
    for (const [, project] of script.matchAll(/tsc -p (\S+)/g)) {
      expect(annotation).toContain(`tsc -p ${project!}`);
    }
    for (const [, sub] of script.matchAll(/npm run ([\w:-]+)/g)) {
      expect(annotation, `the build annotation omits the ${sub!} step`).toContain(sub!);
    }
  });

  it('names the directory the docs bundle is written to', () => {
    const outdir = required(pkg.scripts['build:docs']!, /--outdir=(\S+)/, "build:docs' --outdir");
    expect(requireAnnotation('build:docs')).toContain(outdir);
  });

  it('states the coverage threshold and metrics the gate enforces', () => {
    const metrics = ['statements', 'branches', 'functions', 'lines'] as const;
    const thresholds = metrics.map((metric) =>
      Number(
        required(VITEST_CONFIG, new RegExp(`${metric}:\\s*(\\d+)`), `the ${metric} threshold`),
      ),
    );
    expect(new Set(thresholds).size, 'the four thresholds diverged').toBe(1);
    const annotation = requireAnnotation('test:coverage');
    expect(annotation).toContain(`${thresholds[0]!}%`);
    for (const metric of metrics) expect(annotation).toContain(metric);
  });
});

// ---------------------------------------------------------------------------
// The CI paragraph
// ---------------------------------------------------------------------------

/** The `jobs:` block of `ci.yml` named `job`, sliced off at the next job key. */
function ciJob(job: string): string {
  const start = new RegExp(`^ {2}${job}:$`, 'm').exec(CI_YAML)?.index;
  if (start === undefined) throw new Error(`ci.yml has no "${job}" job`);
  const rest = CI_YAML.slice(start + 1);
  const next = /^ {2}[A-Za-z0-9_-]+:$/m.exec(rest)?.index;
  return next === undefined ? rest : rest.slice(0, next);
}

describe('guide CI paragraph vs .github/workflows/ci.yml', () => {
  // The guides name the job themselves, so the job name is a checked claim too:
  // a renamed job fails inside ciJob() rather than silently guarding nothing.
  const jobName = required(flat(CLAUDE_MD), /`([a-z][\w-]*)` job must pass/, 'the CI job name');
  const job = ciJob(jobName);
  const gates = [...job.matchAll(/-\s*run:\s*npm run ([\w:-]+)/g)].map((match) => match[1]!);

  it('lists every gate the workflow runs, in workflow order', () => {
    expect(gates.length, `the ${jobName} job runs no npm script`).toBeGreaterThan(0);
    for (const [label, body] of GUIDES) {
      expect(flat(body), `${label}'s CI gate list drifted`).toContain(gates.join(' → '));
    }
  });

  it('counts those gates correctly in prose', () => {
    for (const [label, body] of MIRRORED) {
      expect(flat(body), `${label} miscounts the CI gates`).toContain(
        `All ${word(gates.length)} of those gates`,
      );
    }
  });

  it('states the Node version the workflow pins', () => {
    const version = required(job, /node-version: '([\d.]+)'/, "the CI job's node-version");
    for (const [label, body] of GUIDES) {
      expect(flat(body), `${label} names the wrong CI Node version`).toContain(
        `Node \`${version}\``,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The coverage gate description
// ---------------------------------------------------------------------------

describe('guide coverage description vs vitest.config.ts', () => {
  const coverage = VITEST_CONFIG.slice(
    VITEST_CONFIG.indexOf('coverage: {'),
    VITEST_CONFIG.indexOf('projects:'),
  );
  const globs = (key: string): string[] =>
    [
      ...required(coverage, new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`), `coverage.${key}`).matchAll(
        /'([^']+)'/g,
      ),
    ].map((match) => match[1]!);

  it('states the same threshold, included globs, and exclusion as the gate', () => {
    const threshold = required(coverage, /statements:\s*(\d+)/, 'the statements threshold');
    const included = globs('include');
    const excluded = globs('exclude');
    expect(included.length, 'coverage.include is empty').toBeGreaterThan(0);
    expect(excluded.length, 'coverage.exclude is empty').toBeGreaterThan(0);

    for (const [label, body] of MIRRORED) {
      const tests = flat(body.slice(body.indexOf('## Tests'), body.indexOf('## Docs are')));
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

/** Every `readonly` member declared directly on the `Io` interface. */
function ioMembers(): string[] {
  const open = IO_SOURCE.indexOf('{', IO_SOURCE.indexOf('export interface Io'));
  if (open < 0) throw new Error('src/io.ts declares no `export interface Io`');
  let depth = 0;
  let close = open;
  for (; close < IO_SOURCE.length; close++) {
    const char = IO_SOURCE[close];
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) break;
  }
  const body = IO_SOURCE.slice(open, close).replace(/\/\*[\s\S]*?\*\//g, '');
  return [...body.matchAll(/^\s*readonly\s+([A-Za-z_$][\w$]*)\??\s*:/gm)].map((match) => match[1]!);
}

describe('guide Io bullet vs src/io.ts', () => {
  const members = ioMembers();

  /** The `- **`src/io.ts`**` bullet of a guide, up to the next top-level bullet. */
  function ioBullet(markdown: string, label: string): string {
    const start = markdown.indexOf('- **`src/io.ts`**');
    if (start < 0) throw new Error(`${label} has no \`src/io.ts\` seam bullet`);
    const rest = markdown.slice(start + 1);
    const next = rest.indexOf('\n- **');
    return flat(next < 0 ? rest : rest.slice(0, next));
  }

  it('declares members at all (the parse still matches src/io.ts)', () => {
    expect(members).toContain('cwd');
    expect(members.length).toBeGreaterThan(5);
  });

  it('enumerates exactly the interface members, no more and no fewer', () => {
    for (const [label, body] of MIRRORED) {
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
    for (const [label, body] of MIRRORED) {
      expect(ioBullet(body, label), `${label} miscounts the Io fields`).toContain(
        `the ${word(members.length)} fields`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Remaining derived claims + the mirror invariant
// ---------------------------------------------------------------------------

describe('guide claims derived from the authoritative modules', () => {
  it('counts the Participant CLIs the registry declares', () => {
    for (const [label, body] of MIRRORED) {
      expect(flat(body), `${label} miscounts the Participant CLIs`).toContain(
        `the ${word(PARTICIPANT_TARGETS.length)} Participant CLIs`,
      );
    }
  });

  it('states the Node floor package.json enforces', () => {
    for (const [label, body] of GUIDES) {
      expect(flat(body), `${label} states the wrong Node floor`).toContain(
        `\`${pkg.engines.node}\``,
      );
    }
  });
});

describe('CLAUDE.md and AGENTS.md are one file with two names', () => {
  it('differ only in the H1 and the guidance sentence beneath it', () => {
    // The mirror is enforced by author discipline alone today: every change has
    // to land in both, and nothing fails when a future edit touches only one.
    const claude = CLAUDE_MD.split('\n');
    const agents = AGENTS_MD.split('\n');
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
