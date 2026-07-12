/* eslint-disable */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Pair, Scalar, YAMLMap, YAMLSeq } from 'yaml';

let mockYamlThrow = false;
let mockYamlDoc: unknown = null;
let parseCalls = 0;
let lastOptions: unknown = null;

vi.mock('yaml', async (importOriginal) => {
  const actual = await importOriginal<typeof import('yaml')>();
  return {
    ...actual,
    parseDocument: (src: any, options: any) => {
      parseCalls++;
      lastOptions = options;
      if (mockYamlThrow) {
        throw new Error('injected syntax throw');
      }
      if (mockYamlDoc !== null) {
        return mockYamlDoc;
      }
      return actual.parseDocument(src, options);
    },
  };
});

import { loadYamlMapping, MAX_CONFIG_BYTES } from '../../src/yaml-load.js';
import { CrewError } from '../../src/errors.js';

function expectInvalid(src: string): void {
  try {
    loadYamlMapping(src, 'doc');
    expect.unreachable('should have thrown INVALID_CONFIG');
  } catch (err) {
    expect(err).toBeInstanceOf(CrewError);
    expect((err as CrewError).code).toBe('INVALID_CONFIG');
  }
}

function oversizedSingleMapping(maxBytes: number): { src: string; keys: number } {
  const parts: string[] = [];
  let bytes = 0;
  let keys = 0;
  for (;;) {
    const line = `${keys.toString(36)}:\n`;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (bytes + lineBytes > maxBytes) break;
    parts.push(line);
    bytes += lineBytes;
    keys++;
  }
  return { src: parts.join(''), keys };
}

function sequenceOnlyDocument(items: number): string {
  return `list:\n${Array.from({ length: items }, (_, i) => `  - ${i}\n`).join('')}`;
}

function mediumSingleMapping(keys: number): string {
  return Array.from({ length: keys }, (_, i) => `${i.toString(36)}:\n`).join('');
}

beforeEach(() => {
  mockYamlThrow = false;
  mockYamlDoc = null;
  parseCalls = 0;
  lastOptions = null;
});

describe('loadYamlMapping', () => {
  it('parses a simple mapping', () => {
    expect(loadYamlMapping('a: 1\nb: two\n', 'doc')).toEqual({ a: 1, b: 'two' });
    expect(lastOptions).toMatchObject({ uniqueKeys: false });
  });

  it('rejects a document larger than the limit', () => {
    expectInvalid(`big: ${'x'.repeat(MAX_CONFIG_BYTES)}\n`);
  });

  it('rejects a non-mapping document', () => {
    expectInvalid('- 1\n- 2\n');
    expectInvalid('just a scalar\n');
  });

  it('rejects duplicate keys', () => {
    expectInvalid('a: 1\na: 2\n');
  });

  it('rejects duplicate numeric, boolean, and null keys', () => {
    expectInvalid('1: a\n1: b\n');
    expectInvalid('true: a\ntrue: b\n');
    expectInvalid('null: a\n~: b\n');
  });

  it('rejects an oversized key-count document in under 1 second', () => {
    const { src, keys } = oversizedSingleMapping(MAX_CONFIG_BYTES - 1);
    expect(Buffer.byteLength(src, 'utf8')).toBeLessThan(MAX_CONFIG_BYTES);
    expect(keys).toBeGreaterThan(40_000);

    const start = performance.now();
    expectInvalid(src);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(parseCalls).toBe(0);
  });

  it('rejects a parsed mapping that exceeds the AST key limit', () => {
    expectInvalid(mediumSingleMapping(5000));
    expect(parseCalls).toBe(1);
  });

  it('rejects a parsed sequence-heavy document that exceeds the AST node limit', () => {
    expectInvalid(sequenceOnlyDocument(17000));
    expect(parseCalls).toBe(1);
  });

  it('rejects anchors and aliases', () => {
    expectInvalid('a: &x 1\nb: *x\n');
  });

  it('rejects merge keys', () => {
    expectInvalid('base: &b\n  x: 1\nt:\n  <<: *b\n');
  });

  it('rejects custom/unknown tags', () => {
    expectInvalid('x: !custom value\n');
    expectInvalid('x: !!js/function "return 1"\n');
  });

  it('does not echo source content (e.g. secrets) in error messages (FR-J12)', () => {
    const secret = 'sk-supersecret-abc123';
    try {
      loadYamlMapping(`token: ${secret}\ntoken: dup\n`, 'config');
      expect.unreachable('should throw INVALID_CONFIG');
    } catch (err) {
      expect(err).toBeInstanceOf(CrewError);
      expect((err as CrewError).code).toBe('INVALID_CONFIG');
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it('rejects completely invalid syntax that causes parseDocument to throw', () => {
    mockYamlThrow = true;
    try {
      expectInvalid('a: 1\n');
    } finally {
      mockYamlThrow = false;
    }
  });

  it('surfaces parser-reported YAML errors with their location', () => {
    mockYamlDoc = {
      errors: [{ code: 'BAD_INDENT', linePos: [{ line: 3, col: 2 }] }],
      warnings: [],
      contents: null,
      toJS: () => {
        throw new Error('unreachable');
      },
    };
    try {
      loadYamlMapping('a: 1\n', 'doc');
      expect.unreachable('should throw INVALID_CONFIG');
    } catch (err) {
      expect(err).toBeInstanceOf(CrewError);
      expect((err as CrewError).code).toBe('INVALID_CONFIG');
      expect((err as Error).message).toContain('BAD_INDENT');
      expect((err as Error).message).toContain('line 3, column 2');
    }
  });

  it('surfaces parser-reported YAML warnings with their location', () => {
    mockYamlDoc = {
      errors: [],
      warnings: [{ code: 'TAG_RESOLVE_FAILED', linePos: [{ line: 2, col: 7 }] }],
      contents: null,
      toJS: () => {
        throw new Error('unreachable');
      },
    };
    try {
      loadYamlMapping('a: 1\n', 'doc');
      expect.unreachable('should throw INVALID_CONFIG');
    } catch (err) {
      expect(err).toBeInstanceOf(CrewError);
      expect((err as CrewError).code).toBe('INVALID_CONFIG');
      expect((err as Error).message).toContain('TAG_RESOLVE_FAILED');
      expect((err as Error).message).toContain('line 2, column 7');
    }
  });

  it('rejects duplicate bigint keys in the linear duplicate detector', () => {
    const root = new YAMLMap();
    root.items = [
      new Pair(new Scalar(1n), new Scalar('a')),
      new Pair(new Scalar(1n), new Scalar('b')),
    ];
    mockYamlDoc = { errors: [], warnings: [], contents: root, toJS: () => ({}) };
    expectInvalid('a: 1\n');
  });

  it('allows non-standard scalar key values to bypass the scalar duplicate key set', () => {
    const root = new YAMLMap();
    root.items = [new Pair(new Scalar(Symbol('token') as never), new Scalar('ok'))];
    mockYamlDoc = { errors: [], warnings: [], contents: root, toJS: () => ({ ok: 1 }) };
    expect(loadYamlMapping('a: 1\n', 'doc')).toEqual({ ok: 1 });
  });

  it('ignores non-node synthetic pair keys and values in the shape walker', () => {
    const root = new YAMLMap();
    root.items = [new Pair('plain-key' as never, 123 as never)];
    mockYamlDoc = { errors: [], warnings: [], contents: root, toJS: () => ({ ok: 1 }) };
    expect(loadYamlMapping('a: 1\n', 'doc')).toEqual({ ok: 1 });
  });

  it('rejects a nested map when the total-node limit is exceeded inside its pair loop', () => {
    const seq = new YAMLSeq();
    for (let i = 0; i < 16379; i++) seq.items.push(new Scalar(i));
    const nested = new YAMLMap();
    nested.items = [new Pair(new Scalar('deep'), new Scalar('value'))];
    seq.items.push(nested);

    const root = new YAMLMap();
    root.items = [new Pair(new Scalar('root'), seq)];
    mockYamlDoc = { errors: [], warnings: [], contents: root, toJS: () => ({}) };
    expectInvalid('root:\n  - 1\n');
  });

  it('ignores non-node synthetic sequence items in the shape walker', () => {
    const seq = new YAMLSeq();
    seq.items = [null as never, 'plain' as never];
    const root = new YAMLMap();
    root.items = [new Pair(new Scalar('root'), seq)];
    mockYamlDoc = { errors: [], warnings: [], contents: root, toJS: () => ({ root: [] }) };
    expect(loadYamlMapping('root:\n []\n', 'doc')).toEqual({ root: [] });
  });

  it('handles sequence item mappings and null values', () => {
    expect(
      loadYamlMapping(
        '# comment\nroot:\n  - id: 1\n  - flag:\n      nested: true\nempty:\n',
        'doc',
      ),
    ).toEqual({
      root: [{ id: 1 }, { flag: { nested: true } }],
      empty: null,
    });
  });
});
