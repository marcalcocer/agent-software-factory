/**
 * What becomes true when a pull request stops being open.
 *
 * Two places learn that a pull request is over: `pr-merge`, when the user merges it from the Studio, and
 * `pr-check`, when it was merged or closed on GitHub. They must do the same thing, so it is done here:
 *
 *   - the phase it was is marked delivered (or, when the pull request was closed without merging, goes
 *     back to the roadmap, waiting);
 *   - the task's own checkout is removed - a clean one only; the branch stays, and a checkout is brought
 *     back from it whenever it is needed again.
 *
 * Idempotent: asking twice is the same as asking once. Never throws: it is bookkeeping after the fact that
 * matters (a merge on GitHub, a closed pull request) has already happened, and what it could not do comes
 * back as a note for the user instead of as a failure.
 */
import { withStore, type InitiativeKind, type InitiativeWithPhases, type PhaseRow } from '../initiatives/store.ts';
import { readArtifact } from './logger-tools.ts';
import { loadRegistry, pullRequestKey } from './pr-registry.ts';
import { removeWorktree } from './worktree.ts';

export interface SettleInput {
  /** The user's repository: what the pull request and the project are filed under. */
  repoPath: string;
  number: number;
  state: 'MERGED' | 'CLOSED';
  mergeCommit?: string | undefined;
  mergedAt?: string | undefined;
}

/** The phase a pull request was, and where its project stands now. */
export interface SettledPhase {
  initiativeId: string;
  /**
   * `quick` is a task that was never split into phases - a project of one phase that nobody planned. Its pull
   * request settles like any other, but there is no project to speak of: whoever shows this should not talk of
   * phases, a roadmap or a finished project for it.
   */
  kind: InitiativeKind;
  initiativeTitle: string;
  phaseId: string;
  title: string;
  ordinal: number;
  total: number;
  /** The pull request was merged (otherwise: closed, and the phase is waiting again). */
  merged: boolean;
  /** It was already known; nothing changed. */
  alreadySettled: boolean;
  /** The phase the user can start now. */
  next: { phaseId: string; ordinal: number; title: string } | null;
  /** Nothing is left to do in the project. */
  initiativeDone: boolean;
}

export interface SettleResult {
  phase: SettledPhase | null;
  /** The task's checkout, when it had one. */
  checkout: { path: string; removed: boolean; message?: string } | null;
  /** Things the user should hear, in words for them. */
  notes: string[];
}

const labelOf = (initiative: InitiativeWithPhases, phase: PhaseRow) => ({
  total: initiative.phases.filter((other) => other.status !== 'SKIPPED' || other.id === phase.id).length,
});

/** The folder a task works in, as its first run recorded it - when that is a checkout of its own. */
export function checkoutOf(rootRunId: string | undefined): string | null {
  if (!rootRunId) return null;
  const meta = readArtifact(rootRunId, 'run.json') as { isolation?: string; workPath?: string } | null;
  return meta?.isolation === 'worktree' && meta.workPath ? meta.workPath : null;
}

export async function settlePullRequest(input: SettleInput): Promise<SettleResult> {
  const result: SettleResult = { phase: null, checkout: null, notes: [] };
  const key = pullRequestKey(input.repoPath, input.number);

  /* ---- the roadmap ---- */
  try {
    result.phase = await withStore(async (store): Promise<SettledPhase | null> => {
      const phase = await store.findPhaseByPullRequest(input.repoPath, input.number);
      if (!phase) return null;

      const merged = input.state === 'MERGED';
      const already = merged ? phase.status === 'MERGED' : phase.status !== 'IN_REVIEW' && phase.status !== 'RUNNING';
      if (!already) {
        if (merged) await store.markMerged(phase.id, { sha: input.mergeCommit ?? null, at: input.mergedAt ?? null });
        else await store.markClosedUnmerged(phase.id);
      }

      const initiative = (await store.getInitiative(phase.initiativeId))!;
      const next = await store.nextPhase(initiative.id);
      const settled = initiative.phases.find((other) => other.id === phase.id) ?? phase;
      return {
        initiativeId: initiative.id,
        kind: initiative.kind,
        initiativeTitle: initiative.title,
        phaseId: phase.id,
        title: settled.title,
        ordinal: settled.ordinal,
        total: labelOf(initiative, settled).total,
        merged,
        alreadySettled: already,
        next: next ? { phaseId: next.id, ordinal: next.ordinal, title: next.title } : null,
        initiativeDone: initiative.status === 'DONE',
      };
    });
  } catch (error) {
    result.notes.push(`The project roadmap could not be updated (${(error as Error).message}). It catches up the next time the pull request is looked at.`);
  }

  /* ---- the checkout ---- */
  try {
    const entry = loadRegistry().pullRequests[key];
    const workPath = checkoutOf(entry?.rootRunId);
    if (workPath) {
      // `removeWorktree` removes only the factory's own checkouts, whatever a run record says.
      const removal = await removeWorktree({ mainRepoPath: input.repoPath, path: workPath });
      result.checkout = { path: workPath, removed: removal.removed, ...(removal.message ? { message: removal.message } : {}) };
      if (removal.message) result.notes.push(removal.message);
    }
  } catch (error) {
    result.notes.push(`The checkout of this task could not be removed (${(error as Error).message}).`);
  }

  return result;
}
