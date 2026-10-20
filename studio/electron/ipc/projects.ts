/**
 * Projects (a big request split into phases) and the checkouts the factory makes for its tasks, for the
 * renderer. Thin on purpose: what the factory is asked, and how its answer is read, lives in
 * `services/projects.ts`, where it is tested.
 *
 * Every worktree channel takes a RUN id, never a path. The folder is looked up from the run's own record,
 * so a screen can only ever show, open, move or remove a checkout that belongs to a run.
 */
import { ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';

import type { PhaseReconcileReport, Project, ProjectEdit, WorktreeInfo, WorktreeReport } from '../../shared/types';
import { ensureClaudeAuth } from '../services/claude-auth.js';
import {
  checkoutWorktree,
  editProject,
  gcWorktrees,
  listProjects,
  listWorktrees,
  removeWorktree,
  worktreeInfoOf,
} from '../services/projects.js';
import { effectiveIsolation, runPhaseArgs, type PipelineSelection } from '../services/run-args.js';
import { findBusyRun, readRunState, runFactoryCli, startFactoryRun } from './factory.js';
import { loadSettings } from './settings.js';

/** How many files have changes that are not committed. A folder git cannot read counts as none. */
function countChanges(folder: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn('git', ['status', '--porcelain'], { cwd: folder });
    let out = '';
    proc.stdout?.on('data', (data) => (out += data.toString()));
    proc.on('error', () => resolve(0));
    proc.on('close', () => resolve(out.split('\n').filter((line) => line.trim() !== '').length));
  });
}

/** The run, and the repository it belongs to. A path is never taken from the renderer. */
function runOf(runId: string) {
  const state = readRunState(runId);
  if (!state) throw new Error('This run has no record, so there is no folder to act on.');
  return state;
}

/** The checkout of a run - and only a checkout: the user's own repository is never removed or moved from here. */
function checkoutOfRun(runId: string) {
  const state = runOf(runId);
  if (state.run.isolation !== 'worktree' || !state.run.workPath) {
    throw new Error('This task worked in your repository, not in a checkout of its own.');
  }
  return { repoPath: state.repoPath, folder: state.run.workPath };
}

ipcMain.handle('project:list', async (_event, repoPath: string): Promise<Project[]> => listProjects(runFactoryCli, repoPath));

ipcMain.handle(
  'project:edit',
  async (_event, projectId: string, edit: ProjectEdit): Promise<Project> => editProject(runFactoryCli, projectId, edit),
);

ipcMain.handle(
  'project:run-phase',
  async (
    _event,
    params: { repoPath: string; phaseId: string; notes?: string; isolation?: 'worktree' | 'in-place'; pipeline?: PipelineSelection },
  ): Promise<{ runId: string }> => {
    const settings = loadSettings();
    const isolation = effectiveIsolation(params.isolation, settings.global);

    // The same rule as for a task: only a run in the user's own repository needs it to itself.
    const busy = findBusyRun(params.repoPath, { isolation });
    if (busy) {
      throw new Error(
        `Another run (${busy.runId}) is ${busy.reason === 'running' ? 'still going' : 'waiting for you'} in this repository and uses the same working copy. ` +
          'Finish or close it first - or run this phase in a checkout of its own.',
      );
    }
    if (!(await ensureClaudeAuth())) throw new Error('Authentication required. Please log in to Claude CLI.');

    return await startFactoryRun(
      runPhaseArgs({
        repoPath: params.repoPath,
        phaseId: params.phaseId,
        notes: params.notes,
        maxAttempts: settings.global.defaultMaxAttempts,
        dryRun: settings.global.dryRunByDefault,
        pipeline: params.pipeline,
        isolation,
      }),
    );
  },
);

ipcMain.handle('worktree:info', async (_event, runId: string): Promise<WorktreeInfo | null> => {
  const state = readRunState(runId);
  return state ? await worktreeInfoOf(state.run, state.repoPath, countChanges) : null;
});

ipcMain.handle('worktree:open', async (_event, runId: string): Promise<void> => {
  const state = runOf(runId);
  const info = await worktreeInfoOf(state.run, state.repoPath, async () => 0);
  if (!info.exists) throw new Error('This folder is not there any more.');
  const failure = await shell.openPath(info.path); // '' on success, else the reason
  if (failure) throw new Error(failure);
});

ipcMain.handle(
  'worktree:remove',
  async (_event, runId: string, options?: { force?: boolean }): Promise<{ removed: boolean; message?: string }> => {
    const { repoPath, folder } = checkoutOfRun(runId);
    return await removeWorktree(runFactoryCli, repoPath, folder, options ?? {});
  },
);

ipcMain.handle('worktree:checkout', async (_event, runId: string): Promise<{ ok: boolean; branch?: string; error?: string }> => {
  const { repoPath, folder } = checkoutOfRun(runId);
  return await checkoutWorktree(runFactoryCli, repoPath, folder);
});

ipcMain.handle('worktree:list', async (_event, repoPath: string): Promise<WorktreeReport[]> => listWorktrees(runFactoryCli, repoPath));

ipcMain.handle('worktree:gc', async (_event, repoPath: string) => gcWorktrees(runFactoryCli, repoPath));

export type { PhaseReconcileReport };
