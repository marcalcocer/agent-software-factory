/**
 * What the Studio asks the factory about projects (a big request split into phases) and the checkouts its
 * tasks work in.
 *
 * The factory CLI is the only thing that opens the project database - the Studio runs on Electron's own
 * Node, which a native database module would have to be built for - so every question is a command that
 * prints one marker line. These functions run the command and read that line; they take the way to run
 * the CLI as an argument, so they are tested without one.
 */
import fs from 'node:fs';

import type { PhaseReconcileReport, Places, Project, ProjectEdit, WorktreeInfo, WorktreeReport } from '../../shared/types';
import { parseMarkerLine, summarizeFailure, type CliResult } from './pr-watcher';

export type RunCli = (args: string[], options?: { timeoutMs?: number }) => Promise<CliResult>;

/** The payload of a marker line, or the reason the command gave none. */
function payloadOf<T extends { error?: string }>(result: CliResult, marker: string): T {
  const payload = parseMarkerLine<T>(result.stdout, marker);
  if (!payload) throw new Error(summarizeFailure(result));
  if (payload.error) throw new Error(payload.error);
  return payload;
}

/* ---- projects ---- */

export async function listProjects(runCli: RunCli, repoPath: string): Promise<Project[]> {
  const result = await runCli(['initiative-list', '--repo', repoPath]);
  return payloadOf<{ initiatives: Project[]; error?: string }>(result, 'INITIATIVE_LIST_JSON').initiatives ?? [];
}

/** Changes a roadmap. The factory refuses what would rewrite history, and says why in the error. */
export async function editProject(runCli: RunCli, projectId: string, edit: ProjectEdit): Promise<Project> {
  // `--patch=<json>`: one argument whatever the JSON contains.
  const result = await runCli(['initiative-edit', '--initiative', projectId, `--patch=${JSON.stringify(edit)}`]);
  const payload = payloadOf<{ initiative: Project; error?: string }>(result, 'INITIATIVE_EDIT_JSON');
  if (!payload.initiative) throw new Error(summarizeFailure(result));
  return payload.initiative;
}

export async function reconcilePhase(
  runCli: RunCli,
  phaseId: string,
  options: { force?: boolean; dryRun?: boolean } = {},
): Promise<PhaseReconcileReport | null> {
  const result = await runCli(
    ['phase-reconcile', '--phase', phaseId, ...(options.force ? ['--force'] : []), ...(options.dryRun ? ['--dry-run'] : [])],
    { timeoutMs: 5 * 60_000 },
  );
  return payloadOf<{ report?: PhaseReconcileReport | null; error?: string }>(result, 'PHASE_RECONCILE_JSON').report ?? null;
}

/* ---- checkouts ---- */

/**
 * Where the factory works, as the factory says it: it knows, from its environment, its `.env` file and what the
 * Studio handed it together - a guess made here would be wrong whenever one of those says something else.
 * `fixedBy` is the Studio's to say (it knows the environment it was started with), so it is added by the caller.
 */
export async function readPlaces(runCli: RunCli): Promise<Omit<Places, 'fixedBy'>> {
  const result = await runCli(['places']);
  const payload = parseMarkerLine<Omit<Places, 'fixedBy'>>(result.stdout, 'PLACES_JSON');
  if (!payload) throw new Error(summarizeFailure(result));
  return payload;
}

export async function listWorktrees(runCli: RunCli, repoPath: string): Promise<WorktreeReport[]> {
  const result = await runCli(['worktree-list', '--repo', repoPath]);
  return payloadOf<{ worktrees: WorktreeReport[]; error?: string }>(result, 'WORKTREE_LIST_JSON').worktrees ?? [];
}

/** Removing one that has changes is refused with a reason, which is an answer, not a failure. */
export async function removeWorktree(
  runCli: RunCli,
  repoPath: string,
  folder: string,
  options: { force?: boolean } = {},
): Promise<{ removed: boolean; message?: string }> {
  const result = await runCli(['worktree-remove', '--repo', repoPath, '--path', folder, ...(options.force ? ['--force'] : [])]);
  const payload = parseMarkerLine<{ removed: boolean; message?: string }>(result.stdout, 'WORKTREE_REMOVE_JSON');
  if (!payload) throw new Error(summarizeFailure(result));
  return { removed: payload.removed === true, ...(payload.message ? { message: payload.message } : {}) };
}

export async function checkoutWorktree(
  runCli: RunCli,
  repoPath: string,
  folder: string,
): Promise<{ ok: boolean; branch?: string; error?: string }> {
  const result = await runCli(['worktree-checkout', '--repo', repoPath, '--path', folder]);
  const payload = parseMarkerLine<{ ok: boolean; branch?: string; error?: string }>(result.stdout, 'WORKTREE_CHECKOUT_JSON');
  if (!payload) throw new Error(summarizeFailure(result));
  return payload;
}

export async function gcWorktrees(
  runCli: RunCli,
  repoPath: string,
): Promise<{ removed: string[]; kept: Array<{ path: string; message: string }> }> {
  const result = await runCli(['worktree-gc', '--repo', repoPath]);
  const payload = payloadOf<{ removed: string[]; kept: Array<{ path: string; message: string }>; error?: string }>(result, 'WORKTREE_GC_JSON');
  return { removed: payload.removed ?? [], kept: payload.kept ?? [] };
}

/**
 * Where a run's work is and what is in it, from the run's record and the folder itself. `countChanges`
 * answers for a folder that exists; it is a parameter so this can be tested without git.
 */
export async function worktreeInfoOf(
  run: { runId: string; isolation?: 'worktree' | 'in-place' | undefined; workPath?: string | undefined; branch?: string | undefined },
  repoPath: string,
  countChanges: (folder: string) => Promise<number>,
): Promise<WorktreeInfo> {
  const isolation = run.isolation ?? 'in-place';
  const folder = run.workPath || repoPath;
  const exists = fs.existsSync(folder);
  return {
    runId: run.runId,
    isolation,
    path: folder,
    branch: run.branch ?? null,
    exists,
    // For the user's own repository this is their business, not the task's: only a checkout's is reported.
    changedFiles: exists && isolation === 'worktree' ? await countChanges(folder) : 0,
  };
}
