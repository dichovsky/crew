import { describe, it, expect } from 'vitest';
import { PACKAGED_ROLES, PACKAGED_TEAMS } from '../../src/templates.js';

describe('packaged Roles — FR-F06 prompt safety', () => {
  it('every built-in Role treats messages, briefs, config text, and tool output as untrusted', () => {
    for (const [name, body] of Object.entries(PACKAGED_ROLES)) {
      expect(body, `${name} mentions untrusted`).toMatch(/untrusted/i);
      expect(body, `${name} mentions briefs`).toMatch(/brief/i);
      expect(body, `${name} mentions tool output`).toMatch(/tool output/i);
    }
  });
});

describe('packaged Roles — ADR-0014 context-clear Sign-off', () => {
  it('Manager and Worker prompts describe the Sign-off convention', () => {
    expect(PACKAGED_ROLES.manager).toMatch(/sign-off/i);
    expect(PACKAGED_ROLES.worker).toMatch(/sign-off/i);
  });
});

/**
 * ADR-0016 decided that crew's Relay — not the Worker — delivers the context
 * reset, but its Consequences put "the Relay delivery, the registry field, and
 * their requirements" in a follow-up change that has not landed: no reset
 * delivery exists in `src/relay.ts` or `src/launcher/`, and no platform record
 * carries a per-engine reset command. A shipped prompt must not tell an Agent
 * to wait for a reset that never arrives.
 */
describe('packaged Roles — ADR-0016 relay-delivered reset is still a follow-up', () => {
  /** Sentences of a prompt, whitespace-flattened. */
  const sentences = (body: string): string[] =>
    body
      .replace(/\s+/g, ' ')
      .split(/(?<=\.)\s+/)
      .filter((s) => s.length > 0);

  /**
   * A claim that some actor performs the reset — matched by MEANING (any of
   * reset/clear/deliver applied to a context or session) rather than by the two
   * phrasings this change happens to remove, so a reworded regression such as
   * "the Relay clears your context after the Sign-off" is caught too.
   */
  const RESET_CLAIM = /\b(?:reset|clear\w*|deliver\w*)\b[^.]*\b(?:context|session)\b|\breset\b/i;
  const NEGATED = /\b(?:not|never|cannot|can't|no)\b/i;

  it('every sentence about a context reset is negated, in every packaged Role', () => {
    for (const [name, body] of Object.entries(PACKAGED_ROLES)) {
      const claims = sentences(body).filter((s) => RESET_CLAIM.test(s));
      for (const claim of claims) {
        expect(claim, `${name} states an unnegated reset claim`).toMatch(NEGATED);
      }
    }
  });

  it('the Manager and Worker prompts state that crew does not deliver it', () => {
    for (const name of ['manager', 'worker']) {
      const stated = sentences(PACKAGED_ROLES[name]!).some(
        (s) => /\bcrew\b/i.test(s) && /\bdeliver\w*\b/i.test(s) && NEGATED.test(s),
      );
      expect(stated, `${name} never says crew does not deliver the reset`).toBe(true);
    }
  });
});

describe('packaged Teams', () => {
  it('ships the dev team', () => {
    expect(Object.keys(PACKAGED_TEAMS)).toContain('dev');
  });
});
