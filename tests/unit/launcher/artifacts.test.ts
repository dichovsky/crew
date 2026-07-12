/**
 * Generated-artifact writes. Proves the files land under
 * `.crew/generated/<session>/`, launch-plan.json is byte-identical to the stable
 * fixture, the Manager-prompt path is returned for the brief load, and the
 * Inspector prompt is omitted when the roster has none.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initWorkspace } from '../../../src/init.js';
import { type PaneMap, writePaneMap, writePlanArtifacts } from '../../../src/launcher/artifacts.js';
import type { LaunchPlan } from '../../../src/launcher/plan.js';
import { captureIo } from '../../helpers/io.js';

const made: string[] = [];
const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/launch-plan.dev.json'),
  'utf8',
);
const PLAN = JSON.parse(FIXTURE) as LaunchPlan;

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-artifacts-'));
  made.push(dir);
  initWorkspace(captureIo({ cwd: dir }).io, { withGuides: false, json: false });
  return dir;
}

afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

describe('writePlanArtifacts', () => {
  it('writes launch-plan.json byte-identical to the fixture, plus prompts and run-summary', () => {
    const root = workspace();
    const result = writePlanArtifacts(root, 'crew-demo', {
      launchPlan: PLAN,
      managerPrompt: '# manager prompt\n',
      inspectorPrompt: '# inspector prompt\n',
      runSummary: '# run summary\n',
    });
    const dir = join(root, '.crew', 'generated', 'crew-demo');
    expect(result.dir).toBe(dir);
    expect(result.managerPromptPath).toBe(join(dir, 'manager-prompt.md'));
    expect(readFileSync(join(dir, 'launch-plan.json'), 'utf8')).toBe(FIXTURE);
    expect(readFileSync(join(dir, 'manager-prompt.md'), 'utf8')).toBe('# manager prompt\n');
    expect(readFileSync(join(dir, 'inspector-prompt.md'), 'utf8')).toBe('# inspector prompt\n');
    expect(readFileSync(join(dir, 'run-summary.md'), 'utf8')).toBe('# run summary\n');
  });

  it('omits inspector-prompt.md when the roster has no Inspector', () => {
    const root = workspace();
    writePlanArtifacts(root, 'crew-demo', {
      launchPlan: PLAN,
      managerPrompt: '# m\n',
      inspectorPrompt: null,
      runSummary: '# s\n',
    });
    const dir = join(root, '.crew', 'generated', 'crew-demo');
    expect(existsSync(join(dir, 'inspector-prompt.md'))).toBe(false);
    expect(existsSync(join(dir, 'manager-prompt.md'))).toBe(true);
  });

  it('refuses a session name that escapes the generated directory (defense-in-depth)', () => {
    const root = workspace();
    expect(() =>
      writePlanArtifacts(root, '../../../../../../escape', {
        launchPlan: PLAN,
        managerPrompt: '# m\n',
        inspectorPrompt: null,
        runSummary: '# s\n',
      }),
    ).toThrow(/escapes the workspace/);
  });
});

describe('writePaneMap', () => {
  it('writes pane-map.json as stable 2-space JSON with a trailing newline', () => {
    const root = workspace();
    const paneMap: PaneMap = {
      schema_version: 1,
      session_name: 'crew-demo',
      ownership_token: '123e4567-e89b-42d3-a456-426614174000',
      relay_window: { present: true, name: 'crew-relay', pane_id: '%9' },
      panes: [
        {
          pane_id: '%1',
          window: 'crew',
          agent_id: 'manager',
          role: 'manager',
          executable: 'codex',
          invocation: '$crew manager manager',
          readiness_names: ['codex'],
        },
      ],
    };
    const path = writePaneMap(root, 'crew-demo', paneMap);
    expect(path).toBe(join(root, '.crew', 'generated', 'crew-demo', 'pane-map.json'));
    const written = readFileSync(path, 'utf8');
    expect(written).toBe(`${JSON.stringify(paneMap, null, 2)}\n`);
    expect(JSON.parse(written)).toEqual(paneMap);
  });
});
