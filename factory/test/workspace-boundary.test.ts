import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  allowedRoots,
  getFactoryConfig,
  isAllowedPath,
  isVolatileLocation,
  parsePathList,
  PROJECT_ROOT,
  resolveRepoPath,
  WorkspaceBoundaryError,
} from '../src/utils/factory-config.ts';
import { worktreePathFor, worktreesRoot } from '../src/tools/worktree.ts';

/** A world of real folders: a workspace, a repository inside it, and repositories elsewhere. */
let world: string;
let workspace: string;
let inside: string;
let outside: string;
let elsewhere: string;
let checkouts: string;

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
  checkouts = path.join(world, 'keep', 'checkouts');
  vi.stubEnv('FACTORY_WORKSPACE_ROOT', workspace);
  vi.stubEnv('FACTORY_EXTRA_REPOS', '');
  vi.stubEnv('FACTORY_WORKTREES_DIR', '');
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

describe('where the checkouts are kept', () => {
  it('is, by default, a hidden folder of the workspace', () => {
    expect(getFactoryConfig().worktreesDir).toBe(path.join(workspace, '.factory', 'worktrees'));
    expect(worktreesRoot()).toBe(path.join(workspace, '.factory', 'worktrees'));
    expect(worktreePathFor(inside, 'f0042')).toBe(path.join(workspace, '.factory', 'worktrees', 'inside-app', 'f0042'));
  });

  it('follows the workspace when that moves', () => {
    const elsewhereWorkspace = path.join(world, 'other-workspace');
    vi.stubEnv('FACTORY_WORKSPACE_ROOT', elsewhereWorkspace);

    expect(worktreesRoot()).toBe(path.join(elsewhereWorkspace, '.factory', 'worktrees'));
  });

  it('is wherever the user says - one folder for every repository, wherever each of them is', () => {
    vi.stubEnv('FACTORY_WORKTREES_DIR', checkouts);
    vi.stubEnv('FACTORY_EXTRA_REPOS', outside);

    expect(worktreesRoot()).toBe(checkouts);
    expect(worktreePathFor(outside, 'f0007')).toBe(path.join(checkouts, 'outside-app', 'f0007'));
    expect(worktreePathFor(inside, 'f0008')).toBe(path.join(checkouts, 'inside-app', 'f0008'));
  });

  it('is part of the boundary, so the agents can work in a checkout kept outside the workspace', () => {
    vi.stubEnv('FACTORY_WORKTREES_DIR', checkouts);
    const checkout = path.join(checkouts, 'outside-app', 'f0007');
    repository(checkout);

    expect(resolveRepoPath(checkout, { requireGit: true })).toBe(checkout);
    expect(() => resolveRepoPath(repository(path.join(world, 'keep', 'not-checkouts')))).toThrow(WorkspaceBoundaryError);
  });

  it('resolves a relative setting against the factory, like the log folder', () => {
    vi.stubEnv('FACTORY_WORKTREES_DIR', 'worktrees');

    expect(worktreesRoot()).toBe(path.join(PROJECT_ROOT, 'worktrees'));
  });

  it('expands ~', () => {
    vi.stubEnv('FACTORY_WORKTREES_DIR', '~/.factory-checkouts');

    expect(worktreesRoot()).toBe(path.join(os.homedir(), '.factory-checkouts'));
  });
});

describe('allowedRoots and isAllowedPath', () => {
  it('are the workspace, the checkouts and each repository opened on purpose', () => {
    vi.stubEnv('FACTORY_WORKTREES_DIR', checkouts);
    vi.stubEnv('FACTORY_EXTRA_REPOS', [outside, elsewhere].join(path.delimiter));

    expect(allowedRoots()).toEqual([workspace, checkouts, outside, elsewhere]);
    for (const place of [workspace, inside, checkouts, path.join(checkouts, 'x', 'y'), outside, path.join(elsewhere, 'src')]) {
      expect(isAllowedPath(place), place).toBe(true);
    }
    for (const place of [world, path.join(world, 'projects'), os.homedir(), '/', '/etc', `${outside}-two`]) {
      expect(isAllowedPath(place), place).toBe(false);
    }
  });
});

describe('isVolatileLocation', () => {
  it('knows a place a restart can clear', () => {
    expect(isVolatileLocation('/tmp/factory-demo/workspace')).toBe(true);
    expect(isVolatileLocation(path.join(os.tmpdir(), 'x'))).toBe(true);
    expect(isVolatileLocation('/tmp')).toBe(true);
  });

  it('knows a place that stays - and is not fooled by a name that merely starts like a temporary folder', () => {
    expect(isVolatileLocation(path.join(os.homedir(), 'workspace', '.factory'))).toBe(false);
    expect(isVolatileLocation('/tmpfiles/x')).toBe(false);
    expect(isVolatileLocation('/var/data/checkouts')).toBe(false);
  });

  it('can be told what the temporary folders are', () => {
    expect(isVolatileLocation('/scratch/x', ['/scratch'])).toBe(true);
    expect(isVolatileLocation('/tmp/x', ['/scratch'])).toBe(false);
  });
});
