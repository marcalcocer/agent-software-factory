import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chooseBaseBranch, getCurrentBranch } from '../src/tools/git-tools.ts';

/** A repository somebody has just created: `git init`, and nothing else. */
let world: string;
let fresh: string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-new-repo-')));
  fresh = path.join(world, 'fresh');
  fs.mkdirSync(fresh);
  git(fresh, 'init', '-q', '-b', 'main');
  vi.stubEnv('FACTORY_WORKSPACE_ROOT', world);
  vi.stubEnv('FACTORY_LOG_DIR', path.join(world, 'logs'));
});
afterEach(() => fs.rmSync(world, { recursive: true, force: true }));

describe('a repository with no commits yet', () => {
  it('is said to have none - git\'s own "ambiguous argument \'HEAD\'" does not say that', async () => {
    const error = await getCurrentBranch(fresh).then(
      () => null,
      (thrown: Error) => thrown,
    );

    expect(error?.message).toContain(`The repository ${fresh} has no commits yet`);
    expect(error?.message).toContain('a task has nothing to start from');
    expect(error?.message).toContain('git commit --allow-empty -m "chore: initial commit"');
    expect(error?.message).not.toContain('ambiguous argument');
  });

  it('is said so when a task looks for the branch to start from, too', async () => {
    await expect(chooseBaseBranch(fresh)).rejects.toThrow('has no commits yet');
  });

  it('is a repository like any other from its first commit - empty is enough', async () => {
    git(fresh, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'chore: initial commit');

    expect(await getCurrentBranch(fresh)).toBe('main');
    expect(await chooseBaseBranch(fresh)).toEqual({ base: 'main' });
  });

  it('is not blamed for what is another problem: a folder that is not a repository at all', async () => {
    const plain = path.join(world, 'plain');
    fs.mkdirSync(plain);

    const error = await getCurrentBranch(plain).then(
      () => null,
      (thrown: Error) => thrown,
    );

    expect(error?.message).toContain('failed (exit');
    expect(error?.message).not.toContain('has no commits yet');
  });
});
