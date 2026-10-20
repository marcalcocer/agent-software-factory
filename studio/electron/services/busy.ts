/**
 * Which running run is in the way of one about to start.
 *
 * A task used to take the whole repository: it switched the branch the user was on, so nothing else could
 * run there. A task that works in a checkout of its own does not use the repository at all, so it is only
 * in the way of another run of the SAME task (they share that one checkout); only a task that works in
 * the user's own repository still needs the repository to itself.
 *
 * Pure: the caller gathers what is running; this decides.
 */
import path from 'node:path';

import type { BusyRun, BusyScope } from './pr-watcher';

/** A run that is going, or parked at a human gate - and what is known of it. */
export interface RunProbe {
  runId: string;
  reason: 'running' | 'waiting';
  /** `null`: the process has only just started and has not written its record yet. */
  info: {
    repoPath: string;
    /** A run from before checkouts existed worked in place. */
    isolation: 'worktree' | 'in-place';
    rootRunId?: string | undefined;
    task?: string | undefined;
  } | null;
}

const samePath = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);

export function conflictingRun(probes: readonly RunProbe[], repoPath: string, scope: BusyScope): BusyRun | null {
  for (const probe of probes) {
    const found = (task?: string): BusyRun => ({ runId: probe.runId, reason: probe.reason, ...(task ? { task } : {}) });

    if (!probe.info) {
      // Just started: nothing is known about it. It might be anything, so it is in the way of whatever
      // could collide with it - a run in the user's repository, a further round - but not of a brand-new
      // task in a checkout of its own, which cannot share anything with it.
      if (scope.isolation === 'in-place' || scope.rootRunId !== undefined) return found();
      continue;
    }

    if (!probe.info.repoPath || !samePath(probe.info.repoPath, repoPath)) continue;
    const sameTask = scope.rootRunId !== undefined && probe.info.rootRunId === scope.rootRunId;
    const sameFolder = scope.isolation === 'in-place' && probe.info.isolation === 'in-place';
    if (sameTask || sameFolder) return found(probe.info.task);
  }
  return null;
}
