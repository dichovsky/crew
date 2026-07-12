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

describe('packaged Teams', () => {
  it('ships the dev team', () => {
    expect(Object.keys(PACKAGED_TEAMS)).toContain('dev');
  });
});
