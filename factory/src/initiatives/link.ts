/**
 * Ties a run to the initiative and phase it belongs to, and keeps the phase in step with the run.
 *
 * This is bookkeeping around the run, not part of it: for an ordinary task or a round, any failure here
 * is recorded and the run goes on without the link (a database problem must not stop a delivery).
 * The one exception is a run the user started on a phase of a roadmap - it exists to work on that
 * phase, so a phase that is missing, belongs to another repository, or is not ready to start is an error.
 */
import { phaseTask, readiness, roadmapView, type RoadmapView } from './phasing.ts';
import { withStore, type InitiativeWithPhases, type PhaseRow } from './store.ts';
import type { RunContext } from '../utils/schemas.ts';

export type InitiativeLink = NonNullable<RunContext['initiative']>;

const linkOf = (initiative: InitiativeWithPhases, phase: PhaseRow, mode: InitiativeLink['mode']): InitiativeLink => ({
  id: initiative.id,
  phaseId: phase.id,
  ordinal: phase.ordinal,
  total: initiative.phases.filter((other) => other.status !== 'SKIPPED' || other.id === phase.id).length,
  title: initiative.title,
  phaseTitle: phase.title,
  mode,
});

export interface LinkRequest {
  runId: string;
  /** The user's repository (the key an initiative is filed under). */
  repoPath: string;
  task: string;
  provisionalTitle: string;
  /** What an earlier attempt of this same run already linked to (a failed prepare that is retried). */
  existing?: { initiativeId?: string; phaseId?: string };
  /** A run of one phase of a roadmap. */
  phase?: { initiativeId: string; phaseId: string };
  /** The phase a round continues (read from the run that opened the pull request). */
  roundOf?: { initiativeId?: string; phaseId?: string; rootTaskId?: string };
}

/** Finds - or, for a new task, creates - the initiative and phase of a run. */
export async function linkToInitiative(request: LinkRequest): Promise<InitiativeLink | undefined> {
  return await withStore(async (store) => {
    /* ---- one phase of a roadmap ---- */
    if (request.phase) {
      const phase = await store.getPhase(request.phase.phaseId);
      const initiative = phase ? await store.getInitiative(phase.initiativeId) : null;
      if (!phase || !initiative || initiative.id !== request.phase.initiativeId) {
        throw new Error(`Phase ${request.phase.phaseId} was not found. It may have been removed from the roadmap.`);
      }
      if (initiative.repoPath !== request.repoPath) {
        throw new Error(`Phase ${phase.id} belongs to ${initiative.repoPath}, not to ${request.repoPath}.`);
      }
      // A retry of the run that already started this phase is fine; anything else must be ready.
      const retrying = phase.status === 'RUNNING' && phase.rootRunId === request.runId;
      const verdict = retrying ? ({ ready: true } as const) : readiness(initiative, phase);
      if (!verdict.ready) throw new Error(verdict.reason);
      return linkOf(initiative, phase, 'phase');
    }

    /* ---- a round on a pull request ---- */
    if (request.roundOf) {
      const phase = request.roundOf.phaseId
        ? await store.getPhase(request.roundOf.phaseId)
        : request.roundOf.rootTaskId
          ? await store.findPhaseByTask(request.roundOf.rootTaskId)
          : null;
      const initiative = phase ? await store.getInitiative(phase.initiativeId) : null;
      return phase && initiative ? linkOf(initiative, phase, 'round') : undefined;
    }

    /* ---- a new task: a quick initiative of one phase, unless an earlier attempt made it ---- */
    if (request.existing?.phaseId) {
      const phase = await store.getPhase(request.existing.phaseId);
      const initiative = phase ? await store.getInitiative(phase.initiativeId) : null;
      if (phase && initiative) return linkOf(initiative, phase, 'new');
    }
    const created = await store.createInitiative({
      repoPath: request.repoPath,
      title: request.provisionalTitle,
      goal: request.task,
      kind: 'quick',
      firstPhase: { title: request.provisionalTitle, goal: request.task },
    });
    return linkOf(created, created.phases[0]!, 'new');
  });
}

/** The user's words for a task have just been decided (the namer answered): the initiative and its first phase take them. */
export async function renameInitiative(link: InitiativeLink, title: string): Promise<void> {
  await withStore(async (store) => {
    await store.updateInitiative(link.id, { title });
    await store.updatePhase(link.phaseId, { title });
  });
}

/** The run has its branch: the phase is now being worked on. */
export async function startPhase(link: InitiativeLink, run: { taskId: string; rootRunId: string; branch: string | null }): Promise<void> {
  if (link.mode === 'round') return; // a round keeps the phase as it is: its pull request is open
  await withStore((store) => store.linkRun(link.phaseId, run));
}

/** The roadmap of the phase's initiative as a pull request shows it, or `null` when there is none to show. */
export async function loadRoadmapView(link: InitiativeLink | undefined): Promise<RoadmapView | null> {
  if (!link) return null;
  try {
    return await withStore(async (store) => roadmapView(await store.getInitiative(link.id), link.phaseId));
  } catch {
    return null;
  }
}

/**
 * What the roadmap says about a phase whose run ended without a pull request. The words are for the user:
 * they say what happened to the work, and what they can do about it.
 */
export function releaseNote(status: string, branch: string): string {
  switch (status) {
    case 'DELIVERED_WITHOUT_PR':
      return `A run delivered this phase on the branch ${branch} without opening a pull request, so it is not in review. Run it again, or skip it.`;
    case 'ABORTED_BY_HUMAN':
      return `The run of this phase (branch ${branch}) was aborted. Run it again, or skip it.`;
    case 'ESCALATED_TO_HUMAN':
      return `The run of this phase (branch ${branch}) was escalated to a human and did not go on. Run it again, or skip it.`;
    default:
      return `The run of this phase (branch ${branch}) ended as ${status}, without a pull request. Run it again, or skip it.`;
  }
}

/* -------------------------------------------------------------------------- */
/* Starting a phase from the command line                                      */
/* -------------------------------------------------------------------------- */

export type PhaseRequest =
  | {
      ok: true;
      /** The repository the roadmap belongs to. */
      repoPath: string;
      /** What the run is asked to do: the phase as a request, plus anything the user added. */
      task: string;
      phase: { initiativeId: string; phaseId: string };
      /** The name of the run: the phase's own. */
      title: string;
    }
  | { ok: false; error: string };

/**
 * Turns "run phase X" into a run request, or says why it cannot start. Checked here, at the edge, so a
 * phase that is not ready is refused before a run record exists (the workflow checks again, which also
 * covers a phase that changed in between).
 */
export async function resolvePhaseRequest(options: { phaseId: string; repoPath?: string; extra?: string }): Promise<PhaseRequest> {
  return await withStore(async (store): Promise<PhaseRequest> => {
    const phase = await store.getPhase(options.phaseId);
    const initiative = phase ? await store.getInitiative(phase.initiativeId) : null;
    if (!phase || !initiative) return { ok: false, error: `Phase ${options.phaseId} was not found. It may have been removed from the roadmap.` };
    if (options.repoPath && initiative.repoPath !== options.repoPath) {
      return { ok: false, error: `Phase ${phase.id} belongs to ${initiative.repoPath}, not to ${options.repoPath}.` };
    }
    const verdict = readiness(initiative, phase);
    if (!verdict.ready) return { ok: false, error: verdict.reason };

    const extra = options.extra?.trim();
    return {
      ok: true,
      repoPath: initiative.repoPath,
      task: extra ? `${phaseTask(initiative, phase)}\n\nFrom the user, for this run:\n${extra}` : phaseTask(initiative, phase),
      phase: { initiativeId: initiative.id, phaseId: phase.id },
      title: phase.title,
    };
  });
}
