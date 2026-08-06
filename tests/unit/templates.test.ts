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
  const flat = (body: string): string => body.replace(/\s+/g, ' ');

  it('no packaged Role claims crew already performs the context reset', () => {
    for (const [name, body] of Object.entries(PACKAGED_ROLES)) {
      expect(flat(body), `${name} promises an undelivered reset`).not.toMatch(
        /crew (?:then )?(?:resets|performs the context reset)/i,
      );
    }
  });

  it('the Manager and Worker prompts say the reset is not delivered yet', () => {
    expect(flat(PACKAGED_ROLES.manager!)).toMatch(/crew does not deliver [^.]*context reset yet/i);
    expect(flat(PACKAGED_ROLES.worker!)).toMatch(/crew does not deliver the reset yet/i);
  });
});

describe('packaged Teams', () => {
  it('ships the dev team', () => {
    expect(Object.keys(PACKAGED_TEAMS)).toContain('dev');
  });
});
