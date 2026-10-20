/**
 * An initiative as the Studio shows it: the rows of the store plus what the screen needs and should not
 * have to work out - which phase can start, and why another cannot.
 */
import { readiness } from './phasing.ts';
import type { BacklogRow, InitiativeWithPhases, PhaseRow } from './store.ts';

export interface PhaseView extends PhaseRow {
  /** Whether it can start now. */
  ready: boolean;
  /** For a phase that is waiting but cannot start: what it is waiting for, in words for the user. */
  blockedReason: string | null;
}

export interface InitiativeView extends Omit<InitiativeWithPhases, 'phases'> {
  phases: PhaseView[];
  /** The phase the user would start next, if any. */
  nextPhaseId: string | null;
  /** What is still open in the backlog. */
  backlog: BacklogRow[];
}

export function initiativeView(initiative: InitiativeWithPhases, backlog: BacklogRow[]): InitiativeView {
  const phases = initiative.phases.map((phase): PhaseView => {
    const state = readiness(initiative, phase);
    return { ...phase, ready: state.ready, blockedReason: state.ready || phase.status !== 'PLANNED' ? null : state.reason };
  });
  return {
    ...initiative,
    phases,
    nextPhaseId: phases.find((phase) => phase.ready)?.id ?? null,
    backlog: backlog.filter((item) => item.status === 'OPEN'),
  };
}
