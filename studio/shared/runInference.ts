/**
 * Explains a run that stopped without recording an outcome.
 *
 * A run that fails normally leaves a `summary.json` with the real error. This covers the
 * remainder - a process that was killed, or a failure from before failures were recorded on
 * the resume path - so the UI can say *where* the run stopped instead of the useless
 * "interrupted or crashed".
 *
 * Pure (no Node, no DOM): shared by the Electron main process and the renderer.
 */
import type { RunEventRecord } from './types';

const GATE_LABEL: Record<string, string> = {
  CLARIFICATION_REQUIRED: 'your answers to the architect\'s questions',
  DELIVERY_APPROVAL_REQUIRED: 'your approval to push the branch and open a pull request',
  ESCALATION_REQUIRED: 'your decision on an escalation',
};

const STEP_LABEL: Record<string, string> = {
  'prepare-run': 'Prepare',
  'pm-architect': 'PM Architect',
  developer: 'Developer',
  'qa-tester': 'QA',
  triage: 'Triage',
  'code-review': 'Review',
  security: 'Security',
  documentation: 'Documentation',
  delivery: 'Delivery',
};

/** Workflow step that follows each human gate once it is answered. */
const STEP_AFTER_GATE: Record<string, string> = {
  CLARIFICATION_REQUIRED: 'plan',
  DELIVERY_APPROVAL_REQUIRED: 'pull-request',
  ESCALATION_REQUIRED: 'escalation',
};

export interface Interruption {
  message: string;
  /** Workflow step the run most likely stopped in, when it can be told. */
  failedStep?: string;
}

export function inferInterruption(events: RunEventRecord[]): Interruption {
  const last = events[events.length - 1];
  if (!last) {
    return { message: 'The run stopped before it recorded any progress.' };
  }

  if (last.type === 'run_suspended' && typeof last.reason === 'string') {
    const label = GATE_LABEL[last.reason] ?? 'your input';
    const failedStep = STEP_AFTER_GATE[last.reason];
    let message =
      `The run was waiting for ${label}, but it stopped after you answered and never recorded ` +
      'what happened next.';
    if (last.reason === 'DELIVERY_APPROVAL_REQUIRED') {
      message +=
        ' The delivery step is the likely culprit: the branch may already have been pushed, ' +
        'but no pull request or delivery report was saved. Use "Retry run" to continue from ' +
        'the delivery step.';
    } else {
      message += ' Use "Retry run" to continue from that step.';
    }
    return { message, failedStep };
  }

  if (last.type === 'step_artifact' || last.type === 'step_completed') {
    const step = String(last.step ?? '');
    const label = STEP_LABEL[step] ?? step;

    // The delivery succeeded but the closing step never ran, so the run has no outcome. That
    // is a bookkeeping gap, not a crash: say so, and say that retrying repeats nothing.
    if (step === 'delivery' && !/FAILED$/i.test(String(last.status ?? ''))) {
      return {
        message:
          'The delivery finished, but the run was never closed out: its final bookkeeping step ' +
          'did not run, so no outcome was saved. Nothing needs to be redone - "Retry run" just ' +
          'completes the record.',
      };
    }
    return {
      message:
        `The run stopped right after the ${label} step. The next step never reported a result, ` +
        'so the process was most likely killed (app closed, machine slept, or a crash). ' +
        'Use "Retry run" to continue.',
    };
  }

  return {
    message:
      `The run stopped unexpectedly after "${last.type}" without finishing. ` +
      'Use "Retry run" to continue from the last completed step.',
  };
}
