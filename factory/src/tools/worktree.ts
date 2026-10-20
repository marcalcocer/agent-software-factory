/**
 * One checkout per task.
 *
 * A task used to work in the user's own repository: it switched the branch they were on, refused to start
 * when they had uncommitted changes, and two tasks on one repository could not run at once. Now each task
 * works in its own git worktree - a second checkout of the same repository, on the task's branch, in
 * `<workspace>/.factory/worktrees/<repo>/<task id>` - and the user's folder is never touched.
 *
 * This module is git and the file system only. It knows nothing about runs or pull requests, so it can be
 * tested against a real repository in a temporary folder.
 *
 * What it will not do, on purpose:
 *   - fall back to the user's repository when a checkout cannot be made (the caller decides; the user
 *     asked for isolation, and a silent change of place is what this exists to prevent);
 *   - remove a folder that is not one of its own checkouts, or a checkout with changes in it, unless forced;
 *   - copy a file git does not ignore (it could be committed by mistake).
 */
import fs from 'node:fs';
import path from 'node:path';

import { fastForwardFromRemote, fetchRemoteBranch, freshestStartPoint, isWorkingTreeClean, refSha } from './git-tools.ts';
import { getFactoryConfig } from '../utils/factory-config.ts';
import { runGit, runProcess } from '../utils/shell.ts';

export type Isolation = 'worktree' | 'in-place';

/** A problem the user can act on. The message says where, and what to do. */
export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeError';
  }
}

/**
 * Where a task works. The task's own say wins (`--isolation`, the task form); then the place its earlier
 * rounds worked - a task keeps its place - then the configured default. A rehearsal makes no checkouts.
 */
export function chooseIsolation(input: { requested?: Isolation | undefined; inherited?: Isolation | undefined; fallback: Isolation; dryRun: boolean }): Isolation {
  if (input.dryRun) return 'in-place';
  return input.requested ?? input.inherited ?? input.fallback;
}

const firstLine = (text: string): string => text.trim().split('\n').find((line) => line.trim() !== '')?.trim() ?? '';

/* -------------------------------------------------------------------------- */
/* Where                                                                       */
/* -------------------------------------------------------------------------- */

/** Every checkout the factory makes lives under this folder - inside the workspace, so the usual jail applies. */
export function worktreesRoot(): string {
  return path.join(getFactoryConfig().workspaceRoot, '.factory', 'worktrees');
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Where the checkout of a task is (or would be): `<root>/<repo name>/<task id>`. */
export function worktreePathFor(mainRepoPath: string, taskId: string): string {
  if (!SAFE_ID.test(taskId)) throw new WorktreeError(`"${taskId}" cannot be the name of a checkout folder.`);
  return path.join(worktreesRoot(), path.basename(mainRepoPath), taskId);
}

/** Is this one of the factory's own checkouts? Anything else is never removed. */
export function isFactoryWorktree(candidate: string): boolean {
  const root = path.resolve(worktreesRoot());
  const relative = path.relative(root, path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) && relative.split(path.sep).length === 2;
}

const canonical = (target: string): string => {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
};
export const samePath = (a: string, b: string): boolean => canonical(a) === canonical(b);

/* -------------------------------------------------------------------------- */
/* What git knows                                                              */
/* -------------------------------------------------------------------------- */

export interface WorktreeEntry {
  path: string;
  head: string | null;
  /** The short branch name; null on a detached HEAD. */
  branch: string | null;
  /** The first one is the repository itself. */
  main: boolean;
  /** Git would forget it: its folder is gone. */
  prunable: boolean;
}

/** Parses `git worktree list --porcelain`. */
export function parseWorktreeList(text: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const location = lines.find((line) => line.startsWith('worktree '));
    if (!location) continue;
    const branch = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length);
    entries.push({
      path: location.slice('worktree '.length),
      head: lines.find((line) => line.startsWith('HEAD '))?.slice('HEAD '.length) ?? null,
      branch: branch ? branch.replace(/^refs\/heads\//, '') : null,
      main: entries.length === 0,
      prunable: lines.some((line) => line === 'prunable' || line.startsWith('prunable ')),
    });
  }
  return entries;
}

export async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
  const result = await runGit(['worktree', 'list', '--porcelain'], { cwd: repoPath });
  if (!result.ok) throw new WorktreeError(`Could not list the checkouts of ${repoPath}: ${firstLine(result.stderr)}`);
  return parseWorktreeList(result.stdout);
}

export interface WorktreeState {
  path: string;
  exists: boolean;
  branch: string | null;
  /** How many files have changes that are not committed. */
  changedFiles: number;
}

/** What is in a checkout right now. */
export async function inspectWorktree(treePath: string): Promise<WorktreeState> {
  if (!fs.existsSync(treePath)) return { path: treePath, exists: false, branch: null, changedFiles: 0 };
  const status = await runGit(['status', '--porcelain'], { cwd: treePath });
  const head = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: treePath });
  return {
    path: treePath,
    exists: true,
    branch: head.ok ? head.stdout.trim() : null,
    changedFiles: status.ok ? status.stdout.split('\n').filter((line) => line.trim() !== '').length : 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Dependencies and the files a checkout does not get from git                 */
/* -------------------------------------------------------------------------- */

const LOCKFILES: ReadonlyArray<{ file: string; install: [string, string[]] }> = [
  { file: 'package-lock.json', install: ['npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund']] },
  { file: 'npm-shrinkwrap.json', install: ['npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund']] },
  { file: 'pnpm-lock.yaml', install: ['pnpm', ['install', '--frozen-lockfile', '--prefer-offline']] },
  { file: 'yarn.lock', install: ['yarn', ['install', '--frozen-lockfile']] },
];

const sameContent = (a: string, b: string): boolean => {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
};

const present = (target: string): boolean => {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * Tells git to ignore these paths in every checkout of the repository (`info/exclude` is shared). A
 * `node_modules/` rule in `.gitignore` matches a directory only - not the symlink a checkout gets - so
 * without this `git add -A` would commit the link.
 */
async function ignoreLocally(mainRepoPath: string, patterns: string[]): Promise<void> {
  const where = await runGit(['rev-parse', '--git-path', 'info/exclude'], { cwd: mainRepoPath });
  if (!where.ok) throw new WorktreeError(`Could not find where git keeps its local ignore list: ${firstLine(where.stderr)}`);
  const file = path.resolve(mainRepoPath, where.stdout.trim());
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const known = new Set(current.split('\n').map((line) => line.trim()));
  const missing = patterns.filter((pattern) => !known.has(pattern));
  if (missing.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = current.includes('# Added by the software factory') ? '' : '# Added by the software factory: its checkouts link these from the repository.\n';
  fs.writeFileSync(file, `${current}${current === '' || current.endsWith('\n') ? '' : '\n'}${header}${missing.join('\n')}\n`, 'utf8');
}

const slashed = (dir: string, name: string): string => `/${dir === '.' ? '' : `${dir.replace(/\\/g, '/')}/`}${name}`;

/**
 * Gives a new checkout what git did not: its JavaScript dependencies.
 *
 * `node_modules` is linked from the repository when the lockfile is the same (nothing to install, nothing
 * to wait for); when the checkout was cut from a newer base whose lockfile differs, the linked packages
 * would be the wrong ones, so they are installed for real. A failed install is an error: a run that cannot
 * resolve its imports would fail in a way that points nowhere.
 */
export async function provideDependencies(options: {
  mainRepoPath: string;
  treePath: string;
  /** Folders (relative) with a `package.json` of their own, e.g. the stack's working directory. */
  dirs?: string[];
  onProgress?: (message: string) => void;
}): Promise<string[]> {
  const { mainRepoPath, treePath } = options;
  const notes: string[] = [];
  const dirs = [...new Set(['.', ...(options.dirs ?? [])])];
  const linked: string[] = [];

  for (const dir of dirs) {
    if (!fs.existsSync(path.join(treePath, dir, 'package.json'))) continue;
    const modules = path.join(treePath, dir, 'node_modules');
    if (present(modules)) continue;

    const lock = LOCKFILES.find((candidate) => fs.existsSync(path.join(treePath, dir, candidate.file)));
    const mainModules = path.join(mainRepoPath, dir, 'node_modules');
    const unchanged = !lock || sameContent(path.join(mainRepoPath, dir, lock.file), path.join(treePath, dir, lock.file));

    if (fs.existsSync(mainModules) && unchanged) {
      fs.symlinkSync(mainModules, modules, 'dir');
      linked.push(slashed(dir, 'node_modules'));
      notes.push(`Linked ${path.join(dir, 'node_modules')} from your repository (same lockfile).`);
      continue;
    }
    if (!lock) {
      notes.push(`${path.join(dir, 'package.json')} has no lockfile and your repository has no node_modules, so no dependencies were installed.`);
      continue;
    }

    const [command, args] = lock.install;
    options.onProgress?.(`Installing dependencies in ${dir === '.' ? 'the checkout' : dir} (${command} ${args[0]})`);
    const installed = await runProcess(command, args, { cwd: path.join(treePath, dir), trusted: true, timeoutMs: 15 * 60_000, maxOutputChars: 4_000 });
    if (!installed.ok) {
      throw new WorktreeError(
        `Installing the dependencies of the checkout at ${treePath} failed (${command} ${args.join(' ')}): ${firstLine(installed.stderr) || firstLine(installed.stdout)}`,
      );
    }
    notes.push(`Installed the dependencies in ${path.join(dir, 'node_modules')} (${lock.file} differs from your repository's, or it has none).`);
  }

  if (linked.length > 0) await ignoreLocally(mainRepoPath, linked);
  return notes;
}

/**
 * Copies the files the user listed (`FACTORY_WORKTREE_COPY`, e.g. `.env`) - only those git ignores,
 * so a secret cannot be committed because a checkout got a copy of it. Never overwrites.
 */
export async function copyConfiguredFiles(options: { mainRepoPath: string; treePath: string; files: string[] }): Promise<string[]> {
  const notes: string[] = [];
  for (const file of options.files) {
    const source = path.resolve(options.mainRepoPath, file);
    const target = path.resolve(options.treePath, file);
    const inside = (root: string, child: string) => !path.relative(root, child).startsWith('..') && !path.isAbsolute(path.relative(root, child));
    if (!inside(options.mainRepoPath, source) || !inside(options.treePath, target)) {
      notes.push(`Did not copy ${file}: it is outside the repository.`);
      continue;
    }
    if (!fs.existsSync(source) || present(target)) continue;
    const ignored = await runGit(['check-ignore', '-q', file], { cwd: options.treePath });
    if (!ignored.ok) {
      notes.push(`Did not copy ${file}: git does not ignore it, so it could be committed by mistake.`);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    notes.push(`Copied ${file} from your repository.`);
  }
  return notes;
}

/* -------------------------------------------------------------------------- */
/* Making one                                                                  */
/* -------------------------------------------------------------------------- */

export interface EnsureWorktreeOptions {
  /** The user's repository. */
  mainRepoPath: string;
  taskId: string;
  branch: string;
  baseBranch: string;
  /** A new branch starts from the newest state of the base (GitHub's, if it is ahead of the local one). */
  freshStart?: boolean;
  /** The branch name was chosen on purpose (a round on a pull request): take it from GitHub if only GitHub has it, and bring in what a reviewer pushed. */
  adoptRemote?: boolean;
  /** Folders (relative) with their own `package.json`, besides the root. */
  dependencyDirs?: string[];
  /** Files to copy from the repository (ignored ones only). */
  copyFiles?: string[];
  onProgress?: (message: string) => void;
}

export interface EnsureWorktreeResult {
  path: string;
  branch: string;
  /** The branch was made now (false: it already held work). */
  branchCreated: boolean;
  /** The checkout was there already, and is reused. */
  reused: boolean;
  notes: string[];
}

/**
 * The checkout of a task: made if it is not there, reused if it is. Calling it again for the same task is
 * how a further round, a retry and a resumed run find their way back to the same folder - and how a
 * checkout the user deleted comes back, from the branch (which holds the work).
 */
export async function ensureWorktree(options: EnsureWorktreeOptions): Promise<EnsureWorktreeResult> {
  const { mainRepoPath, branch } = options;
  const target = worktreePathFor(mainRepoPath, options.taskId);
  const notes: string[] = [];

  // Forget checkouts whose folder is gone, so their branches are free again.
  await runGit(['worktree', 'prune'], { cwd: mainRepoPath });
  const entries = await listWorktrees(mainRepoPath);
  const here = entries.find((entry) => samePath(entry.path, target));
  const holder = entries.find((entry) => entry.branch === branch && !samePath(entry.path, target));

  let branchCreated = false;
  let reused = false;

  if (here) {
    if (here.branch !== branch) {
      throw new WorktreeError(
        `The checkout at ${target} is on ${here.branch ?? 'no branch'}, not on ${branch}. Switch it back (git -C "${target}" switch ${branch}) or remove it.`,
      );
    }
    reused = true;
    if (options.adoptRemote) {
      const forwarded = await fastForwardFromRemote(target, branch);
      if (forwarded) notes.push(forwarded);
    }
  } else {
    if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
      throw new WorktreeError(`${target} exists but is not a checkout of ${path.basename(mainRepoPath)}. Move or delete it, then start again.`);
    }
    if (holder) {
      throw new WorktreeError(
        `The branch ${branch} is already checked out at ${holder.path}${holder.main ? ' (your repository)' : ''}. A branch can be checked out in one place only: ` +
          'switch that checkout to another branch, or run this task in your repository instead.',
      );
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    let args: string[];
    if (await refSha(mainRepoPath, `refs/heads/${branch}`)) {
      args = ['worktree', 'add', target, branch];
    } else if (options.adoptRemote && (await fetchRemoteBranch(mainRepoPath, branch)) && (await refSha(mainRepoPath, `refs/remotes/origin/${branch}`))) {
      args = ['worktree', 'add', '--track', '-b', branch, target, `origin/${branch}`];
    } else {
      const start = options.freshStart ? await freshestStartPoint(mainRepoPath, options.baseBranch) : { ref: options.baseBranch };
      if (start.note) notes.push(start.note);
      args = ['worktree', 'add', '--no-track', '-b', branch, target, start.ref];
      branchCreated = true;
    }
    const added = await runGit(args, { cwd: mainRepoPath });
    if (!added.ok) throw new WorktreeError(`Could not make the checkout at ${target}: ${firstLine(added.stderr) || firstLine(added.stdout)}`);
    notes.push(`Made a checkout of ${branch} at ${target}.`);
  }

  notes.push(...(await provideDependencies({ mainRepoPath, treePath: target, ...(options.dependencyDirs ? { dirs: options.dependencyDirs } : {}), ...(options.onProgress ? { onProgress: options.onProgress } : {}) })));
  if (options.copyFiles && options.copyFiles.length > 0) {
    notes.push(...(await copyConfiguredFiles({ mainRepoPath, treePath: target, files: options.copyFiles })));
  }

  return { path: target, branch, branchCreated, reused, notes };
}

/**
 * A run that works in a checkout of its own needs it to be there when it goes on. One the user removed
 * is made again from the task's branch (which holds everything that was committed); changes that were
 * never committed went with the folder.
 *
 * `null` when the run does not use a checkout. Throws `WorktreeError` when it cannot be put back.
 */
export async function reviveWorktree(meta: { isolation?: Isolation | undefined; workPath?: string | undefined; repoPath: string; branch?: string | undefined; baseBranch?: string | undefined }): Promise<{ path: string; revived: boolean; notes: string[] } | null> {
  if (meta.isolation !== 'worktree' || !meta.workPath) return null;
  if (fs.existsSync(meta.workPath)) return { path: meta.workPath, revived: false, notes: [] };
  if (!meta.branch) throw new WorktreeError(`The checkout at ${meta.workPath} is gone and this run does not say which branch it was on.`);

  const key = path.basename(meta.workPath);
  if (!samePath(worktreePathFor(meta.repoPath, key), meta.workPath)) {
    throw new WorktreeError(`The checkout at ${meta.workPath} is gone, and checkouts are kept somewhere else now (${worktreesRoot()}). Start the task again.`);
  }
  const made = await ensureWorktree({ mainRepoPath: meta.repoPath, taskId: key, branch: meta.branch, baseBranch: meta.baseBranch ?? 'main', adoptRemote: true });
  return { path: made.path, revived: true, notes: made.notes };
}

/** A reused checkout is the baseline of the next diff: changes left in it would be mixed into that diff. */
export async function assertCleanWorktree(treePath: string): Promise<void> {
  if (await isWorkingTreeClean(treePath)) return;
  throw new WorktreeError(
    `The checkout at ${treePath} has uncommitted changes from an earlier run. Commit or discard them there ` +
      `(git -C "${treePath}" status), or remove the checkout, then start again: the factory needs a clean baseline to produce a reviewable diff.`,
  );
}

/* -------------------------------------------------------------------------- */
/* Removing one                                                                */
/* -------------------------------------------------------------------------- */

export interface RemoveWorktreeResult {
  removed: boolean;
  /** Why not: `dirty` (changes in it), `not-ours` (not a factory checkout), `failed`. */
  reason?: 'dirty' | 'not-ours' | 'failed';
  message?: string;
}

/**
 * Removes a checkout. One that has changes is kept unless `force`; so is anything that is not a checkout
 * of the factory's. A checkout already gone is a success - the point is that it is not there.
 */
export async function removeWorktree(options: { mainRepoPath: string; path: string; force?: boolean }): Promise<RemoveWorktreeResult> {
  const { mainRepoPath } = options;
  if (!isFactoryWorktree(options.path)) {
    return { removed: false, reason: 'not-ours', message: `${options.path} is not a checkout the factory made, so it was left alone.` };
  }

  await runGit(['worktree', 'prune'], { cwd: mainRepoPath });
  const entries = await listWorktrees(mainRepoPath);
  const registered = entries.some((entry) => !entry.main && samePath(entry.path, options.path));

  if (!registered) {
    if (!fs.existsSync(options.path)) return { removed: true };
    return { removed: false, reason: 'not-ours', message: `${options.path} is not a checkout of ${path.basename(mainRepoPath)} (any more), so it was left alone.` };
  }

  const state = await inspectWorktree(options.path);
  if (state.changedFiles > 0 && !options.force) {
    return {
      removed: false,
      reason: 'dirty',
      message: `The checkout at ${options.path} has ${state.changedFiles} file${state.changedFiles === 1 ? '' : 's'} with changes that are not committed, so it was kept.`,
    };
  }

  const removed = await runGit(['worktree', 'remove', ...(options.force ? ['--force'] : []), options.path], { cwd: mainRepoPath });
  if (!removed.ok) return { removed: false, reason: 'failed', message: `Could not remove the checkout at ${options.path}: ${firstLine(removed.stderr)}` };
  return { removed: true };
}

/* -------------------------------------------------------------------------- */
/* "Check out here"                                                            */
/* -------------------------------------------------------------------------- */

export type CheckoutHereResult = { ok: true; branch: string } | { ok: false; error: string };

/**
 * Moves a task's branch from its own checkout to the user's repository, so they can run it where they
 * work. A branch is checked out in one place only, so the checkout goes first. Refuses before touching
 * anything when either side has changes that would be lost or mixed up; if the checkout in the user's
 * repository then fails, the task's checkout is put back.
 */
export async function checkoutHere(options: { mainRepoPath: string; path: string }): Promise<CheckoutHereResult> {
  const { mainRepoPath } = options;
  if (!isFactoryWorktree(options.path)) return { ok: false, error: `${options.path} is not a checkout the factory made.` };

  // Only a checkout git knows is inspected: `git status` in any other folder would answer for whatever
  // repository happens to contain it.
  const known = (await listWorktrees(mainRepoPath)).find((entry) => !entry.main && samePath(entry.path, options.path));
  if (!known) return { ok: false, error: `${options.path} is not a checkout of ${path.basename(mainRepoPath)} (any more), so it was left alone.` };
  const state = await inspectWorktree(options.path);
  if (!state.exists) return { ok: false, error: `The checkout at ${options.path} is gone. The branch is still in your repository: git checkout it there.` };
  if (!state.branch || state.branch === 'HEAD') return { ok: false, error: `The checkout at ${options.path} is not on a branch.` };
  if (state.changedFiles > 0) {
    return {
      ok: false,
      error: `The checkout at ${options.path} has ${state.changedFiles} file${state.changedFiles === 1 ? '' : 's'} with changes that are not committed, and they cannot come along. Commit or discard them there first.`,
    };
  }
  if (!(await isWorkingTreeClean(mainRepoPath))) {
    return { ok: false, error: `Your repository has changes that are not committed. Commit or stash them, then try again: the branch will be checked out over them.` };
  }

  const removal = await removeWorktree({ mainRepoPath, path: options.path });
  if (!removal.removed) return { ok: false, error: removal.message ?? `Could not remove the checkout at ${options.path}.` };

  const switched = await runGit(['checkout', state.branch], { cwd: mainRepoPath });
  if (switched.ok) return { ok: true, branch: state.branch };

  // Put the task's checkout back: nothing should be lost because the user's repository said no.
  const restored = await ensureWorktree({ mainRepoPath, taskId: path.basename(options.path), branch: state.branch, baseBranch: state.branch }).then(
    () => true,
    () => false,
  );
  return {
    ok: false,
    error:
      `Could not check out ${state.branch} in your repository: ${firstLine(switched.stderr)}. ` +
      (restored ? "The task's checkout was put back." : `The branch is intact; the task's checkout could not be put back (it is made again the next time the task runs).`),
  };
}
