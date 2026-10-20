/**
 * What the user sees of the factory's checkouts: where each is, which task it belongs to, whether it has
 * work in it that is not committed, and whether its pull request is over (so it is no longer needed).
 *
 * Reads the run records and the pull-request registry; changes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';

import { listRuns, readArtifact } from './logger-tools.ts';
import { loadRegistry, type PullRequestState } from './pr-registry.ts';
import { inspectWorktree, isFactoryWorktree, listWorktrees, samePath, worktreesRoot } from './worktree.ts';

export interface CheckoutReport {
  path: string;
  taskId: string;
  branch: string | null;
  /** The folder is there. */
  exists: boolean;
  /** Git knows it as a checkout of the repository. A folder it does not know is left alone by every command. */
  registered: boolean;
  /** Files with changes that are not committed. */
  changedFiles: number;
  /** What the task is called. */
  title: string | null;
  rootRunId: string | null;
  pullRequest: { number: number; url: string; state: PullRequestState } | null;
  /** The task is over - its pull request was merged or closed - so the checkout is not needed. */
  stale: boolean;
}

type RunRecord = { taskId?: string; repoPath?: string; rootRunId?: string; title?: string };

/** The run that opened a task, found by the task's id (every round of a task shares it). */
function rootRunOf(mainRepoPath: string, taskId: string): { rootRunId: string; title: string | null } | null {
  for (const runId of listRuns()) {
    const meta = readArtifact(runId, 'run.json') as RunRecord | null;
    if (meta?.taskId !== taskId || (meta.repoPath && path.resolve(meta.repoPath) !== path.resolve(mainRepoPath))) continue;
    const rootRunId = meta.rootRunId ?? runId;
    const root = rootRunId === runId ? meta : (readArtifact(rootRunId, 'run.json') as RunRecord | null);
    return { rootRunId, title: root?.title ?? meta.title ?? null };
  }
  return null;
}

export async function reportCheckouts(mainRepoPath: string): Promise<CheckoutReport[]> {
  const registered = (await listWorktrees(mainRepoPath)).filter((entry) => !entry.main && isFactoryWorktree(entry.path));
  const folder = path.join(worktreesRoot(), path.basename(mainRepoPath));
  const onDisk = fs.existsSync(folder)
    ? fs.readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(folder, entry.name))
    : [];

  const paths = [...registered.map((entry) => entry.path)];
  for (const candidate of onDisk) if (!paths.some((known) => samePath(known, candidate))) paths.push(candidate);

  const registry = Object.values(loadRegistry().pullRequests).filter((entry) => path.resolve(entry.repoPath) === path.resolve(mainRepoPath));
  const reports: CheckoutReport[] = [];
  for (const checkout of paths.sort()) {
    const taskId = path.basename(checkout);
    const known = registered.find((entry) => samePath(entry.path, checkout));
    // A folder git does not know is not inspected: `git status` there would answer for whatever contains it.
    const state = known ? await inspectWorktree(checkout) : { exists: fs.existsSync(checkout), branch: null, changedFiles: 0 };
    const root = rootRunOf(mainRepoPath, taskId);
    const pr = root ? registry.find((entry) => entry.rootRunId === root.rootRunId) : undefined;
    reports.push({
      path: checkout,
      taskId,
      branch: known?.branch ?? state.branch,
      exists: state.exists,
      registered: Boolean(known),
      changedFiles: state.changedFiles,
      title: root?.title ?? null,
      rootRunId: root?.rootRunId ?? null,
      pullRequest: pr ? { number: pr.number, url: pr.url, state: pr.state } : null,
      stale: pr !== undefined && pr.state !== 'OPEN',
    });
  }
  return reports;
}
