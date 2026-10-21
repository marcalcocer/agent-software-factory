import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkRepositoryFolder, openRepositoryFolder } from '../electron/services/repository-folder';
import type { Settings } from '../shared/types';

let world: string;
beforeEach(() => {
  world = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-folder-')));
});
afterEach(() => fs.rmSync(world, { recursive: true, force: true }));

const folder = (...parts: string[]): string => {
  const made = path.join(world, ...parts);
  fs.mkdirSync(made, { recursive: true });
  return made;
};
const repository = (...parts: string[]): string => {
  const made = folder(...parts);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: made });
  return made;
};

describe('checkRepositoryFolder', () => {
  it('takes a git repository - wherever it is, and with no commit yet: a new one is a repository', () => {
    expect(checkRepositoryFolder(repository('projects', 'invest-track'))).toEqual({ ok: true });
  });

  it('takes a linked checkout and a submodule, whose .git is a file', () => {
    const linked = folder('linked');
    fs.writeFileSync(path.join(linked, '.git'), 'gitdir: /somewhere/else/.git/worktrees/linked\n');

    expect(checkRepositoryFolder(linked)).toEqual({ ok: true });
  });

  it('takes a repository inside another one - it is a repository of its own', () => {
    repository('outer');

    expect(checkRepositoryFolder(repository('outer', 'vendor', 'inner'))).toEqual({ ok: true });
  });

  it('refuses a folder that is not a repository, and says what to do', () => {
    const plain = folder('notes');

    const check = checkRepositoryFolder(plain);

    expect(check).toEqual({ ok: false, message: expect.any(String) });
    expect((check as { message: string }).message).toContain(`${plain} is not a git repository (it has no .git folder)`);
    expect((check as { message: string }).message).toContain('git init');
  });

  it('refuses a folder inside a repository, and names the folder to open instead', () => {
    const top = repository('projects', 'invest-track');
    const inside = folder('projects', 'invest-track', 'ui', 'src');

    const check = checkRepositoryFolder(inside);

    expect((check as { message: string }).message).toBe(
      `${inside} is inside the git repository ${top}. Open ${top} instead: the factory works on a whole repository.`,
    );
  });

  it('names the nearest repository when there are several above', () => {
    repository('outer');
    const inner = repository('outer', 'vendor', 'inner');

    expect((checkRepositoryFolder(folder('outer', 'vendor', 'inner', 'lib')) as { message: string }).message).toContain(`inside the git repository ${inner}.`);
  });

  it('refuses what is not a folder, or is not there', () => {
    const file = path.join(world, 'a-file.txt');
    fs.writeFileSync(file, 'x');

    expect(checkRepositoryFolder(file)).toMatchObject({ ok: false, message: `${file} is not a folder, so it cannot be a repository.` });
    expect(checkRepositoryFolder(path.join(world, 'gone'))).toMatchObject({ ok: false });
  });
});

describe('openRepositoryFolder', () => {
  const settings = (saved?: Array<{ name: string; path: string }>): Settings => ({
    global: { theme: 'light', workspaceRoot: '/w', defaultMaxAttempts: 3, dryRunByDefault: false, logLevel: 'info', activeProvider: 'claude-cli', ...(saved ? { savedRepositories: saved } : {}) },
    repos: {},
  });
  const storeOf = (initial: Settings) => {
    const saves: Settings[] = [];
    return { saves, load: () => structuredClone(initial), save: (next: Settings) => void saves.push(structuredClone(next)) };
  };
  const at = () => new Date('2026-10-21T12:00:00.000Z');

  it('remembers a repository, so it is listed - and the factory is told it may work on it', () => {
    const repo = repository('projects', 'invest-track');
    const store = storeOf(settings([{ name: 'demo-app', path: '/w/demo-app' }]));

    expect(openRepositoryFolder(repo, store, at)).toEqual({ id: 'invest-track', name: 'invest-track', path: repo, lastAccessed: '2026-10-21T12:00:00.000Z' });

    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]?.global.savedRepositories).toEqual([{ name: 'demo-app', path: '/w/demo-app' }, { name: 'invest-track', path: repo }]);
  });

  it('starts the list when there is none yet', () => {
    const repo = repository('first');
    const store = storeOf(settings());

    openRepositoryFolder(repo, store, at);

    expect(store.saves[0]?.global.savedRepositories).toEqual([{ name: 'first', path: repo }]);
  });

  it('opens one that is already remembered without remembering it twice', () => {
    const repo = repository('again');
    const store = storeOf(settings([{ name: 'again', path: repo }]));

    expect(openRepositoryFolder(repo, store, at).path).toBe(repo);

    expect(store.saves).toEqual([]);
  });

  it('refuses a folder that is not a repository, and remembers nothing about it', () => {
    const plain = folder('notes');
    const store = storeOf(settings([{ name: 'demo-app', path: '/w/demo-app' }]));

    expect(() => openRepositoryFolder(plain, store, at)).toThrow(`${plain} is not a git repository`);

    expect(store.saves).toEqual([]);
  });
});
