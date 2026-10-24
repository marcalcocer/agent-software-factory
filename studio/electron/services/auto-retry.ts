/**
 * Retrying a run by itself once Claude's usage limit is back.
 *
 * When a run stops because the subscription's usage limit was reached, the factory records when the limit
 * resets (`summary.json` → `usageLimit`). The Studio then plans a retry for a minute after that moment and,
 * when the moment comes, resumes the run: from the step that failed, keeping the plan and every finished
 * step (the same as pressing "Retry run").
 *
 * The plan is a file in the run directory (`auto-retry.json`), so it survives a restart of the Studio: a
 * retry that fell due while the Studio was closed happens when it opens again. The clock is checked every
 * few seconds against the wall time, so a laptop that slept through the moment still retries on waking.
 *
 * This file holds the decisions (pure) and the file handling; `ipc/factory.ts` wires them to the processes.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { AutoRetryState, FactoryRun } from '../../shared/types';

export const AUTO_RETRY_FILE = 'auto-retry.json';

/** Retry this long after the reset: the window has to be open on Anthropic's side too. */
export const RETRY_MARGIN_MS = 60_000;
/** When the reset time is unknown, try again this often. */
export const UNKNOWN_RESET_RETRY_MS = 30 * 60_000;
/** Never retry sooner than this, whatever the reset time says (it may already be past). */
export const MIN_DELAY_MS = 60_000;
/** Automatic retries in a row that hit the limit again before giving up and asking. */
export const MAX_TRIES = 6;
/** How often the main process looks at the clock. */
export const TICK_MS = 15_000;

export function readAutoRetry(runDir: string): AutoRetryState | null {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(runDir, AUTO_RETRY_FILE), 'utf8')) as AutoRetryState;
    return state && typeof state.status === 'string' && typeof state.retryAt === 'string' ? state : null;
  } catch {
    return null;
  }
}

export function writeAutoRetry(runDir: string, state: AutoRetryState): void {
  fs.writeFileSync(path.join(runDir, AUTO_RETRY_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function clearAutoRetry(runDir: string): void {
  fs.rmSync(path.join(runDir, AUTO_RETRY_FILE), { force: true });
}

/** When to retry, for a limit that resets at `resetsAt`. */
export function retryTimeFor(resetsAt: string | null, now: number): string {
  const reset = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  const at = Number.isNaN(reset) ? now + UNKNOWN_RESET_RETRY_MS : Math.max(reset + RETRY_MARGIN_MS, now + MIN_DELAY_MS);
  return new Date(at).toISOString();
}

/** A run the Studio can resume: a task or one of its rounds, not a pull-request triage. */
const resumable = (run: Pick<FactoryRun, 'kind'>): boolean => run.kind !== 'pr-feedback';

/**
 * What to do with a run whose process just ended.
 *
 * - It stopped on the usage limit, and retrying by itself is wanted (the setting is on, or the user armed
 *   this run's retry by hand) → plan the retry, or give up after `MAX_TRIES` automatic retries in a row.
 * - It stopped on the limit and the user cancelled, or the setting is off → leave it to the user.
 * - Anything else (it finished, it failed for another reason) → forget any plan.
 */
export function decideAfterRun(
  run: Pick<FactoryRun, 'status' | 'usageLimit' | 'kind'>,
  previous: AutoRetryState | null,
  settingOn: boolean,
  now: number,
): { action: 'schedule'; state: AutoRetryState } | { action: 'clear' } | { action: 'keep' } {
  const limited = run.status === 'FAILED' && !!run.usageLimit && resumable(run);
  if (!limited) return previous ? { action: 'clear' } : { action: 'keep' };

  // The user's own choice for this run wins over the setting.
  if (previous?.status === 'cancelled') return { action: 'keep' };
  const armed = previous?.status === 'scheduled' || previous?.status === 'retrying';
  if (!settingOn && !armed) return { action: 'keep' };

  const tries = previous?.status === 'retrying' ? previous.tries : (previous?.tries ?? 0);
  const limit = run.usageLimit!;
  const base = {
    retryAt: retryTimeFor(limit.resetsAt, now),
    resetsAt: limit.resetsAt,
    ...(limit.window ? { window: limit.window } : {}),
    tries,
    updatedAt: new Date(now).toISOString(),
  };
  return { action: 'schedule', state: { ...base, status: tries >= MAX_TRIES ? 'gave-up' : 'scheduled' } };
}

/** Arming a retry by hand (the setting is off, or it was cancelled, or it gave up): a fresh count. */
export function armRetry(run: Pick<FactoryRun, 'usageLimit'>, now: number): AutoRetryState | null {
  if (!run.usageLimit) return null;
  return {
    status: 'scheduled',
    retryAt: retryTimeFor(run.usageLimit.resetsAt, now),
    resetsAt: run.usageLimit.resetsAt,
    ...(run.usageLimit.window ? { window: run.usageLimit.window } : {}),
    tries: 0,
    updatedAt: new Date(now).toISOString(),
  };
}

/** Is a planned retry due? */
export function isDue(state: AutoRetryState | null, now: number): boolean {
  return state?.status === 'scheduled' && Date.parse(state.retryAt) <= now;
}

/** The plan once the retry is started. */
export function startedRetry(state: AutoRetryState, now: number): AutoRetryState {
  return { ...state, status: 'retrying', tries: state.tries + 1, updatedAt: new Date(now).toISOString() };
}

/** The plan put off a little, when something else is using the repository at the due time. */
export function postponed(state: AutoRetryState, now: number, byMs = 2 * 60_000): AutoRetryState {
  return { ...state, retryAt: new Date(now + byMs).toISOString(), updatedAt: new Date(now).toISOString() };
}

/** What the retry loop needs from the main process: kept apart so the loop can be tested on its own. */
export interface RetryLoopDeps {
  /** Every run directory name. */
  runIds(): string[];
  readPlan(runId: string): AutoRetryState | null;
  writePlan(runId: string, state: AutoRetryState): void;
  clearPlan(runId: string): void;
  /** The run as the Studio sees it, with the repository it works on. */
  readRun(runId: string): { run: Pick<FactoryRun, 'status' | 'isolation' | 'rootRunId'>; repoPath: string } | null;
  isActive(runId: string): boolean;
  /** Something else working in the same place, that a retry now would collide with. */
  isBusy(repoPath: string, scope: { isolation: 'worktree' | 'in-place'; rootRunId?: string }): boolean;
  /** Starts `factory resume` for the run. */
  resume(runId: string): Promise<void>;
  /** Tells the screen a run started. */
  announce(runId: string): void;
  log?(message: string, error?: unknown): void;
}

/**
 * Starts the retries that are due. A run retried by hand in the meantime (no longer failed) loses its plan;
 * one whose repository is busy is put off two minutes; one that could not be started (not signed in) is put
 * off five. Returns the runs it started.
 */
export async function runDueRetries(deps: RetryLoopDeps, now: number): Promise<string[]> {
  const started: string[] = [];
  for (const runId of deps.runIds()) {
    const plan = deps.readPlan(runId);
    if (!plan || !isDue(plan, now) || deps.isActive(runId)) continue;
    try {
      const state = deps.readRun(runId);
      if (!state || state.run.status !== 'FAILED') {
        deps.clearPlan(runId);
        continue;
      }
      const scope = { isolation: state.run.isolation ?? 'in-place', ...(state.run.rootRunId ? { rootRunId: state.run.rootRunId } : {}) } as const;
      if (deps.isBusy(state.repoPath, scope)) {
        deps.writePlan(runId, postponed(plan, now));
        continue;
      }
      deps.writePlan(runId, startedRetry(plan, now));
      deps.log?.(`[auto-retry] the usage limit is back: retrying ${runId}`);
      await deps.resume(runId);
      deps.announce(runId);
      started.push(runId);
    } catch (error) {
      deps.log?.(`[auto-retry] could not retry ${runId}`, error);
      try {
        deps.writePlan(runId, { ...postponed(plan, now, 5 * 60_000), status: 'scheduled' });
      } catch {
        // the plan stays as it was
      }
    }
  }
  return started;
}
