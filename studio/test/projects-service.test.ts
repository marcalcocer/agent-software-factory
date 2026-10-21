import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkoutWorktree,
  editProject,
  gcWorktrees,
  listProjects,
  listWorktrees,
  readPlaces,
  reconcilePhase,
  removeWorktree,
  worktreeInfoOf,
  type RunCli,
} from '../electron/services/projects';

const answer = (marker: string, payload: unknown, code = 0): RunCli => {
  const calls: string[][] = [];
  const run: RunCli = async (args) => {
    calls.push(args);
    return { code, stdout: `some log line\n${marker} ${JSON.stringify(payload)}\ntrailing noise\n`, stderr: '' };
  };
  return Object.assign(run, { calls });
};
const calls = (run: RunCli): string[][] => (run as unknown as { calls: string[][] }).calls;
const silent: RunCli = async () => ({ code: 1, stdout: '', stderr: 'Error: boom\n    at x (file.ts:1:1)\nthe real reason' });

describe('listProjects', () => {
  it('asks for the projects of one repository and reads the marker line among the log noise', async () => {
    const run = answer('INITIATIVE_LIST_JSON', { repoPath: '/w/r', initiatives: [{ id: 'i0001', title: 'Redesign', phases: [] }] });

    expect(await listProjects(run, '/w/r')).toEqual([{ id: 'i0001', title: 'Redesign', phases: [] }]);
    expect(calls(run)).toEqual([['initiative-list', '--repo', '/w/r']]);
  });

  it('says why when the factory could not answer - its own reason, or the last meaningful line it printed', async () => {
    await expect(listProjects(answer('INITIATIVE_LIST_JSON', { error: 'Target repository not found: /w/x' }, 1), '/w/x')).rejects.toThrow('Target repository not found: /w/x');
    await expect(listProjects(silent, '/w/x')).rejects.toThrow('the real reason');
  });
});

describe('editProject', () => {
  it('sends the edit as one argument whatever it contains, and returns the project as it is now', async () => {
    const edit = { title: 'A = B', phases: [{ id: 'i0001-p2', status: 'SKIPPED' as const }] };
    const run = answer('INITIATIVE_EDIT_JSON', { initiative: { id: 'i0001', title: 'A = B', phases: [] } });

    expect((await editProject(run, 'i0001', edit)).title).toBe('A = B');
    expect(calls(run)[0]).toEqual(['initiative-edit', '--initiative', 'i0001', `--patch=${JSON.stringify(edit)}`]);
  });

  it('passes the reason it was refused to the user, word for word', async () => {
    const run = answer('INITIATIVE_EDIT_JSON', { error: 'Phase 1 ("Foundation") is merged: it cannot be made skipped by hand.' }, 1);

    await expect(editProject(run, 'i0001', { phases: [{ id: 'i0001-p1', status: 'SKIPPED' }] })).rejects.toThrow('is merged: it cannot be made skipped by hand.');
  });
});

describe('reconcilePhase', () => {
  const report = { summary: 'Delivered.', changes: [], backlogAdded: 0, source: 'agent' };

  it('returns what the factory concluded, and passes force and dry-run on', async () => {
    const run = answer('PHASE_RECONCILE_JSON', { report });

    expect(await reconcilePhase(run, 'i0001-p1', { force: true, dryRun: true })).toEqual(report);
    expect(calls(run)[0]).toEqual(['phase-reconcile', '--phase', 'i0001-p1', '--force', '--dry-run']);
  });

  it('returns null when there was nothing to do - the phase is not merged, or it was done already', async () => {
    expect(await reconcilePhase(answer('PHASE_RECONCILE_JSON', { report: null }), 'i0001-p1')).toBeNull();
  });
});

describe('readPlaces', () => {
  it('asks the factory where it works, and reads the marker line among the log noise', async () => {
    const places = { workspaceRoot: '/w', worktreesDir: '/w/.factory/worktrees', extraRepositories: ['/p/invest-track'], volatile: false };
    const run = answer('PLACES_JSON', places);

    expect(await readPlaces(run)).toEqual(places);
    expect(calls(run)).toEqual([['places']]);
  });

  it('says why when the factory gave no answer', async () => {
    await expect(readPlaces(silent)).rejects.toThrow('the real reason');
  });
});

describe('checkouts', () => {
  it('lists them', async () => {
    const run = answer('WORKTREE_LIST_JSON', { repoPath: '/w/r', worktrees: [{ path: '/w/.factory/worktrees/r/f0001', taskId: 'f0001', stale: false }] });

    expect(await listWorktrees(run, '/w/r')).toHaveLength(1);
    expect(calls(run)[0]).toEqual(['worktree-list', '--repo', '/w/r']);
  });

  it('removes one, and a refusal is an answer - the reason is for the user, not an error', async () => {
    const refused = answer('WORKTREE_REMOVE_JSON', { removed: false, reason: 'dirty', message: 'The checkout at /x has 2 files with changes that are not committed, so it was kept.' }, 1);

    expect(await removeWorktree(refused, '/w/r', '/x')).toEqual({ removed: false, message: 'The checkout at /x has 2 files with changes that are not committed, so it was kept.' });
    expect(calls(refused)[0]).toEqual(['worktree-remove', '--repo', '/w/r', '--path', '/x']);

    const forced = answer('WORKTREE_REMOVE_JSON', { removed: true });
    expect(await removeWorktree(forced, '/w/r', '/x', { force: true })).toEqual({ removed: true });
    expect(calls(forced)[0]).toContain('--force');
  });

  it('moves a branch to the user\'s repository, or says why not', async () => {
    expect(await checkoutWorktree(answer('WORKTREE_CHECKOUT_JSON', { ok: true, branch: 'factory/f0001/feat-x' }), '/w/r', '/x')).toEqual({ ok: true, branch: 'factory/f0001/feat-x' });
    expect(await checkoutWorktree(answer('WORKTREE_CHECKOUT_JSON', { ok: false, error: 'Your repository has changes that are not committed.' }, 1), '/w/r', '/x')).toEqual({
      ok: false,
      error: 'Your repository has changes that are not committed.',
    });
  });

  it('cleans up the ones whose pull request is over, and lists what it kept', async () => {
    const run = answer('WORKTREE_GC_JSON', { removed: ['/a'], kept: [{ path: '/b', message: 'kept' }] });

    expect(await gcWorktrees(run, '/w/r')).toEqual({ removed: ['/a'], kept: [{ path: '/b', message: 'kept' }] });
  });

  it('says what went wrong when the factory printed no answer at all', async () => {
    await expect(removeWorktree(silent, '/w/r', '/x')).rejects.toThrow('the real reason');
    await expect(checkoutWorktree(silent, '/w/r', '/x')).rejects.toThrow('the real reason');
  });
});

describe('worktreeInfoOf', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
  const folder = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-wt-'));
    dirs.push(dir);
    return dir;
  };

  it('says where a task works, on which branch, and how many files have changes - for a checkout', async () => {
    const checkout = folder();

    expect(await worktreeInfoOf({ runId: 'R1', isolation: 'worktree', workPath: checkout, branch: 'factory/f0001/feat-x' }, '/w/r', async () => 3)).toEqual({
      runId: 'R1', isolation: 'worktree', path: checkout, branch: 'factory/f0001/feat-x', exists: true, changedFiles: 3,
    });
  });

  it('says a checkout is gone once it is, without asking git about a folder that is not there', async () => {
    let asked = false;
    const info = await worktreeInfoOf({ runId: 'R1', isolation: 'worktree', workPath: '/nowhere/f0001', branch: 'b' }, '/w/r', async () => ((asked = true), 9));

    expect(info).toMatchObject({ exists: false, changedFiles: 0 });
    expect(asked).toBe(false);
  });

  it('is the repository for a run that worked there, and does not count the user\'s own changes as the task\'s', async () => {
    const repo = folder();

    expect(await worktreeInfoOf({ runId: 'R1', isolation: 'in-place', workPath: repo, branch: 'b' }, repo, async () => 7)).toMatchObject({ isolation: 'in-place', path: repo, exists: true, changedFiles: 0 });
  });

  it('reads a run from before checkouts existed as one that worked in the repository', async () => {
    const repo = folder();

    expect(await worktreeInfoOf({ runId: 'R1' }, repo, async () => 0)).toMatchObject({ isolation: 'in-place', path: repo, branch: null });
  });
});
