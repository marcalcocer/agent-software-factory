/**
 * Run manager service - handles concurrent factory runs.
 * 
 * TODO: Implement full run orchestration, streaming, and state management.
 */

export interface ActiveRun {
  runId: string;
  repoPath: string;
  task: string;
  status: 'running' | 'paused' | 'completed' | 'failed';
  startedAt: Date;
}

const activeRuns = new Map<string, ActiveRun>();

export function getActiveRuns(): ActiveRun[] {
  return Array.from(activeRuns.values());
}

export function registerRun(run: ActiveRun): void {
  activeRuns.set(run.runId, run);
}

export function unregisterRun(runId: string): void {
  activeRuns.delete(runId);
}

export function getRun(runId: string): ActiveRun | undefined {
  return activeRuns.get(runId);
}
