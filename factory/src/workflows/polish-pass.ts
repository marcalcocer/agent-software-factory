/**
 * The polish pass as a procedure: take a snapshot, ask the developer to fix the minor findings, run the
 * tests and the build, keep the result or put the snapshot back.
 *
 * Everything that touches the outside - git, the test runner, the model - is passed in, so the whole
 * flow can be run against a real repository with a stand-in developer (see `test/polish-pass.test.ts`).
 * The policy it applies is in `tools/polish.ts`.
 */
import type { ChangesSince } from '../tools/git-tools.ts';
import {
  POLISH_INSTRUCTIONS,
  assertionsLost,
  judgePolish,
  readAnswer,
  renderCandidates,
  selectPolish,
  type CheckResult,
  type PolishCandidate,
  type PolishInput,
  type PolishSelection,
  type Totals,
} from '../tools/polish.ts';
import type { DeveloperReport, PolishResult } from '../utils/schemas.ts';

export interface PolishDeps {
  snapshot(): Promise<string>;
  restore(tree: string): Promise<void>;
  changesSince(tree: string): Promise<ChangesSince>;
  /** Runs the repository's tests and build. */
  runChecks(): Promise<CheckResult>;
  /** Asks the developer, with this prompt, about these findings. May throw. */
  askDeveloper(prompt: string, candidates: PolishCandidate[]): Promise<DeveloperReport>;
  note(event: Record<string, unknown>): void;
}

export interface PolishRequest {
  /** The gates' reports of the attempt that passed. */
  gates: PolishInput;
  /** `false`: switched off for this task. */
  enabled: boolean;
  /** `false`: QA is off, so nothing would verify the fixes. */
  qaEnabled: boolean;
  /** A dry run asks the (stub) developer and changes nothing. */
  dryRun: boolean;
  /** What QA saw before: the tests that passed must still pass. */
  before: Totals | null;
  /** The task, the plan and the run brief the developer needs to understand the findings. */
  context: string[];
}

const empty = (selection: PolishSelection): Pick<PolishResult, 'candidates' | 'applied' | 'declined' | 'unanswered' | 'reported' | 'changedFiles' | 'changedLines'> => ({
  candidates: selection.candidates,
  applied: [],
  declined: [],
  unanswered: [],
  reported: selection.reported,
  changedFiles: [],
  changedLines: 0,
});

/** The developer's request: the context, then the findings, then what is and is not allowed. */
export function polishPrompt(request: Pick<PolishRequest, 'context'>, selection: PolishSelection): string {
  return [
    '# Polish pass',
    '',
    ...request.context,
    '## Minor findings to fix',
    '',
    renderCandidates(selection.candidates),
    '',
    POLISH_INSTRUCTIONS,
  ].join('\n');
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function runPolishPass(request: PolishRequest, deps: PolishDeps): Promise<PolishResult> {
  const selection = selectPolish(request.gates);
  const base = empty(selection);

  if (!request.enabled) {
    return { status: 'SKIPPED', reason: 'DISABLED', detail: 'Stage disabled for this task.', ...base };
  }
  if (!request.qaEnabled) {
    return {
      status: 'SKIPPED',
      reason: 'NEEDS_QA',
      detail: 'The QA stage is off, so there are no tests or build to check the fixes with.',
      ...base,
    };
  }
  if (selection.candidates.length === 0) return { status: 'NONE', ...base };

  deps.note({ type: 'polish_asking', findings: selection.candidates.map((candidate) => candidate.id) });

  // A dry run: the stand-in developer answers, nothing is changed or checked.
  if (request.dryRun) {
    const report = await deps.askDeveloper(polishPrompt(request, selection), selection.candidates);
    const answer = readAnswer(selection.candidates, report);
    return {
      status: 'APPLIED',
      ...base,
      applied: answer.applied,
      declined: answer.declined,
      unanswered: answer.unanswered,
      developerSummary: report.summary,
      dryRun: true,
    };
  }

  let tree: string;
  try {
    tree = await deps.snapshot();
  } catch (error) {
    // Without a way back there is no safe way to try: leave the work as it is.
    return { status: 'FAILED', reason: 'SNAPSHOT_ERROR', detail: `Could not record the working tree first: ${message(error)}`, ...base };
  }
  const undo = async (): Promise<void> => {
    try {
      await deps.restore(tree);
    } catch (error) {
      // Not being able to put the work back is the one thing a polish must not hide.
      deps.note({ type: 'polish_restore_failed', error: message(error) });
      throw new Error(`The polish pass could not undo its changes: ${message(error)}. Check the working tree before delivering.`);
    }
  };

  let report: DeveloperReport;
  try {
    report = await deps.askDeveloper(polishPrompt(request, selection), selection.candidates);
  } catch (error) {
    await undo();
    return { status: 'FAILED', reason: 'DEVELOPER_ERROR', detail: message(error), ...base };
  }

  const answer = readAnswer(selection.candidates, report);
  const answered = { applied: answer.applied, declined: answer.declined, unanswered: answer.unanswered, developerSummary: report.summary };

  if (report.status === 'BLOCKED') {
    await undo();
    return { status: 'DECLINED', reason: 'BLOCKED', detail: report.blockers.join(' | ') || 'The developer could not proceed.', ...base, ...answered };
  }

  const changes = await deps.changesSince(tree);
  const touched = { changedFiles: changes.files, changedLines: changes.additions + changes.deletions };
  if (changes.files.length === 0) {
    return { status: 'DECLINED', reason: 'NO_CHANGES', detail: 'The developer looked at the findings and changed nothing.', ...base, ...answered };
  }

  const after = await deps.runChecks();
  const verdict = judgePolish({
    before: request.before,
    after,
    changedFiles: changes.files.length,
    changedLines: touched.changedLines,
    assertionsLost: assertionsLost(changes.patch),
  });

  if (!verdict.ok) {
    await undo();
    deps.note({ type: 'polish_undone', reason: verdict.reason, detail: verdict.detail });
    // What was undone is not "applied": the findings go back to being reported.
    return {
      status: 'REVERTED',
      reason: verdict.reason,
      detail: verdict.detail,
      ...base,
      ...answered,
      applied: [],
      unanswered: selection.candidates.map((candidate) => candidate.id).filter((id) => !answer.declined.some((entry) => entry.id === id)),
      changedFiles: [],
      changedLines: 0,
    };
  }

  return { status: 'APPLIED', ...base, ...answered, ...touched };
}
