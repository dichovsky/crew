import { describe, expect, it } from 'vitest';
import { CrewError } from '../../src/errors.js';
import { parseDuration } from '../../src/duration.js';
import { expandRoster, parseTeam } from '../../src/teams.js';

/** Run `fn`, returning the thrown CrewError code (fails if it does not throw). */
function thrownCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as CrewError).code;
  }
  throw new Error('expected a throw');
}

describe('parseDuration overflow guard', () => {
  it('rejects a duration whose seconds leave the safe-integer range', () => {
    // count is itself a safe integer, but count * 604800 (w) overflows 2^53.
    expect(thrownCode(() => parseDuration('9999999999999w'))).toBe('USAGE');
  });
});

describe('parseTeam validation branches', () => {
  const label = 'team "alpha"';

  it('rejects a member that is not a mapping', () => {
    const src = 'version: 1\nname: alpha\nmembers:\n  - 5\n';
    expect(thrownCode(() => parseTeam(src, 'alpha', label))).toBe('INVALID_CONFIG');
  });

  it('rejects a member whose role fails the Role-name grammar', () => {
    const src = 'version: 1\nname: alpha\nmembers:\n  - id: worker\n    role: BadRole\n';
    expect(thrownCode(() => parseTeam(src, 'alpha', label))).toBe('INVALID_CONFIG');
  });

  it('rejects a document name that does not match the filename stem', () => {
    const src = 'version: 1\nname: beta\nmembers:\n  - id: worker\n    role: worker\n';
    expect(thrownCode(() => parseTeam(src, 'alpha', label))).toBe('INVALID_CONFIG');
  });

  it('rejects an empty members sequence', () => {
    const src = 'version: 1\nname: alpha\nmembers: []\n';
    expect(thrownCode(() => parseTeam(src, 'alpha', label))).toBe('INVALID_CONFIG');
  });

  it('rejects an unknown top-level key', () => {
    const src = 'version: 1\nname: alpha\nbogus: x\nmembers:\n  - id: worker\n    role: worker\n';
    expect(thrownCode(() => parseTeam(src, 'alpha', label))).toBe('INVALID_CONFIG');
  });

  it('rejects a version other than 1', () => {
    const src = 'version: 2\nname: alpha\nmembers:\n  - id: worker\n    role: worker\n';
    expect(thrownCode(() => parseTeam(src, 'alpha', label))).toBe('INVALID_CONFIG');
  });

  it('rejects a document name that fails the Team-name grammar', () => {
    const src = 'version: 1\nname: BadName\nmembers:\n  - id: worker\n    role: worker\n';
    expect(thrownCode(() => parseTeam(src, 'badname', label))).toBe('INVALID_CONFIG');
  });

  it('rejects a member id that fails the Agent-id grammar', () => {
    const src = 'version: 1\nname: alpha\nmembers:\n  - id: "@bad"\n    role: worker\n';
    expect(thrownCode(() => parseTeam(src, 'alpha', label))).toBe('INVALID_CONFIG');
  });

  it('rejects a replicas count below the allowed range', () => {
    const src =
      'version: 1\nname: alpha\nmembers:\n  - id: worker\n    role: worker\n    replicas: 0\n';
    expect(thrownCode(() => parseTeam(src, 'alpha', label))).toBe('INVALID_CONFIG');
  });

  it('rejects a replicas count above the allowed range', () => {
    const src =
      'version: 1\nname: alpha\nmembers:\n  - id: worker\n    role: worker\n    replicas: 33\n';
    expect(thrownCode(() => parseTeam(src, 'alpha', label))).toBe('INVALID_CONFIG');
  });

  it('rejects an unknown Participant platform hint', () => {
    const src =
      'version: 1\nname: alpha\nmembers:\n  - id: worker\n    role: worker\n    platform: nope\n';
    expect(thrownCode(() => parseTeam(src, 'alpha', label))).toBe('INVALID_CONFIG');
  });
});

describe('expandRoster collision and grammar guards', () => {
  it('rejects a replica expansion that collides on an explicit id', () => {
    // A base member `worker` and an explicit `worker-2` collide once the first
    // member's replicas expand to `worker`, `worker-2`.
    const team = parseTeam(
      'version: 1\nname: alpha\nmembers:\n  - id: worker\n    role: worker\n    replicas: 2\n  - id: worker-2\n    role: worker\n',
      'alpha',
      'team "alpha"',
    );
    expect(thrownCode(() => expandRoster(team, 'team "alpha"'))).toBe('INVALID_CONFIG');
  });
});
