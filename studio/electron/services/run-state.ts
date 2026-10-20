/**
 * Derives what the UI needs to know about a run from what it left on disk.
 *
 * Kept free of Electron imports so it can be exercised directly against real run directories.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FactoryRun, RunArtifact, RunEventRecord, RunStatus } from '../../shared/types';
import { inferInterruption } from '../../shared/runInference';

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** The factory's structured audit trail (`events.ndjson`) in a run directory. */
export function readRunEvents(runDir: string): RunEventRecord[] {
  const file = path.join(runDir, 'events.ndjson');
  if (!fs.existsSync(file)) return [];
  const events: RunEventRecord[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as RunEventRecord);
    } catch {
      // A torn last line while the factory is mid-write: skip it.
    }
  }
  return events;
}

/**
 * Gives a run a name of the user's choosing: written into `run.json`, which is where the factory keeps
 * the title, and marked as the user's so nothing the factory does afterwards replaces it.
 */
export function renameRun(runDir: string, title: string): void {
  const file = path.join(runDir, 'run.json');
  const meta = readJson<Record<string, unknown>>(file);
  if (!meta) throw new Error('This run has no record to rename.');
  fs.writeFileSync(file, `${JSON.stringify({ ...meta, title, titleSource: 'user' }, null, 2)}\n`, 'utf8');
}

/**
 * The step artifacts (`01-pm-architect.json`, `02-developer.attempt-2.json`, ...) of a run
 * directory, in file-name order. A file that cannot be read - torn while the factory writes it - is
 * skipped rather than failing the whole read.
 */
export function readRunArtifacts(runDir: string): RunArtifact[] {
  if (!fs.existsSync(runDir)) return [];
  const artifacts: RunArtifact[] = [];
  try {
    const files = fs
      .readdirSync(runDir)
      .filter((file) => /^\d{2}-.*\.json$/.test(file))
      .sort();
    for (const file of files) {
      const raw = readJson<any>(path.join(runDir, file));
      if (!raw) continue;
      artifacts.push({
        step: raw.step,
        attempt: raw.attempt ?? 1,
        status: raw.status,
        model: raw.model,
        durationMs: raw.durationMs,
        writtenAt: raw.writtenAt,
        data: raw.data ?? {},
      });
    }
  } catch {
    return [];
  }
  return artifacts;
}

/**
 * Everything the UI needs to know about a run.
 *
 * Precedence: a live process beats everything (a retry must not look failed because of the
 * previous attempt's summary), then an open human gate, then the recorded outcome, then a
 * recorded process failure, and finally an inference of where an unexplained stop happened.
 * `factory:list` and `factory:get` used to disagree about the same run (one said FAILED, the
 * other RUNNING) because only the list knew about live processes.
 *
 * @param alive whether the Electron main process currently holds a live process for the run.
 */
export function readRunState(
  runDir: string,
  runId: string,
  alive: boolean,
): { run: FactoryRun; repoPath: string } | null {
  const summary = readJson<any>(path.join(runDir, 'summary.json'));
  const meta = readJson<any>(path.join(runDir, 'run.json'));
  if (!summary && !meta) return null;

  const repoPath: string = summary?.repository || meta?.repoPath || meta?.repository || '';
  const suspended = fs.existsSync(path.join(runDir, 'pending-input.json'));

  let status: RunStatus;
  let error: string | undefined;
  let failedStep: string | undefined;
  let finishedAt: string | undefined;

  if (alive) {
    status = 'RUNNING';
  } else if (suspended) {
    status = 'SUSPENDED';
  } else if (summary && !(summary.status === 'FAILED' && !summary.error)) {
    status = summary.status;
    error = summary.error || undefined;
    failedStep = summary.failedStep || undefined;
    finishedAt = summary.finishedAt;
  } else {
    // No outcome was recorded: the process died hard, or an older run failed silently.
    status = 'FAILED';
    const failure = readJson<{ at?: string; message?: string }>(path.join(runDir, 'failure.json'));
    const events = readRunEvents(runDir);
    if (failure?.message) {
      error = failure.message;
      finishedAt = failure.at;
    } else {
      const interruption = inferInterruption(events);
      error = interruption.message;
      failedStep = interruption.failedStep;
    }
    finishedAt = finishedAt ?? events[events.length - 1]?.at ?? summary?.finishedAt;
  }

  return {
    repoPath,
    run: {
      runId,
      repoId: path.basename(repoPath),
      task: summary?.task || meta?.task || '',
      // run.json first: it is where a rename is written, and the summary is a snapshot from the end.
      ...(meta?.title || summary?.title ? { title: String(meta?.title || summary?.title) } : {}),
      ...(meta?.titleSource ? { titleSource: meta.titleSource } : {}),
      ...(meta?.taskId || summary?.taskId ? { taskId: String(meta?.taskId || summary?.taskId) } : {}),
      // Where the work happens. A run from before checkouts existed (no record of it) worked in the repository.
      isolation: meta?.isolation === 'worktree' ? 'worktree' : 'in-place',
      workPath: String((meta?.isolation === 'worktree' && meta?.workPath) || repoPath),
      ...(meta?.initiativeId || summary?.initiativeId ? { initiativeId: String(meta?.initiativeId || summary?.initiativeId) } : {}),
      ...(meta?.phaseId || summary?.phaseId ? { phaseId: String(meta?.phaseId || summary?.phaseId) } : {}),
      status,
      attempts: summary?.attempts || 0,
      branch: summary?.branch ?? meta?.branch,
      startedAt: summary?.startedAt || meta?.startedAt || new Date().toISOString(),
      finishedAt: status === 'RUNNING' || status === 'SUSPENDED' ? undefined : finishedAt,
      tokens: summary?.tokens,
      gates: summary?.gates,
      steps: summary?.steps || [],
      error,
      failedStep,
      pipeline: meta?.pipeline,
      // How this run relates to others (a round on a pull request continues an earlier run).
      kind: summary?.kind ?? meta?.kind ?? 'run',
      rootRunId: summary?.rootRunId ?? meta?.rootRunId ?? runId,
      ...(summary?.parentRunId || meta?.parentRunId
        ? { parentRunId: summary?.parentRunId ?? meta?.parentRunId }
        : {}),
      round: summary?.round ?? meta?.round ?? 1,
      ...(meta?.pullRequest ? { pullRequest: meta.pullRequest } : {}),
    },
  };
}
