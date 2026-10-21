import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { allowedRoots, isAllowedPath, parsePathList, resolveRepoPath, WorkspaceBoundaryError } from '../src/utils/factory-config.ts';

/** A world of real folders: a workspace, a repository inside it, and repositories elsewhere. */
let world: string;
let workspace: string;
let inside: string;
let outside: string;
let elsewhere: string;

const repository = (folder: string): string => {
  fs.mkdirSync(path.join(folder, '.git'), { recursive: true });
  return folder;
};

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-boundary-')));
  workspace = path.join(world, 'workspace');
  inside = repository(path.join(workspace, 'inside-app'));
  outside = repository(path.join(world, 'projects', 'outside-app'));
  elsewhere = repository(path.join(world, 'projects', 'elsewhere-app'));
  vi.stubEnv('FACTORY_WORKSPACE_ROOT', workspace);
  vi.stubEnv('FACTORY_EXTRA_REPOS', '');
  vi.stubEnv('FACTORY_ALLOW_ANY_PATH', '');
});
afterEach(() => fs.rmSync(world, { recursive: true, force: true }));

describe('a repository in the workspace', () => {
  it('is found by its name and by its path', () => {
    expect(resolveRepoPath('inside-app')).toBe(inside);
    expect(resolveRepoPath(inside)).toBe(inside);
  });
});

describe('a repository outside the workspace', () => {
  it('is refused, and the refusal says how to work on it', () => {
    const error = (() => {
      try {
        return resolveRepoPath(outside);
      } catch (caught) {
        return caught as Error;
      }
    })() as Error;

    expect(error).toBeInstanceOf(WorkspaceBoundaryError);
    expect(error.message).toContain(`Path "${outside}" is outside the places the factory may work in`);
    expect(error.message).toContain(`the workspace "${workspace}"`);
    expect(error.message).toContain('Open it in the Studio');
    expect(error.message).toContain(`FACTORY_EXTRA_REPOS=${outside}`);
    expect(error.message).toContain('FACTORY_ALLOW_ANY_PATH=true lifts the boundary altogether');
  });

  it('is allowed once the user opened it on purpose', () => {
    vi.stubEnv('FACTORY_EXTRA_REPOS', outside);

    expect(resolveRepoPath(outside)).toBe(outside);
  });

  it('is allowed with a subfolder of it, and with a git check on it - what the agents\' tools do', () => {
    vi.stubEnv('FACTORY_EXTRA_REPOS', outside);
    fs.mkdirSync(path.join(outside, 'ui', 'src'), { recursive: true });

    expect(resolveRepoPath(path.join(outside, 'ui', 'src'), { requireGit: false })).toBe(path.join(outside, 'ui', 'src'));
    expect(resolveRepoPath(outside, { requireGit: true })).toBe(outside);
  });

  it('does not open its neighbours - not another repository, and not one whose name merely starts the same way', () => {
    vi.stubEnv('FACTORY_EXTRA_REPOS', outside);
    const lookalike = repository(`${outside}-two`); // /projects/outside-app-two

    expect(() => resolveRepoPath(elsewhere)).toThrow(WorkspaceBoundaryError);
    expect(() => resolveRepoPath(lookalike)).toThrow(WorkspaceBoundaryError);
    expect(() => resolveRepoPath(path.join(outside, '..'), { requireGit: false })).toThrow(WorkspaceBoundaryError);
  });

  it('takes several, separated like PATH', () => {
    vi.stubEnv('FACTORY_EXTRA_REPOS', [outside, elsewhere].join(path.delimiter));

    expect(resolveRepoPath(outside)).toBe(outside);
    expect(resolveRepoPath(elsewhere)).toBe(elsewhere);
  });

  it('is not reached by a bare name: a name is looked for in the workspace, and only there', () => {
    vi.stubEnv('FACTORY_EXTRA_REPOS', outside);

    expect(() => resolveRepoPath('outside-app')).toThrow(`Target repository not found: ${path.join(workspace, 'outside-app')}`);
  });

  it('is allowed everywhere when the boundary is lifted', () => {
    vi.stubEnv('FACTORY_ALLOW_ANY_PATH', 'true');

    expect(resolveRepoPath(outside)).toBe(outside);
    expect(resolveRepoPath(elsewhere)).toBe(elsewhere);
  });
});

describe('parsePathList', () => {
  it('keeps absolute folders, in order, once each', () => {
    expect(parsePathList(['/a/one', '/b/two', '/a/one'].join(path.delimiter))).toEqual(['/a/one', '/b/two']);
  });

  it('expands ~, and cleans the path', () => {
    expect(parsePathList('~/projects/app')).toEqual([path.join(os.homedir(), 'projects', 'app')]);
    expect(parsePathList('/a/b/../c/')).toEqual(['/a/c']);
  });

  it('drops what has no clear meaning in a list read from the environment: blanks, and relative paths', () => {
    expect(parsePathList([' ', '', 'relative/path', './here', '/ok'].join(path.delimiter))).toEqual(['/ok']);
  });

  it('is empty for nothing', () => {
    expect(parsePathList(undefined)).toEqual([]);
    expect(parsePathList('')).toEqual([]);
  });
});

describe('allowedRoots and isAllowedPath', () => {
  it('are the workspace and each repository opened on purpose', () => {
    vi.stubEnv('FACTORY_EXTRA_REPOS', [outside, elsewhere].join(path.delimiter));

    expect(allowedRoots()).toEqual([workspace, outside, elsewhere]);
    for (const place of [workspace, inside, outside, path.join(elsewhere, 'src')]) {
      expect(isAllowedPath(place), place).toBe(true);
    }
    for (const place of [world, path.join(world, 'projects'), os.homedir(), '/', '/etc', `${outside}-two`]) {
      expect(isAllowedPath(place), place).toBe(false);
    }
  });
});
