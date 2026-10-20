/**
 * What happens when a pull request stops being open - through the real `mergePullRequest` and
 * `checkPullRequests`, a real repository with a real checkout, and a `gh` that talks to a file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withStore } from '../src/initiatives/store.ts';
import { loadRegistry, pullRequestKey } from '../src/tools/pr-registry.ts';
import { settlePullRequest } from '../src/tools/pr-lifecycle.ts';
import { mergePullRequest } from '../src/tools/pr-merge.ts';
import { checkPullRequests } from '../src/tools/pr-watch.ts';
import { createFakeGh, type FakeGh } from './support/fake-gh.ts';
import { deliverTask, createWorkspaceRepo, type DeliveredTask, type WorkspaceRepo } from './support/git-repo.ts';

let ws: WorkspaceRepo;
let logs: string;
let gh: FakeGh;
let uninstall: () => void;
let task: DeliveredTask;

beforeEach(async () => {
  ws = createWorkspaceRepo();
  logs = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-lifecycle-'));
  vi.stubEnv('FACTORY_WORKSPACE_ROOT', ws.workspace);
  vi.stubEnv('FACTORY_LOG_DIR', logs);
  vi.stubEnv('FACTORY_ALLOW_PUSH', 'true');
  task = await deliverTask(ws);
  gh = createFakeGh({ headBranch: task.branch, headSha: task.headSha });
  uninstall = gh.install();
});
afterEach(() => {
  uninstall();
  gh.cleanup();
  ws.cleanup();
  fs.rmSync(logs, { recursive: true, force: true });
});

const merge = (overrides: Partial<Parameters<typeof mergePullRequest>[0]> = {}) =>
  mergePullRequest({ repoPath: ws.repo, number: 8, expectedHeadSha: task.headSha, subject: 'feat: add a greeting helper', body: '', deleteBranch: true, returnToBase: true, ...overrides });
const phases = async () => (await withStore((store) => store.getInitiative(task.initiativeId)))!.phases;
const localBranches = () => ws.git('branch', '--list', '--format=%(refname:short)').split('\n').filter(Boolean);
const branchOf = (cwd: string) => ws.gitIn(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim();

describe('merging from the Studio', () => {
  it('removes the checkout BEFORE it deletes the local branch - git will not delete a branch that is checked out', async () => {
    expect(localBranches()).toContain(task.branch);
    expect(fs.existsSync(task.workPath)).toBe(true);

    const outcome = await merge();

    expect(outcome.merged).toBe(true);
    expect(fs.existsSync(task.workPath)).toBe(false);
    expect(localBranches()).not.toContain(task.branch);
    expect(outcome.notes).toContain(`Deleted the local branch ${task.branch}.`);
    expect(outcome.notes.join(' ')).not.toContain('Could not delete the local branch');
    // The call order, as GitHub saw it: merged, then the remote branch went.
    const verbs = gh.calls().map((call) => call.slice(0, 2).join(' '));
    expect(verbs.indexOf('pr merge')).toBeGreaterThan(-1);
    expect(verbs.indexOf('pr merge')).toBeLessThan(verbs.findIndex((verb) => verb === 'api -X'));
  });

  it('moves the project on: the phase is delivered, and the outcome says what is next', async () => {
    const outcome = await merge();

    expect((await phases()).map((phase) => phase.status)).toEqual(['MERGED', 'PLANNED', 'PLANNED']);
    expect(outcome.phase).toMatchObject({
      initiativeId: task.initiativeId, phaseId: `${task.initiativeId}-p1`, ordinal: 1, total: 3, title: 'Greeting helper',
      merged: true, alreadySettled: false, initiativeDone: false,
      next: { phaseId: `${task.initiativeId}-p2`, ordinal: 2, title: 'Use it in the entry point' },
    });
    expect((await phases())[0]).toMatchObject({ mergedSha: gh.state().mergeCommit });
    expect(loadRegistry().pullRequests[pullRequestKey(ws.repo, 8)]).toMatchObject({ state: 'MERGED' });
  });

  it('never touches the user\'s repository, and says when its main is behind GitHub\'s now', async () => {
    fs.writeFileSync(path.join(ws.repo, 'README.md'), '# being edited\n');
    ws.pushFromElsewhere('main', 'src/from-teammate.js', 'module.exports = 1;\n'); // GitHub moved on

    const outcome = await merge();

    expect(branchOf(ws.repo)).toBe('main');
    expect(fs.readFileSync(path.join(ws.repo, 'README.md'), 'utf8')).toBe('# being edited\n');
    expect(fs.existsSync(path.join(ws.repo, 'src', 'from-teammate.js'))).toBe(false);
    expect(outcome.notes.join(' ')).toContain('main on GitHub now has the merged change; your local main does not yet. Your repository was not touched');
  });

  it('is quiet about the user\'s main when it is up to date', async () => {
    const outcome = await merge();

    expect(outcome.notes.join(' ')).not.toContain('your local main does not yet');
  });

  it('keeps a checkout that has uncommitted work, says so, and does not try to delete the branch under it', async () => {
    fs.writeFileSync(path.join(task.workPath, 'wip.txt'), 'not committed\n');

    const outcome = await merge();

    expect(outcome.merged).toBe(true);
    expect(fs.existsSync(path.join(task.workPath, 'wip.txt'))).toBe(true);
    expect(localBranches()).toContain(task.branch);
    expect(outcome.notes.join(' ')).toContain('has 1 file with changes that are not committed, so it was kept');
    expect(outcome.notes).toContain(`Kept the local branch ${task.branch}: it is still checked out at ${task.workPath}.`);
    expect(outcome.notes.join(' ')).not.toContain('Could not delete');
    // The roadmap moved on all the same: the merge happened.
    expect((await phases())[0]!.status).toBe('MERGED');
  });

  it('does not merge, and changes nothing, when GitHub refuses', async () => {
    gh.set({ mergeFails: 'Pull request is not mergeable' });

    const outcome = await merge();

    expect(outcome.merged).toBe(false);
    expect(fs.existsSync(task.workPath)).toBe(true);
    expect(localBranches()).toContain(task.branch);
    expect((await phases())[0]!.status).toBe('IN_REVIEW');
    expect(loadRegistry().pullRequests[pullRequestKey(ws.repo, 8)]!.state).toBe('OPEN');
  });

  it('does not merge a pull request that moved after it was approved', async () => {
    const outcome = await merge({ expectedHeadSha: 'f'.repeat(40) });

    expect(outcome.merged).toBe(false);
    expect(outcome.reason).toContain('changed after you approved it');
    expect(fs.existsSync(task.workPath)).toBe(true);
    expect((await phases())[0]!.status).toBe('IN_REVIEW');
  });

  it('finishes a project whose last phase this was', async () => {
    const lone = await deliverTask(ws, { taskId: 'f0002', number: 9, phases: false });
    gh.set({ number: 9, headBranch: lone.branch, headSha: lone.headSha });

    const outcome = await mergePullRequest({ repoPath: ws.repo, number: 9, expectedHeadSha: lone.headSha, subject: 'feat: x', body: '', deleteBranch: true, returnToBase: true });

    expect(outcome.phase).toMatchObject({ merged: true, total: 1, next: null, initiativeDone: true });
    expect((await withStore((store) => store.getInitiative(lone.initiativeId)))!.status).toBe('DONE');
  });
});

describe('a pull request merged or closed on GitHub', () => {
  it('is found by the next check: the phase is delivered and the checkout goes, reported once', async () => {
    gh.set({ state: 'MERGED' });

    const checked = await checkPullRequests({ repoPath: ws.repo });

    expect(checked.pullRequests).toHaveLength(1);
    expect(checked.pullRequests[0]).toMatchObject({ number: 8, state: 'MERGED', pending: [] });
    expect(checked.pullRequests[0]!.settled?.phase).toMatchObject({ merged: true, ordinal: 1, next: { ordinal: 2 } });
    expect((await phases())[0]!.status).toBe('MERGED');
    expect(fs.existsSync(task.workPath)).toBe(false);
    expect(localBranches()).toContain(task.branch); // the branch is the work: only the folder goes

    // Nothing is watched any more, so the same news is not delivered twice.
    expect((await checkPullRequests({ repoPath: ws.repo })).pullRequests).toEqual([]);
  });

  it('puts a phase back in the roadmap when its pull request is closed without merging', async () => {
    gh.set({ state: 'CLOSED' });

    const checked = await checkPullRequests({ repoPath: ws.repo });

    expect(checked.pullRequests[0]).toMatchObject({ state: 'CLOSED' });
    expect(checked.pullRequests[0]!.settled?.phase).toMatchObject({ merged: false, ordinal: 1 });
    const [first] = await phases();
    expect(first).toMatchObject({ status: 'PLANNED', prNumber: null });
    expect(fs.existsSync(task.workPath)).toBe(false);
    expect(localBranches()).toContain(task.branch);
  });

  it('treats a pull request that no longer exists as closed', async () => {
    gh.set({ viewFails: 'GraphQL: Could not resolve to a PullRequest with the number of 8.' });

    const checked = await checkPullRequests({ repoPath: ws.repo });

    expect(checked.pullRequests[0]).toMatchObject({ state: 'CLOSED' });
    expect((await phases())[0]!.status).toBe('PLANNED');
    expect(fs.existsSync(task.workPath)).toBe(false);
  });

  it('keeps a checkout with uncommitted work and tells the user, without failing the check', async () => {
    fs.writeFileSync(path.join(task.workPath, 'wip.txt'), 'x\n');
    gh.set({ state: 'MERGED' });

    const checked = await checkPullRequests({ repoPath: ws.repo });

    expect(checked.pullRequests[0]!.error).toBeUndefined();
    expect(checked.pullRequests[0]!.settled?.notes.join(' ')).toContain('was kept');
    expect(fs.existsSync(task.workPath)).toBe(true);
    expect((await phases())[0]!.status).toBe('MERGED');
  });

  it('does nothing to a pull request that is still open', async () => {
    const checked = await checkPullRequests({ repoPath: ws.repo });

    expect(checked.pullRequests[0]).toMatchObject({ state: 'OPEN' });
    expect(checked.pullRequests[0]!.settled).toBeUndefined();
    expect(fs.existsSync(task.workPath)).toBe(true);
    expect((await phases())[0]!.status).toBe('IN_REVIEW');
  });
});

describe('settlePullRequest', () => {
  const settle = (state: 'MERGED' | 'CLOSED' = 'MERGED') => settlePullRequest({ repoPath: ws.repo, number: 8, state });

  it('is the same asked twice: nothing more happens, and the history does not grow', async () => {
    const first = await settle();
    const eventsAfterFirst = (await withStore((store) => store.listEvents(task.initiativeId))).length;
    const second = await settle();

    expect(first.phase).toMatchObject({ alreadySettled: false, merged: true });
    expect(second.phase).toMatchObject({ alreadySettled: true, merged: true, next: { ordinal: 2 } });
    expect(second.checkout).toMatchObject({ removed: true });
    expect((await withStore((store) => store.listEvents(task.initiativeId))).length).toBe(eventsAfterFirst);
  });

  it('does not take a merged phase back to the roadmap because a late "closed" arrives', async () => {
    await settle('MERGED');
    await settle('CLOSED');

    expect((await phases())[0]!.status).toBe('MERGED');
  });

  it('has nothing to do for a pull request the factory does not know', async () => {
    const result = await settlePullRequest({ repoPath: ws.repo, number: 77, state: 'MERGED' });

    expect(result).toEqual({ phase: null, checkout: null, notes: [] });
    expect(fs.existsSync(task.workPath)).toBe(true);
  });

  it('leaves alone a task that worked in place: there is no checkout to remove', async () => {
    const meta = JSON.parse(fs.readFileSync(path.join(logs, task.runId, 'run.json'), 'utf8'));
    fs.writeFileSync(path.join(logs, task.runId, 'run.json'), JSON.stringify({ ...meta, isolation: 'in-place', workPath: ws.repo }));

    const result = await settle();

    expect(result.checkout).toBeNull();
    expect(fs.existsSync(path.join(ws.repo, '.git'))).toBe(true);
    expect(fs.existsSync(task.workPath)).toBe(true);
  });

  it('will not remove a folder that is not one of its own checkouts, whatever a run record says', async () => {
    const meta = JSON.parse(fs.readFileSync(path.join(logs, task.runId, 'run.json'), 'utf8'));
    const stray = path.join(ws.workspace, 'precious');
    fs.mkdirSync(stray);
    fs.writeFileSync(path.join(stray, 'keep.txt'), 'x\n');
    fs.writeFileSync(path.join(logs, task.runId, 'run.json'), JSON.stringify({ ...meta, workPath: stray }));

    const result = await settle();

    expect(result.checkout).toMatchObject({ path: stray, removed: false });
    expect(fs.readFileSync(path.join(stray, 'keep.txt'), 'utf8')).toBe('x\n');
  });

  it('still moves the project on when the checkout cannot be removed, and still says what happened to it', async () => {
    fs.writeFileSync(path.join(task.workPath, 'wip.txt'), 'x\n');

    const result = await settle();

    expect(result.phase).toMatchObject({ merged: true });
    expect(result.checkout).toMatchObject({ removed: false });
    expect(result.notes).toHaveLength(1);
  });

  it('does not fail when the roadmap cannot be opened - it says so, and carries on', async () => {
    // A log directory that is under a regular file can neither hold a database nor be created.
    const blocker = path.join(logs, 'blocker');
    fs.writeFileSync(blocker, 'a file where a folder should be');
    vi.stubEnv('FACTORY_LOG_DIR', path.join(blocker, 'logs'));

    const result = await settle();

    expect(result.phase).toBeNull();
    expect(result.notes.join(' ')).toContain('The project roadmap could not be updated');
  });
});
