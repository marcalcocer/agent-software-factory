/**
 * Recovery for a Mastra quirk that leaves a finished run looking unfinished.
 *
 * Reproduced in isolation: when a failed run is restarted with `timeTravel` and the re-entered
 * step then suspends (the delivery approval gate, a clarification, an escalation), answering the
 * gate with `resume` *completes the step* but Mastra never advances the parent workflow. It
 * reports `status: 'suspended'` with an empty payload and no suspended paths, and the steps
 * after the gate (`finalize`, which writes `summary.json`) never run. The step's own work is
 * done - the pull request exists - but the run has no outcome, so the Studio showed it as failed.
 *
 * Nothing is actually waiting in that state, which is what tells it apart from a real gate:
 *
 *   waiting for a human :  workflow suspended AND some step is `suspended`
 *   stuck               :  workflow suspended AND no step is `suspended`
 *
 * The way out (verified on the replica) is to `timeTravel` into the first top-level step that
 * has not completed (see `continuationStep`): Mastra then continues normally from there, reusing every stored result.
 */

interface StepLike {
  status?: string;
}

export interface RunStateLike {
  status?: string;
  steps?: Record<string, StepLike | undefined>;
}

/**
 * Top-level steps of the software-factory workflow, in execution order. The delivery and
 * escalation phases are alternative branches: one is `success` and the other `skipped`.
 */
const TOP_LEVEL_STEPS: ReadonlyArray<readonly string[]> = [
  ['prepare-run'],
  ['plan'],
  ['implementation-cycle'],
  ['delivery-phase', 'escalation-phase'],
  ['finalize'],
];

const isComplete = (status: string | undefined): boolean =>
  status === 'success' || status === 'skipped';

/** The workflow says "suspended" but no step is waiting for anything. */
export function isStuckSuspended(state: RunStateLike | null | undefined): boolean {
  if (!state || state.status !== 'suspended') return false;
  const steps = Object.values(state.steps ?? {});
  return !steps.some((step) => step?.status === 'suspended');
}

/**
 * Where a stuck run has to be continued: the top-level step right after the last one that
 * completed. Returns `null` when the run already reached the end (or nothing completed).
 *
 * Anchoring on the last *completed* step - rather than hunting for the first one that is
 * missing - keeps this correct however many of the canonical steps appear in the stored state.
 */
export function continuationStep(state: RunStateLike | null | undefined): string | null {
  const steps = state?.steps ?? {};
  let lastComplete = -1;
  TOP_LEVEL_STEPS.forEach((group, index) => {
    // An alternative branch counts as done when any of its members completed.
    if (group.some((id) => isComplete(steps[id]?.status))) lastComplete = index;
  });
  if (lastComplete < 0) return null;
  return TOP_LEVEL_STEPS[lastComplete + 1]?.[0] ?? null;
}

export type StepResults = Record<string, { status?: string; error?: unknown }>;

/** The parts of a Mastra workflow result the CLI looks at. */
export interface WorkflowResultLike {
  status: string;
  result?: { status?: string; traceDir?: string; summaryPath?: string };
  suspendPayload?: unknown;
  /** Paths of the steps waiting for input; empty when nothing is actually waiting. */
  suspended?: unknown[];
  error?: unknown;
  steps?: StepResults;
}

/** The slice of a Mastra workflow that `continueIfStuck` needs. */
export interface RestartableWorkflow {
  getWorkflowRunById(runId: string): Promise<unknown>;
  createRun(options: { runId: string }): Promise<unknown>;
}

/**
 * If `result` is the stuck shape described above, continues the run at the first step that did
 * not complete and returns the result of that continuation; otherwise returns `result` as is.
 *
 * Call it on the result of every `resume` / `timeTravel`.
 */
export async function continueIfStuck(
  runId: string,
  workflow: RestartableWorkflow,
  result: WorkflowResultLike,
  log: (message: string) => void = () => {},
): Promise<WorkflowResultLike> {
  // A genuine gate lists the step it is waiting on; only an empty list means "nothing waits".
  if (result.status !== 'suspended' || (result.suspended?.length ?? 0) > 0) return result;

  const state = (await workflow.getWorkflowRunById(runId)) as RunStateLike | null;
  const next = isStuckSuspended(state) ? continuationStep(state) : null;
  if (!next) return result;

  log(
    '\nThe step you answered has finished, but the workflow was left suspended.\n' +
      `Continuing the run at "${next}".\n`,
  );
  const run = (await workflow.createRun({ runId })) as {
    timeTravel(options: { step: string }): Promise<WorkflowResultLike>;
  };
  return await run.timeTravel({ step: next });
}
