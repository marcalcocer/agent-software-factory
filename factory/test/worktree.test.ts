import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertCleanWorktree,
  ensureWorktree,
  inspectWorktree,
  isFactoryWorktree,
  listWorktrees,
  parseWorktreeList,
  removeWorktree,
  reviveWorktree,
  WorktreeError,
  worktreePathFor,
  worktreesRoot,
} from '../src/tools/worktree.ts';
import { createWorkspaceRepo, type WorkspaceRepo } from './support/git-repo.ts';

let ws: WorkspaceRepo;

beforeEach(() => {
  ws = createWorkspaceRepo();
  vi.stubEnv('FACTORY_WORKSPACE_ROOT', ws.workspace);
  vi.stubEnv('FACTORY_LOG_DIR', path.join(ws.workspace, '..', 'logs'));
});
afterEach(() => ws.cleanup());

const start = (overrides: Partial<Parameters<typeof ensureWorktree>[0]> = {}) =>
  ensureWorktree({ mainRepoPath: ws.repo, taskId: 'f0001', branch: 'factory/f0001/feat-x', baseBranch: 'main', freshStart: true, ...overrides });

/** A place for checkouts outside the workspace (removed with it): the setting can point anywhere. */
const keptAt = (name: string) => path.join(ws.workspace, '..', `checkouts-${name}`);

const branchOf = (cwd: string) => ws.gitIn(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
const statusOf = (cwd: string) => ws.gitIn(cwd, 'status', '--porcelain').trim();

describe('where checkouts live', () => {
  it('is <workspace>/.factory/worktrees/<repo>/<task>', () => {
    expect(worktreesRoot()).toBe(path.join(ws.workspace, '.factory', 'worktrees'));
    expect(worktreePathFor(ws.repo, 'f0042')).toBe(path.join(ws.workspace, '.factory', 'worktrees', 'app', 'f0042'));
  });

  it('is the folder the user chose, once they chose one - and what is in the default folder is then not its own', () => {
    vi.stubEnv('FACTORY_WORKTREES_DIR', keptAt('mine'));

    expect(worktreePathFor(ws.repo, 'f0042')).toBe(path.join(keptAt('mine'), 'app', 'f0042'));
    expect(isFactoryWorktree(path.join(keptAt('mine'), 'app', 'f0042'))).toBe(true);
    expect(isFactoryWorktree(path.join(ws.workspace, '.factory', 'worktrees', 'app', 'f0042'))).toBe(false);
  });

  it.each(['', '../escape', 'a/b', '.hidden', 'x y'])('refuses "%s" as a task id: it could not be a folder name', (id) => {
    expect(() => worktreePathFor(ws.repo, id)).toThrow(WorktreeError);
  });

  it('knows its own checkouts - and nothing else', () => {
    const own = worktreePathFor(ws.repo, 'f0001');
    expect(isFactoryWorktree(own)).toBe(true);
    for (const other of [ws.repo, worktreesRoot(), path.dirname(own), path.join(own, 'src'), path.join(worktreesRoot(), '..', 'x'), '/tmp', path.join(own, '..', '..', '..', 'app')]) {
      expect(isFactoryWorktree(other)).toBe(false);
    }
  });
});

describe('parseWorktreeList', () => {
  it('reads what git prints: the repository first, branches without refs/heads, detached and prunable ones', () => {
    const entries = parseWorktreeList(
      [
        'worktree /w/app', 'HEAD aaa111', 'branch refs/heads/main', '',
        'worktree /w/.factory/worktrees/app/f0001', 'HEAD bbb222', 'branch refs/heads/factory/f0001/feat-x', '',
        'worktree /w/.factory/worktrees/app/f0002', 'HEAD ccc333', 'detached', '',
        'worktree /w/.factory/worktrees/app/f0003', 'HEAD ddd444', 'branch refs/heads/gone', 'prunable gitdir file points to non-existent location', '',
      ].join('\n'),
    );

    expect(entries.map((entry) => [entry.path, entry.branch, entry.main, entry.prunable])).toEqual([
      ['/w/app', 'main', true, false],
      ['/w/.factory/worktrees/app/f0001', 'factory/f0001/feat-x', false, false],
      ['/w/.factory/worktrees/app/f0002', null, false, false],
      ['/w/.factory/worktrees/app/f0003', 'gone', false, true],
    ]);
  });
});

describe('ensureWorktree: a new task', () => {
  it('makes a checkout on a new branch and leaves the repository exactly as it was', async () => {
    const before = ws.git('rev-parse', 'HEAD');
    const made = await start();

    expect(made).toMatchObject({ path: worktreePathFor(ws.repo, 'f0001'), branch: 'factory/f0001/feat-x', branchCreated: true, reused: false });
    expect(branchOf(made.path)).toBe('factory/f0001/feat-x');
    expect(fs.readFileSync(path.join(made.path, 'src', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
    // The user's folder: same branch, same commit, nothing new in it.
    expect(branchOf(ws.repo)).toBe('main');
    expect(ws.git('rev-parse', 'HEAD')).toBe(before);
    expect(statusOf(ws.repo)).toBe('');
  });

  it('does not mind that the repository has uncommitted changes - the point of having its own checkout', async () => {
    fs.writeFileSync(path.join(ws.repo, 'README.md'), '# app, edited by the user\n');
    fs.writeFileSync(path.join(ws.repo, 'notes.txt'), 'untracked\n');

    const made = await start();

    expect(statusOf(made.path)).toBe('');
    expect(fs.readFileSync(path.join(ws.repo, 'README.md'), 'utf8')).toBe('# app, edited by the user\n');
    expect(statusOf(ws.repo)).toContain('notes.txt');
  });

  it('starts from what GitHub has when it is ahead of the local branch', async () => {
    ws.pushFromElsewhere('main', 'src/from-teammate.js', 'module.exports = "teammate";\n');

    const made = await start();

    expect(fs.existsSync(path.join(made.path, 'src', 'from-teammate.js'))).toBe(true);
    expect(fs.existsSync(path.join(ws.repo, 'src', 'from-teammate.js'))).toBe(false); // the user's main is not pulled
    expect(made.notes.join(' ')).toContain('on GitHub is ahead');
  });

  it('starts from the local base when asked not to refresh it', async () => {
    ws.pushFromElsewhere('main', 'src/from-teammate.js', 'x\n');

    const made = await start({ freshStart: false });

    expect(fs.existsSync(path.join(made.path, 'src', 'from-teammate.js'))).toBe(false);
  });

  it('is not tracking the base: a push of the new branch must not go to main', async () => {
    // Cut from origin/main (GitHub is ahead), which git would otherwise make the branch's upstream.
    ws.pushFromElsewhere('main', 'src/from-teammate.js', 'x\n');
    const made = await start();
    expect(fs.existsSync(path.join(made.path, 'src', 'from-teammate.js'))).toBe(true);

    expect(() => ws.gitIn(made.path, 'rev-parse', '--abbrev-ref', '@{upstream}')).toThrow();
  });
});

describe('ensureWorktree: dependencies', () => {
  it('links node_modules from the repository when the lockfile is the same - and git does not see the link', async () => {
    const made = await start();

    const modules = path.join(made.path, 'node_modules');
    expect(fs.lstatSync(modules).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(modules, 'dep', 'index.js'), 'utf8')).toBe('module.exports = "dep";\n');
    // `.gitignore` says `node_modules/`, which matches a directory and not a link: without the local
    // ignore, `git add -A` would commit the link.
    expect(statusOf(made.path)).toBe('');
    ws.gitIn(made.path, 'add', '-A');
    expect(ws.gitIn(made.path, 'diff', '--cached', '--name-only').trim()).toBe('');
    expect(made.notes.join(' ')).toContain('Linked node_modules from your repository (same lockfile)');
  });

  it('links the dependencies of a subfolder that has its own package.json', async () => {
    fs.mkdirSync(path.join(ws.repo, 'ui', 'node_modules', 'react'), { recursive: true });
    fs.writeFileSync(path.join(ws.repo, 'ui', 'package.json'), '{"name":"ui","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(ws.repo, 'ui', 'package-lock.json'), '{"name":"ui","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"ui","version":"1.0.0"}}}\n');
    ws.git('add', '-A');
    ws.git('commit', '-q', '-m', 'add ui');
    ws.git('push', '-q', 'origin', 'main');

    const made = await start({ dependencyDirs: ['ui'] });

    expect(fs.lstatSync(path.join(made.path, 'ui', 'node_modules')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(made.path, 'ui', 'node_modules', 'react'))).toBe(true);
    expect(statusOf(made.path)).toBe('');
  });

  it('installs for real when the base has a different lockfile - the linked packages would be the wrong ones', async () => {
    // GitHub's main gains a dependency (a local package, so it installs offline); the user's copy, and the
    // node_modules installed from its lockfile, stay behind.
    const vendor = path.join(ws.repo, 'vendor', 'tiny');
    fs.mkdirSync(vendor, { recursive: true });
    fs.writeFileSync(path.join(vendor, 'package.json'), '{"name":"tiny","version":"1.0.0","main":"index.js"}\n');
    fs.writeFileSync(path.join(vendor, 'index.js'), 'module.exports = "tiny";\n');
    const manifest = JSON.parse(fs.readFileSync(path.join(ws.repo, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(ws.repo, 'package.json'), JSON.stringify({ ...manifest, dependencies: { tiny: 'file:./vendor/tiny' } }, null, 2));
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], { cwd: ws.repo, stdio: 'pipe' });
    ws.git('add', '-A');
    ws.git('commit', '-q', '-m', 'add tiny');
    ws.git('push', '-q', 'origin', 'main');
    ws.git('reset', '-q', '--hard', 'HEAD~1');
    expect(fs.existsSync(path.join(ws.repo, 'vendor'))).toBe(false);

    const made = await start();

    const modules = path.join(made.path, 'node_modules');
    expect(fs.lstatSync(modules).isSymbolicLink()).toBe(false); // its own, not the repository's
    expect(fs.readFileSync(path.join(modules, 'tiny', 'index.js'), 'utf8')).toBe('module.exports = "tiny";\n');
    expect(fs.existsSync(path.join(ws.repo, 'node_modules', 'tiny'))).toBe(false); // the repository's are untouched
    expect(made.notes.join(' ')).toContain('Installed the dependencies in node_modules');
    expect(statusOf(made.path)).toBe('');
  }, 90_000);

  it('says what failed, with the path, when the install fails - no quiet fallback', async () => {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-npm-'));
    fs.writeFileSync(path.join(fakeBin, 'npm'), '#!/bin/sh\necho "npm ERR! network unreachable" >&2\nexit 1\n', { mode: 0o755 });
    vi.stubEnv('PATH', `${fakeBin}${path.delimiter}${process.env.PATH}`);
    // A lockfile that differs from the repository's forces the install.
    fs.rmSync(path.join(ws.repo, 'node_modules'), { recursive: true });

    await expect(start()).rejects.toThrow(/Installing the dependencies of the checkout at .*f0001.* failed \(npm ci .*\): npm ERR! network unreachable/);
    fs.rmSync(fakeBin, { recursive: true, force: true });
  });
});

describe('ensureWorktree: files git does not give', () => {
  it('copies an ignored file the user listed, never over one that is there', async () => {
    fs.writeFileSync(path.join(ws.repo, '.env'), 'TOKEN=abc\n');

    const made = await start({ copyFiles: ['.env'] });

    expect(fs.readFileSync(path.join(made.path, '.env'), 'utf8')).toBe('TOKEN=abc\n');
    expect(statusOf(made.path)).toBe('');
    fs.writeFileSync(path.join(made.path, '.env'), 'TOKEN=changed-here\n');
    await start({ copyFiles: ['.env'] });
    expect(fs.readFileSync(path.join(made.path, '.env'), 'utf8')).toBe('TOKEN=changed-here\n');
  });

  it('refuses to copy a file git does not ignore: a checkout must not be a way to commit it by mistake', async () => {
    fs.writeFileSync(path.join(ws.repo, 'secrets.json'), '{"key":"x"}\n');

    const made = await start({ copyFiles: ['secrets.json'] });

    expect(fs.existsSync(path.join(made.path, 'secrets.json'))).toBe(false);
    expect(made.notes.join(' ')).toContain('Did not copy secrets.json: git does not ignore it');
  });

  it('refuses a path that leaves the repository', async () => {
    fs.writeFileSync(path.join(ws.workspace, 'outside.txt'), 'x\n');

    const made = await start({ copyFiles: ['../outside.txt'] });

    expect(made.notes.join(' ')).toContain('Did not copy ../outside.txt: it is outside the repository');
    expect(fs.existsSync(path.join(made.path, '..', 'outside.txt'))).toBe(false);
  });
});

describe('ensureWorktree: coming back to a task', () => {
  it('finds the same checkout again - a further round, a retry, a resumed run', async () => {
    const first = await start();
    fs.writeFileSync(path.join(first.path, 'work.txt'), 'in progress\n');

    const again = await start();

    expect(again).toMatchObject({ path: first.path, reused: true, branchCreated: false });
    expect(fs.readFileSync(path.join(again.path, 'work.txt'), 'utf8')).toBe('in progress\n');
  });

  it('brings a deleted checkout back from its branch, with the work that was committed', async () => {
    const first = await start();
    fs.writeFileSync(path.join(first.path, 'done.txt'), 'committed\n');
    ws.gitIn(first.path, 'add', '-A');
    ws.gitIn(first.path, 'commit', '-q', '-m', 'the work');
    fs.rmSync(first.path, { recursive: true, force: true }); // the user deleted the folder by hand

    const back = await start({ adoptRemote: true });

    expect(back).toMatchObject({ path: first.path, reused: false, branchCreated: false });
    expect(fs.readFileSync(path.join(back.path, 'done.txt'), 'utf8')).toBe('committed\n');
  });

  it('brings in what a reviewer pushed while the checkout was gone - the branch is behind GitHub\'s', async () => {
    const first = await start();
    ws.gitIn(first.path, 'push', '-q', '-u', 'origin', 'factory/f0001/feat-x');
    ws.pushFromElsewhere('factory/f0001/feat-x', 'src/suggestion.js', 'module.exports = "suggested";\n');
    fs.rmSync(first.path, { recursive: true, force: true });

    const back = await start({ adoptRemote: true });

    expect(back.reused).toBe(false);
    expect(fs.existsSync(path.join(back.path, 'src', 'suggestion.js'))).toBe(true);
    expect(back.notes.join(' ')).toContain('fast-forwarded');
  });

  it('leaves a branch that has diverged from GitHub\'s as it is - someone\'s work is not merged silently', async () => {
    const first = await start();
    ws.gitIn(first.path, 'push', '-q', '-u', 'origin', 'factory/f0001/feat-x');
    ws.pushFromElsewhere('factory/f0001/feat-x', 'src/theirs.js', 'x\n');
    fs.writeFileSync(path.join(first.path, 'src', 'ours.js'), 'y\n');
    ws.gitIn(first.path, 'add', '-A');
    ws.gitIn(first.path, 'commit', '-q', '-m', 'ours');
    fs.rmSync(first.path, { recursive: true, force: true });

    const back = await start({ adoptRemote: true });

    expect(fs.existsSync(path.join(back.path, 'src', 'ours.js'))).toBe(true);
    expect(fs.existsSync(path.join(back.path, 'src', 'theirs.js'))).toBe(false);
    expect(back.notes.join(' ')).toContain('has diverged');
  });

  it('takes a branch that only GitHub has - a pull request opened from another machine', async () => {
    ws.pushFromElsewhere('feature/from-github', 'src/feature.js', 'module.exports = "feature";\n');

    const made = await start({ branch: 'feature/from-github', adoptRemote: true });

    expect(made).toMatchObject({ branchCreated: false, reused: false });
    expect(fs.existsSync(path.join(made.path, 'src', 'feature.js'))).toBe(true);
    expect(ws.gitIn(made.path, 'rev-parse', '--abbrev-ref', '@{upstream}').trim()).toBe('origin/feature/from-github');
  });

  it('brings in what a reviewer pushed on top of the branch, when it is a plain fast-forward', async () => {
    const first = await start();
    ws.gitIn(first.path, 'push', '-q', '-u', 'origin', 'factory/f0001/feat-x');
    ws.pushFromElsewhere('factory/f0001/feat-x', 'src/suggestion.js', 'module.exports = "suggested";\n');

    const again = await start({ adoptRemote: true });

    expect(again.reused).toBe(true);
    expect(fs.existsSync(path.join(again.path, 'src', 'suggestion.js'))).toBe(true);
    expect(again.notes.join(' ')).toContain('fast-forwarded');
  });
});

describe('ensureWorktree: what it refuses, and says', () => {
  it('will not take a branch your repository has checked out', async () => {
    ws.git('checkout', '-q', '-b', 'factory/f0001/feat-x');

    const error = await start().catch((caught: Error) => caught);

    expect(error).toBeInstanceOf(WorktreeError);
    expect((error as Error).message).toContain(`already checked out at ${ws.repo} (your repository)`);
    expect((error as Error).message).toContain('run this task in your repository instead');
  });

  it('will not take a branch another checkout has', async () => {
    const other = await start({ taskId: 'f0009' });

    await expect(start({ taskId: 'f0002' })).rejects.toThrow(`already checked out at ${other.path}`);
  });

  it('will not build in a folder that is not a checkout, and leaves what is there alone', async () => {
    const target = worktreePathFor(ws.repo, 'f0001');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'precious.txt'), 'the user put this here\n');

    await expect(start()).rejects.toThrow(`${target} exists but is not a checkout of app`);
    expect(fs.readFileSync(path.join(target, 'precious.txt'), 'utf8')).toBe('the user put this here\n');
  });

  it('builds in an empty folder', async () => {
    fs.mkdirSync(worktreePathFor(ws.repo, 'f0001'), { recursive: true });

    await expect(start()).resolves.toMatchObject({ reused: false });
  });

  it('tells you when the checkout of the task has been switched to another branch', async () => {
    const made = await start();
    ws.gitIn(made.path, 'switch', '-q', '-c', 'something-else');

    await expect(start()).rejects.toThrow(`The checkout at ${made.path} is on something-else, not on factory/f0001/feat-x`);
  });

  it('names the checkout and what to do when it has changes left over from an earlier run', async () => {
    const made = await start();
    fs.writeFileSync(path.join(made.path, 'half-done.txt'), 'x\n');

    await expect(assertCleanWorktree(made.path)).rejects.toThrow(`The checkout at ${made.path} has uncommitted changes from an earlier run`);
    fs.rmSync(path.join(made.path, 'half-done.txt'));
    await expect(assertCleanWorktree(made.path)).resolves.toBeUndefined();
  });

  it('cannot make a checkout of a repository that is not a git repository', async () => {
    fs.mkdirSync(path.join(ws.workspace, 'plain'));

    await expect(ensureWorktree({ mainRepoPath: path.join(ws.workspace, 'plain'), taskId: 'f0001', branch: 'b', baseBranch: 'main' })).rejects.toThrow(WorktreeError);
  });
});

describe('removeWorktree', () => {
  it('removes a clean checkout, keeps the branch, and does not touch the repository\'s node_modules', async () => {
    const made = await start();

    const result = await removeWorktree({ mainRepoPath: ws.repo, path: made.path });

    expect(result).toEqual({ removed: true });
    expect(fs.existsSync(made.path)).toBe(false);
    expect(ws.git('branch', '--list', 'factory/f0001/feat-x').trim()).toContain('factory/f0001/feat-x');
    expect(fs.readFileSync(path.join(ws.repo, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('module.exports = "dep";\n');
  });

  it('keeps a checkout with changes, saying how many files, unless forced', async () => {
    const made = await start();
    fs.writeFileSync(path.join(made.path, 'a.txt'), 'x\n');
    fs.writeFileSync(path.join(made.path, 'b.txt'), 'y\n');

    const kept = await removeWorktree({ mainRepoPath: ws.repo, path: made.path });
    expect(kept).toMatchObject({ removed: false, reason: 'dirty' });
    expect(kept.message).toContain('2 files with changes that are not committed');
    expect(fs.existsSync(made.path)).toBe(true);

    expect(await removeWorktree({ mainRepoPath: ws.repo, path: made.path, force: true })).toEqual({ removed: true });
    expect(fs.existsSync(made.path)).toBe(false);
  });

  it('frees the branch, so the repository can check it out ("check out here")', async () => {
    const made = await start();
    await removeWorktree({ mainRepoPath: ws.repo, path: made.path });

    ws.git('checkout', '-q', 'factory/f0001/feat-x');
    expect(branchOf(ws.repo)).toBe('factory/f0001/feat-x');
  });

  it('leaves alone anything that is not a checkout of the factory\'s - the repository first of all', async () => {
    const stray = path.join(ws.workspace, 'other-project');
    fs.mkdirSync(stray);

    for (const target of [ws.repo, stray, ws.workspace, '/tmp']) {
      expect(await removeWorktree({ mainRepoPath: ws.repo, path: target, force: true })).toMatchObject({ removed: false, reason: 'not-ours' });
    }
    expect(fs.existsSync(path.join(ws.repo, '.git'))).toBe(true);
    expect(fs.existsSync(stray)).toBe(true);
  });

  it('leaves alone a checkout the USER made of the same repository, even when forced - the work in it is theirs', async () => {
    const theirs = path.join(ws.workspace, 'app-hotfix');
    ws.git('worktree', 'add', '-q', '-b', 'hotfix', theirs);
    fs.writeFileSync(path.join(theirs, 'unsaved.txt'), 'uncommitted work\n');

    const result = await removeWorktree({ mainRepoPath: ws.repo, path: theirs, force: true });

    expect(result).toMatchObject({ removed: false, reason: 'not-ours' });
    expect(fs.readFileSync(path.join(theirs, 'unsaved.txt'), 'utf8')).toBe('uncommitted work\n');
    expect((await listWorktrees(ws.repo)).some((entry) => entry.path === theirs)).toBe(true);
  });

  it('leaves alone a folder in the right place that is not a checkout of this repository', async () => {
    const target = worktreePathFor(ws.repo, 'f0007');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'precious.txt'), 'x\n');

    expect(await removeWorktree({ mainRepoPath: ws.repo, path: target, force: true })).toMatchObject({ removed: false, reason: 'not-ours' });
    expect(fs.existsSync(path.join(target, 'precious.txt'))).toBe(true);
  });

  it('removes a checkout in the folder the user chose, like any other', async () => {
    vi.stubEnv('FACTORY_WORKTREES_DIR', keptAt('mine'));
    const made = await start();
    expect(made.path).toBe(path.join(keptAt('mine'), 'app', 'f0001'));

    expect(await removeWorktree({ mainRepoPath: ws.repo, path: made.path })).toEqual({ removed: true });

    expect(fs.existsSync(made.path)).toBe(false);
    expect((await listWorktrees(ws.repo)).filter((entry) => !entry.main)).toEqual([]);
  });

  it('leaves alone a checkout made before the folder for them was changed - and says where checkouts are kept now', async () => {
    vi.stubEnv('FACTORY_WORKTREES_DIR', keptAt('before'));
    const made = await start();
    fs.writeFileSync(path.join(made.path, 'unsaved.txt'), 'uncommitted work\n');
    vi.stubEnv('FACTORY_WORKTREES_DIR', keptAt('after'));

    const result = await removeWorktree({ mainRepoPath: ws.repo, path: made.path, force: true });

    expect(result).toMatchObject({ removed: false, reason: 'not-ours' });
    expect(result.message).toContain(`${made.path} is not in the folder where the factory keeps its checkouts (${keptAt('after')})`);
    expect(fs.readFileSync(path.join(made.path, 'unsaved.txt'), 'utf8')).toBe('uncommitted work\n');
  });

  it('is a success when the checkout is already gone', async () => {
    const made = await start();
    fs.rmSync(made.path, { recursive: true, force: true });

    expect(await removeWorktree({ mainRepoPath: ws.repo, path: made.path })).toEqual({ removed: true });
    expect((await listWorktrees(ws.repo)).filter((entry) => !entry.main)).toEqual([]);
  });
});

describe('inspectWorktree', () => {
  it('says what is in a checkout, and that a missing one is missing', async () => {
    const made = await start();
    fs.writeFileSync(path.join(made.path, 'a.txt'), 'x\n');
    fs.writeFileSync(path.join(made.path, 'README.md'), 'changed\n');

    expect(await inspectWorktree(made.path)).toEqual({ path: made.path, exists: true, branch: 'factory/f0001/feat-x', changedFiles: 2 });
    expect(await inspectWorktree(path.join(ws.workspace, 'nowhere'))).toMatchObject({ exists: false, branch: null, changedFiles: 0 });
  });
});

describe('reviveWorktree: a run that goes on after its checkout was removed', () => {
  const meta = (made: { path: string }, overrides: Record<string, unknown> = {}) => ({
    isolation: 'worktree' as const, workPath: made.path, repoPath: ws.repo, branch: 'factory/f0001/feat-x', baseBranch: 'main', ...overrides,
  });

  it('has nothing to do for a run that does not use a checkout, or whose checkout is there', async () => {
    const made = await start();

    expect(await reviveWorktree({ isolation: 'in-place', workPath: ws.repo, repoPath: ws.repo })).toBeNull();
    expect(await reviveWorktree({ repoPath: ws.repo })).toBeNull();
    expect(await reviveWorktree(meta(made))).toEqual({ path: made.path, revived: false, notes: [] });
  });

  it('makes the checkout again from the branch, with what was committed', async () => {
    const made = await start();
    fs.writeFileSync(path.join(made.path, 'done.txt'), 'committed\n');
    ws.gitIn(made.path, 'add', '-A');
    ws.gitIn(made.path, 'commit', '-q', '-m', 'the work');
    fs.rmSync(made.path, { recursive: true, force: true });

    const back = await reviveWorktree(meta(made));

    expect(back).toMatchObject({ path: made.path, revived: true });
    expect(fs.readFileSync(path.join(made.path, 'done.txt'), 'utf8')).toBe('committed\n');
    expect(branchOf(made.path)).toBe('factory/f0001/feat-x');
  });

  it('goes on in a checkout made before the folder for them was changed, while that is still somewhere the factory works', async () => {
    const made = await start(); // in <workspace>/.factory/worktrees
    vi.stubEnv('FACTORY_WORKTREES_DIR', keptAt('after'));

    expect(await reviveWorktree(meta(made))).toEqual({ path: made.path, revived: false, notes: [] });
  });

  it('does not hand the agents a checkout that is outside everywhere the factory works now - it says what to do instead', async () => {
    vi.stubEnv('FACTORY_WORKTREES_DIR', keptAt('before'));
    const made = await start();
    vi.stubEnv('FACTORY_WORKTREES_DIR', keptAt('after'));

    const error = await reviveWorktree(meta(made)).then(
      () => null,
      (thrown: Error) => thrown,
    );

    expect(error).toBeInstanceOf(WorktreeError);
    expect(error?.message).toContain(`The checkout at ${made.path} is outside the folders the factory works in now`);
    expect(error?.message).toContain(`checkouts are kept in ${keptAt('after')}`);
    expect(error?.message).toContain(`FACTORY_WORKTREES_DIR=${keptAt('before')}`);
    expect(error?.message).toContain(`git -C "${ws.repo}" worktree remove "${made.path}"`);
    expect(fs.existsSync(made.path)).toBe(true); // nothing was touched
  });

  it('says so when it cannot: no branch recorded, or checkouts are kept somewhere else now', async () => {
    const made = await start();
    fs.rmSync(made.path, { recursive: true, force: true });

    await expect(reviveWorktree(meta(made, { branch: undefined }))).rejects.toThrow('does not say which branch');
    await expect(reviveWorktree(meta(made, { workPath: path.join(ws.workspace, 'elsewhere', 'app', 'f0001') }))).rejects.toThrow('checkouts are kept somewhere else now');
  });
});
