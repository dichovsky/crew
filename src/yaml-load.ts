/**
 * Strict, safe YAML loader for tracked crew config (configuration.md, FR-F09).
 *
 * YAML is parsed with the 1.2 core schema and no custom tags, merge keys
 * disabled, and aliases disallowed (`maxAliasCount: 0`) to prevent entity
 * expansion. Documents are size-limited and must be a single mapping. Errors
 * report a sanitized reason plus line/column only — never the YAML library's
 * source excerpt, which can echo secrets or config bodies (FR-J12).
 */
import { isMap, isScalar, isSeq, parseDocument, type Node, type YAMLError } from 'yaml';
import { CrewError } from './errors.js';
import { MAX_CONFIG_BYTES } from './fs-safe.js';

export { MAX_CONFIG_BYTES };

// A tracked crew config is tiny in practice; bound the parsed YAML shape so a
// near-256 KiB document cannot turn duplicate-key checks into quadratic work.
const MAX_YAML_MAPPING_KEYS = 4096;
const MAX_YAML_TOTAL_NODES = 16384;
const MAX_YAML_ENTRY_CANDIDATES = 8192;

/** Render an error location without echoing the source excerpt. */
function at(err: YAMLError): string {
  const pos = err.linePos?.[0];
  return pos ? ` at line ${pos.line}, column ${pos.col}` : '';
}

function invalid(label: string, detail: string): never {
  throw new CrewError('INVALID_CONFIG', `${label} ${detail}`);
}

/**
 * Fast pre-parse guard for mapping-shaped input: count line-oriented `key:` /
 * `- key:` candidates in one pass so obviously pathological documents are
 * rejected before the YAML parser's own AST construction work begins.
 */
function assertYamlEntryBudget(src: string, label: string): void {
  let entries = 0;
  let lineStart = 0;

  for (let i = 0; i <= src.length; i++) {
    const code = i < src.length ? src.charCodeAt(i) : 0x0a;
    if (code !== 0x0a) continue;

    let j = lineStart;
    while (j < i && (src.charCodeAt(j) === 0x20 || src.charCodeAt(j) === 0x09)) j++;
    if (j < i && src.charCodeAt(j) === 0x2d) {
      j++;
      if (j < i && src.charCodeAt(j) === 0x20) j++;
    }
    while (j < i) {
      const c = src.charCodeAt(j);
      if (c === 0x23 /* # */) break;
      if (c === 0x3a /* : */) {
        entries++;
        if (entries > MAX_YAML_ENTRY_CANDIDATES) {
          invalid(label, `exceeds the YAML entry limit of ${MAX_YAML_MAPPING_KEYS}`);
        }
        break;
      }
      j++;
    }

    lineStart = i + 1;
  }
}

/** Match yaml's default scalar-key uniqueness while staying linear-time. */
function scalarKeyId(node: Node<unknown>): string | null {
  if (!isScalar(node)) return null;
  const value = node.value;
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return `string:${value}`;
    case 'number':
      return `number:${value}`;
    case 'boolean':
      return `boolean:${value}`;
    case 'bigint':
      return `bigint:${value}`;
    default:
      return null;
  }
}

/** Enforce AST-size and duplicate-key bounds independent of byte size. */
function assertYamlShape(root: Node<unknown> | null | undefined, label: string): void {
  if (root === null || root === undefined) return;

  let totalNodes = 0;
  const visit = (node: Node<unknown>): void => {
    totalNodes++;
    if (totalNodes > MAX_YAML_TOTAL_NODES) {
      invalid(label, `exceeds the YAML node limit of ${MAX_YAML_TOTAL_NODES}`);
    }

    if (isMap(node)) {
      if (node.items.length > MAX_YAML_MAPPING_KEYS) {
        invalid(label, `exceeds the YAML key limit of ${MAX_YAML_MAPPING_KEYS}`);
      }
      const seen = new Set<string>();
      for (const pair of node.items) {
        totalNodes++;
        if (totalNodes > MAX_YAML_TOTAL_NODES) {
          invalid(label, `exceeds the YAML node limit of ${MAX_YAML_TOTAL_NODES}`);
        }

        const keyId =
          pair.key && typeof pair.key === 'object' ? scalarKeyId(pair.key as Node) : null;
        if (keyId !== null) {
          if (seen.has(keyId)) {
            invalid(label, 'has a YAML error (DUPLICATE_KEY)');
          }
          seen.add(keyId);
        }

        if (pair.key && typeof pair.key === 'object') visit(pair.key as Node);
        if (pair.value && typeof pair.value === 'object') visit(pair.value as Node);
      }
      return;
    }

    if (isSeq(node)) {
      for (const item of node.items) {
        if (item && typeof item === 'object') visit(item as Node);
      }
    }
  };

  visit(root);
}

/**
 * Parse `src` into a plain mapping, rejecting unsafe or malformed YAML.
 * `label` names the document in error messages (e.g. `team "dev"`).
 */
export function loadYamlMapping(src: string, label: string): Record<string, unknown> {
  const bytes = Buffer.byteLength(src, 'utf8');
  if (bytes > MAX_CONFIG_BYTES) {
    throw new CrewError(
      'INVALID_CONFIG',
      `${label} exceeds the ${MAX_CONFIG_BYTES}-byte limit (${bytes} bytes)`,
    );
  }
  assertYamlEntryBudget(src, label);

  let doc;
  try {
    doc = parseDocument(src, {
      merge: false,
      schema: 'core',
      customTags: [],
      strict: true,
      uniqueKeys: false,
    });
  } catch {
    throw new CrewError('INVALID_CONFIG', `${label} contains invalid YAML syntax`);
  }

  const firstError = doc.errors[0];
  if (firstError) {
    throw new CrewError(
      'INVALID_CONFIG',
      `${label} has a YAML error (${firstError.code})${at(firstError)}`,
    );
  }
  const firstWarning = doc.warnings[0];
  if (firstWarning) {
    throw new CrewError(
      'INVALID_CONFIG',
      `${label} uses an unsupported YAML feature (${firstWarning.code})${at(firstWarning)}`,
    );
  }

  assertYamlShape(doc.contents, label);

  let value: unknown;
  try {
    // maxAliasCount: 0 rejects any alias node (anchor reuse / merge expansion).
    value = doc.toJS({ maxAliasCount: 0 });
  } catch {
    throw new CrewError('INVALID_CONFIG', `${label} uses unsupported YAML aliases`);
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CrewError('INVALID_CONFIG', `${label} must be a single YAML mapping`);
  }
  return value as Record<string, unknown>;
}
