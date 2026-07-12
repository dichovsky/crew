import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findWorkspaceRoot,
  resolveWorkspaceRoot,
  WORKSPACE_DIRNAME,
  WORKSPACE_POINTER_BASENAME,
  workspacePaths,
} from '../../src/workspace.js';
import { CrewError } from '../../src/errors.js';

const made: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crew-ws-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  while (made.length) {
    rmSync(made.pop()!, { recursive: true, force: true });
  }
});

describe('findWorkspaceRoot', () => {
  it('returns the directory that directly contains .crew/', () => {
    const root = tmp();
    mkdirSync(join(root, WORKSPACE_DIRNAME));
    expect(findWorkspaceRoot(root)).toBe(root);
  });

  it('finds the nearest ancestor when started from a nested directory', () => {
    const root = tmp();
    mkdirSync(join(root, WORKSPACE_DIRNAME));
    const nested = join(root, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    expect(findWorkspaceRoot(nested)).toBe(root);
  });

  it('selects the deepest .crew/ when nested workspaces exist', () => {
    const outer = tmp();
    mkdirSync(join(outer, WORKSPACE_DIRNAME));
    const inner = join(outer, 'pkg');
    mkdirSync(join(inner, WORKSPACE_DIRNAME), { recursive: true });
    expect(findWorkspaceRoot(inner)).toBe(inner);
  });

  it('ignores a .crew that is a file, not a directory', () => {
    const root = tmp();
    // a regular file named .crew must not count as a workspace
    writeFileSync(join(root, WORKSPACE_DIRNAME), '');
    expect(findWorkspaceRoot(root)).toBeNull();
  });

  it('returns null when no .crew/ exists up to the filesystem root', () => {
    expect(findWorkspaceRoot(tmp())).toBeNull();
  });

  it('does not accept a symlinked .crew as a workspace marker', () => {
    const root = tmp();
    const outside = tmp();
    // a checked-in `.crew -> /outside` must not be treated as a Workspace
    symlinkSync(outside, join(root, WORKSPACE_DIRNAME));
    expect(findWorkspaceRoot(root)).toBeNull();
  });
});

describe('findWorkspaceRoot workspace-pointer redirect', () => {
  function writePointer(root: string, content: string): void {
    mkdirSync(workspacePaths(root).state, { recursive: true });
    writeFileSync(workspacePaths(root).pointerFile, content);
  }

  it('uses the local root unchanged when no pointer file exists', () => {
    const root = tmp();
    mkdirSync(join(root, WORKSPACE_DIRNAME));
    expect(findWorkspaceRoot(root)).toBe(root);
  });

  it('follows a valid pointer to the real, shared workspace root', () => {
    const local = tmp();
    const real = tmp();
    mkdirSync(join(local, WORKSPACE_DIRNAME));
    mkdirSync(join(real, WORKSPACE_DIRNAME));
    writePointer(local, real);
    expect(findWorkspaceRoot(local)).toBe(real);
  });

  it('treats a pointer to a path with no .crew/ as a discovery failure, not a fall-back to the local root', () => {
    const local = tmp();
    const notAWorkspace = tmp();
    mkdirSync(join(local, WORKSPACE_DIRNAME));
    writePointer(local, notAWorkspace);
    expect(findWorkspaceRoot(local)).toBeNull();
    expect(() => resolveWorkspaceRoot(local)).toThrow(CrewError);
    try {
      resolveWorkspaceRoot(local);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as CrewError).code).toBe('NOT_WORKSPACE');
    }
  });

  it('treats an unreadable pointer file as a discovery failure, not a fall-back to the local root', () => {
    const local = tmp();
    mkdirSync(join(local, WORKSPACE_DIRNAME));
    mkdirSync(workspacePaths(local).pointerFile, { recursive: true });
    expect(findWorkspaceRoot(local)).toBeNull();
    expect(() => resolveWorkspaceRoot(local)).toThrow(CrewError);
  });

  it('trims trailing whitespace/newline from the pointer file content', () => {
    const local = tmp();
    const real = tmp();
    mkdirSync(join(local, WORKSPACE_DIRNAME));
    mkdirSync(join(real, WORKSPACE_DIRNAME));
    writePointer(local, `${real}\n  \n`);
    expect(findWorkspaceRoot(local)).toBe(real);
  });

  it('treats an empty pointer file as absent and uses the local root', () => {
    const local = tmp();
    mkdirSync(join(local, WORKSPACE_DIRNAME));
    writePointer(local, '');
    expect(findWorkspaceRoot(local)).toBe(local);
  });

  it('treats a whitespace-only pointer file as absent and uses the local root', () => {
    const local = tmp();
    mkdirSync(join(local, WORKSPACE_DIRNAME));
    writePointer(local, '   \n');
    expect(findWorkspaceRoot(local)).toBe(local);
  });

  it('exposes the pointer file path under .crew/state/', () => {
    const p = workspacePaths('/repo');
    expect(p.pointerFile).toBe(
      join('/repo', WORKSPACE_DIRNAME, 'state', WORKSPACE_POINTER_BASENAME),
    );
  });
});

describe('resolveWorkspaceRoot', () => {
  it('throws NOT_WORKSPACE when there is no workspace', () => {
    try {
      resolveWorkspaceRoot(tmp());
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CrewError);
      expect((err as CrewError).code).toBe('NOT_WORKSPACE');
    }
  });

  it('returns the root when a workspace exists', () => {
    const root = tmp();
    mkdirSync(join(root, WORKSPACE_DIRNAME));
    expect(resolveWorkspaceRoot(root)).toBe(root);
  });
});

describe('workspacePaths', () => {
  it('derives the managed subtree under the root', () => {
    const p = workspacePaths('/repo');
    expect(p).toEqual({
      root: '/repo',
      crew: '/repo/.crew',
      roles: '/repo/.crew/roles',
      teams: '/repo/.crew/teams',
      state: '/repo/.crew/state',
      db: '/repo/.crew/state/crew.db',
      generated: '/repo/.crew/generated',
      gitignore: '/repo/.crew/.gitignore',
      pointerFile: '/repo/.crew/state/workspace-pointer',
    });
  });
});
