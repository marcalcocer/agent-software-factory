import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commandWorktreeCheckout, commandWorktreeGc, commandWorktreeList, commandWorktreeRemove } from '../src/cli/worktrees.ts';
import { setPullRequestState } from '../src/tools/pr-registry.ts';
import { checkoutHere, ensureWorktree, listWorktrees, worktreePathFor } from '../src/tools/worktree.ts';
import { reportCheckouts } from '../src/tools/worktree-report.ts';
import { createWorkspaceRepo, deliverTask, type DeliveredTask, type WorkspaceRepo } from './support/git-repo.ts';

let ws: WorkspaceRepo;
let logs: string;
let task: DeliveredTask;

beforeEach(async () => {
  ws = createWorkspaceRepo();
  logs = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-wtcmd-'));
  vi.stubEnv('FACTORY_WORKSPACE_ROOT', ws.workspace);
  vi.stubEnv('FACTORY_LOG_DIR', logs);
  task = await deliverTask(ws);
});
afterEach(() => {
  ws.cleanup();
  fs.rmSync(logs, { recursive: true, force: true });
});

/** Runs a command and returns its exit code, the payload of its marker line, and stderr. */
async function run(command: (flags: Record<string, string | boolean>) => Promise<number>, flags: Record<string, string | boolean>, marker: string) {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (out.push(String(chunk)), true));
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (err.push(String(chunk)), true));
  try {
    const code = await command(flags);
    const lines = out.join('').split('\n').filter((line) => line.startsWith(`${marker} `));
    return { code, lines, payload: lines[0] ? JSON.parse(lines[0].slice(marker.length + 1)) : null, stderr: err.join('') };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

const branchOf = (cwd: string) => ws.gitIn(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim();

describe('reportCheckouts', () => {
  it('says where a task works, what it is, what its pull request is doing, and that nothing is lost if it goes', async () => {
    const [report] = await reportCheckouts(ws.repo);

    expect(report).toEqual({
      path: task.workPath, taskId: 'f0001', branch: task.branch, exists: true, registered: true, changedFiles: 0,
      title: 'Add a greeting helper', rootRunId: task.runId,
      pullRequest: { number: 8, url: 'https://github.com/o/app/pull/8', state: 'OPEN' },
      stale: false,
    });
  });

  it('counts the files that have changes, and calls a checkout stale once its pull request is over', async () => {
    fs.writeFileSync(path.join(task.workPath, 'wip.txt'), 'x\n');
    await setPullRequestState(`${ws.repo}#8`, 'MERGED');

    const [report] = await reportCheckouts(ws.repo);

    expect(report).toMatchObject({ changedFiles: 1, stale: true, pullRequest: { state: 'MERGED' } });
  });

  it('lists a checkout whose task has no pull request as a task still going - not stale', async () => {
    await ensureWorktree({ mainRepoPath: ws.repo, taskId: 'f0002', branch: 'factory/f0002/feat-other', baseBranch: 'main' });

    const reports = await reportCheckouts(ws.repo);

    expect(reports.map((report) => [report.taskId, report.pullRequest?.number ?? null, report.stale])).toEqual([['f0001', 8, false], ['f0002', null, false]]);
  });

  it('shows a folder git does not know as unregistered, without asking git about it', async () => {
    const orphan = worktreePathFor(ws.repo, 'f0099');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'something.txt'), 'x\n');

    const reports = await reportCheckouts(ws.repo);

    const found = reports.find((report) => report.taskId === 'f0099')!;
    expect(found).toMatchObject({ path: orphan, exists: true, registered: false, branch: null, changedFiles: 0, stale: false });
  });

  it('does not list your own worktrees, or the repository', async () => {
    ws.git('worktree', 'add', '-q', '-b', 'hotfix', path.join(ws.workspace, 'app-hotfix'));

    expect((await reportCheckouts(ws.repo)).map((report) => report.taskId)).toEqual(['f0001']);
  });

  it('is empty when the factory never made a checkout', async () => {
    fs.rmSync(path.join(ws.workspace, '.factory'), { recursive: true });
    ws.git('worktree', 'prune');

    expect(await reportCheckouts(ws.repo)).toEqual([]);
  });
});

describe('worktree-list', () => {
  it('prints one line for the Studio', async () => {
    const result = await run(commandWorktreeList, { repo: 'app' }, 'WORKTREE_LIST_JSON');

    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(1);
    expect(result.payload.repoPath).toBe(ws.repo);
    expect(result.payload.worktrees).toHaveLength(1);
  });

  it('needs a repository, and says so in the marker when it cannot find one', async () => {
    expect((await run(commandWorktreeList, {}, 'WORKTREE_LIST_JSON')).code).toBe(2);
    const missing = await run(commandWorktreeList, { repo: 'nowhere' }, 'WORKTREE_LIST_JSON');
    expect(missing.code).toBe(1);
    expect(missing.payload.error).toContain('Target repository not found');
  });
});

describe('worktree-remove', () => {
  it('removes a clean checkout and keeps the branch', async () => {
    const result = await run(commandWorktreeRemove, { repo: 'app', path: task.workPath }, 'WORKTREE_REMOVE_JSON');

    expect(result).toMatchObject({ code: 0, payload: { removed: true } });
    expect(fs.existsSync(task.workPath)).toBe(false);
    expect(ws.git('branch', '--list', task.branch)).toContain(task.branch);
  });

  it('keeps one with changes unless forced, and says why', async () => {
    fs.writeFileSync(path.join(task.workPath, 'wip.txt'), 'x\n');

    const kept = await run(commandWorktreeRemove, { repo: 'app', path: task.workPath }, 'WORKTREE_REMOVE_JSON');
    expect(kept.code).toBe(1);
    expect(kept.payload).toMatchObject({ removed: false, reason: 'dirty' });
    expect(fs.existsSync(task.workPath)).toBe(true);

    const forced = await run(commandWorktreeRemove, { repo: 'app', path: task.workPath, force: true }, 'WORKTREE_REMOVE_JSON');
    expect(forced).toMatchObject({ code: 0, payload: { removed: true } });
  });

  it('refuses a path that is not a checkout of the factory\'s', async () => {
    const result = await run(commandWorktreeRemove, { repo: 'app', path: ws.repo, force: true }, 'WORKTREE_REMOVE_JSON');

    expect(result.code).toBe(1);
    expect(result.payload).toMatchObject({ removed: false, reason: 'not-ours' });
    expect(fs.existsSync(path.join(ws.repo, '.git'))).toBe(true);
  });

  it('needs both flags', async () => {
    expect((await run(commandWorktreeRemove, { repo: 'app' }, 'WORKTREE_REMOVE_JSON')).code).toBe(2);
    expect((await run(commandWorktreeRemove, { path: task.workPath }, 'WORKTREE_REMOVE_JSON')).code).toBe(2);
  });
});

describe('worktree-gc', () => {
  it('removes the checkouts whose pull request is over, and only those', async () => {
    const other = await deliverTask(ws, { taskId: 'f0002', number: 9, phases: false });
    await setPullRequestState(`${ws.repo}#8`, 'MERGED');

    const result = await run(commandWorktreeGc, { repo: 'app' }, 'WORKTREE_GC_JSON');

    expect(result.payload).toEqual({ removed: [task.workPath], kept: [] });
    expect(fs.existsSync(task.workPath)).toBe(false);
    expect(fs.existsSync(other.workPath)).toBe(true); // its pull request is still open
  });

  it('keeps a stale checkout that has uncommitted work, and lists why', async () => {
    fs.writeFileSync(path.join(task.workPath, 'wip.txt'), 'x\n');
    await setPullRequestState(`${ws.repo}#8`, 'CLOSED');

    const result = await run(commandWorktreeGc, { repo: 'app' }, 'WORKTREE_GC_JSON');

    expect(result.payload.removed).toEqual([]);
    expect(result.payload.kept).toEqual([{ path: task.workPath, message: expect.stringContaining('1 file with changes that are not committed') }]);
    expect(fs.existsSync(task.workPath)).toBe(true);
  });

  it('does nothing when no pull request is over', async () => {
    const result = await run(commandWorktreeGc, { repo: 'app' }, 'WORKTREE_GC_JSON');

    expect(result.payload).toEqual({ removed: [], kept: [] });
    expect(fs.existsSync(task.workPath)).toBe(true);
  });
});

describe('check out here', () => {
  it('moves the branch from the task\'s checkout to your repository', async () => {
    const result = await run(commandWorktreeCheckout, { repo: 'app', path: task.workPath }, 'WORKTREE_CHECKOUT_JSON');

    expect(result).toMatchObject({ code: 0, payload: { ok: true, branch: task.branch } });
    expect(branchOf(ws.repo)).toBe(task.branch);
    expect(fs.readFileSync(path.join(ws.repo, 'src', 'greeting.js'), 'utf8')).toContain('hello');
    expect(fs.existsSync(task.workPath)).toBe(false);
    expect((await listWorktrees(ws.repo)).filter((entry) => !entry.main)).toEqual([]);
  });

  it('refuses, changing nothing, when the checkout has changes that cannot come along', async () => {
    fs.writeFileSync(path.join(task.workPath, 'wip.txt'), 'x\n');

    const result = await run(commandWorktreeCheckout, { repo: 'app', path: task.workPath }, 'WORKTREE_CHECKOUT_JSON');

    expect(result.code).toBe(1);
    expect(result.payload.error).toContain('1 file with changes that are not committed, and they cannot come along');
    expect(branchOf(ws.repo)).toBe('main');
    expect(fs.existsSync(path.join(task.workPath, 'wip.txt'))).toBe(true);
  });

  it('refuses, changing nothing, when your repository has changes of its own', async () => {
    fs.writeFileSync(path.join(ws.repo, 'README.md'), '# editing\n');

    const result = await run(commandWorktreeCheckout, { repo: 'app', path: task.workPath }, 'WORKTREE_CHECKOUT_JSON');

    expect(result.code).toBe(1);
    expect(result.payload.error).toContain('Your repository has changes that are not committed');
    expect(branchOf(ws.repo)).toBe('main');
    expect(fs.existsSync(task.workPath)).toBe(true);
    expect(fs.readFileSync(path.join(ws.repo, 'README.md'), 'utf8')).toBe('# editing\n');
  });

  it('puts the task\'s checkout back when your repository cannot take the branch', async () => {
    fs.writeFileSync(path.join(ws.repo, '.git', 'index.lock'), ''); // another git process is working in it

    const result = await checkoutHere({ mainRepoPath: ws.repo, path: task.workPath });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(`Could not check out ${task.branch} in your repository`);
    expect(!result.ok && result.error).toContain("The task's checkout was put back");
    fs.rmSync(path.join(ws.repo, '.git', 'index.lock'));
    expect(fs.existsSync(path.join(task.workPath, 'src', 'greeting.js'))).toBe(true);
    expect(branchOf(task.workPath)).toBe(task.branch);
    expect(branchOf(ws.repo)).toBe('main');
  });

  it('will not touch a folder git does not know as a checkout, even one in the right place', async () => {
    const orphan = worktreePathFor(ws.repo, 'f0099');
    fs.mkdirSync(orphan, { recursive: true });

    const result = await checkoutHere({ mainRepoPath: ws.repo, path: orphan });

    expect(result).toEqual({ ok: false, error: expect.stringContaining('is not a checkout of app (any more), so it was left alone') });
    expect(fs.existsSync(orphan)).toBe(true);
  });

  it('will not move anything but the factory\'s own checkouts', async () => {
    expect(await checkoutHere({ mainRepoPath: ws.repo, path: ws.repo })).toEqual({ ok: false, error: expect.stringContaining('is not in the folder where the factory keeps its checkouts') });
  });

  it('says so when the checkout is already gone, and points at the branch', async () => {
    fs.rmSync(task.workPath, { recursive: true, force: true });
    ws.git('worktree', 'prune');

    const result = await checkoutHere({ mainRepoPath: ws.repo, path: task.workPath });

    expect(result.ok).toBe(false);
  });
});
