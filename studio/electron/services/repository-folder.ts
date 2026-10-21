/**
 * Adding a repository: the folder the user picked is checked before anything is remembered about it.
 *
 * Any folder could be picked, and any folder used to be saved - a folder that is not a repository only logged a
 * warning nobody sees, and then every screen that needed one failed with a message about something else. The factory
 * works on git repositories: branches, commits and checkouts are what a task is made of.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Repository, Settings } from '../../shared/types';

export type FolderCheck = { ok: true } | { ok: false; message: string };

/** The repository a folder is inside of (the nearest folder above it with a `.git`), if any. */
function repositoryAbove(folder: string): string | null {
  for (let above = path.dirname(folder); ; above = path.dirname(above)) {
    if (fs.existsSync(path.join(above, '.git'))) return above;
    if (path.dirname(above) === above) return null;
  }
}

/**
 * Can the factory work on this folder? Only the top folder of a git repository can: a `.git` there - a folder, or
 * the file a linked checkout and a submodule have. The message says what to do instead, since the user picked it by hand.
 */
export function checkRepositoryFolder(folder: string): FolderCheck {
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    return { ok: false, message: `${folder} is not a folder, so it cannot be a repository.` };
  }
  if (fs.existsSync(path.join(folder, '.git'))) return { ok: true };

  const above = repositoryAbove(folder);
  if (above) {
    return { ok: false, message: `${folder} is inside the git repository ${above}. Open ${above} instead: the factory works on a whole repository.` };
  }
  return {
    ok: false,
    message:
      `${folder} is not a git repository (it has no .git folder), so the factory cannot work on it. ` +
      'Choose the folder that holds the repository, or run "git init" in this one and make a first commit.',
  };
}

export interface SettingsStore {
  load: () => Settings;
  save: (settings: Settings) => void;
}

/**
 * Adds the folder the user picked to the repositories they opened - or refuses it with the reason, remembering
 * nothing. What is remembered is also what the factory is told it may work on (see `factory-env.ts`).
 */
export function openRepositoryFolder(folder: string, store: SettingsStore, now: () => Date = () => new Date()): Repository {
  const check = checkRepositoryFolder(folder);
  if (!check.ok) throw new Error(check.message);

  const name = path.basename(folder);
  const settings = store.load();
  const saved = settings.global.savedRepositories ?? [];
  if (!saved.some((repo) => repo.path === folder)) {
    settings.global.savedRepositories = [...saved, { name, path: folder }];
    store.save(settings);
  }
  return { id: name, name, path: folder, lastAccessed: now().toISOString() };
}
