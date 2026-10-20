/**
 * Software Factory E2E workflow.
 *
 *   prepare-run
 *        |
 *   01 plan (PM & Architect)  --[BLOCKING ambiguity]--> suspend for clarification
 *        |
 *   +----v-------------------------------------------------------------+
 *   | implementation-cycle (dountil cycleComplete || escalate)         |
 *   |                                                                  |
 *   |  02 developer -> 03 qa-tester                                    |
 *   |        |                                                         |
 *   |   QA failed? --yes--> 04 triage-qa                               |
 *   |        |                 RETRY_DEVELOPER / RE-RUN_INFRA -> loop  |
 *   |        |                 ESCALATE_HUMAN -> exit loop             |
 *   |        no                                                        |
 *   |        v                                                         |
 *   |  verification-phase: 05 code-review || 06 security (parallel)    |
 *   |        |                                                         |
 *   |   approved? --no--> 04 triage-verification -> loop               |
 *   |        yes -> cycleComplete                                      |
 *   +----|-------------------------------------------------------------+
 *        |
 *   escalate? --yes--> escalation-phase (suspend + 09-escalation.json)
 *        no
 *        v
 *   delivery-phase: 07 documentation -> 08 commit/push/pull request
 *        |
 *   finalize (summary.json)
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { documentationAgent } from '../agents/documentation.agent.ts';
import { prWriterAgent } from '../agents/pr-writer.agent.ts';
import { runNamerAgent } from '../agents/run-namer.agent.ts';
import { developerAgent } from '../agents/developer.agent.ts';
import { pmArchitectAgent } from '../agents/pm-architect.agent.ts';
import { qaTesterAgent } from '../agents/qa-tester.agent.ts';
import { reviewerAgent } from '../agents/reviewer.agent.ts';
import { securityAgent } from '../agents/security.agent.ts';
import { triageAgent } from '../agents/triage.agent.ts';
import {
  amendTipCommitMessage,
  assessDeliveryEditability,
  changesSince,
  chooseBaseBranch,
  commitAll,
  createBranch,
  createPullRequest,
  getBranchSha,
  getCommitMessage,
  getDiff,
  getFullDiff,
  inspectBranchPublication,
  isWorkingTreeClean,
  pushBranch,
  recentCommitSubjects,
  renameBranch,
  restoreWorkingTree,
  snapshotWorkingTree,
} from '../tools/git-tools.ts';
import { describeCoverage, isTestFile, viewDiff, type DiffCoverage, type DiffView } from '../tools/diff-view.ts';
import { runPolishPass } from './polish-pass.ts';
import { cleanSubject, condenseDiff, explainAgentFailure } from '../tools/pr-merge-rules.ts';
import { composeCommitMessage, fallbackPrText, normalizePrWriterOutput, polishNote, type PrTextContext } from '../tools/pr-text.ts';
import { branchNameFor, fallbackRunName, guessBranchType, normalizeRunName, roundTitle, slugify, withTaskTrailer, type RunName } from '../tools/run-naming.ts';
import {
  appendEvent,
  aggregateRunMetrics,
  clearPendingInput,
  generateRunId,
  artifactFileName,
  listArtifacts,
  openRunTrace,
  readArtifact,
  readEvents,
  traceDirFor,
  updateRunMeta,
  writeArtifact,
  writeContextBlock,
  writePendingInput,
  writeSummary,
} from '../tools/logger-tools.ts';
import { buildPayload, polishChecksLabel, qaChecksLabel, runChecks, testPayload, toCheckResult } from '../tools/run-checks.ts';
import { detectProjectStack } from '../tools/test-runner-tools.ts';
import {
  markCommentsHandled,
  pullRequestKey,
  registerPullRequest,
  pullRequestNumberFromUrl,
} from '../tools/pr-registry.ts';
import { ANSWERED_AT_TRIAGE, postReplyFor } from '../tools/pr-reply.ts';
import {
  skippedDocumentationReport,
  skippedQaReport,
  skippedReviewReport,
  skippedSecurityReport,
} from '../utils/stage-skip.ts';
import { composePrompt, invokeAgent, promptSection } from '../utils/agent-runner.ts';
import {
  currentWorkBranch,
  earlierDeliveryActions,
  latestDeliveryEdits,
  sanitizeDeliveryEdits,
} from '../utils/delivery-edits.ts';
import { getConventionSources } from '../utils/context-loader.ts';
import { getFactoryConfig, resolveInsideRepo, resolveRepoPath } from '../utils/factory-config.ts';
import { allocateTaskId } from '../utils/task-ids.ts';
import { backlogFromRun } from '../initiatives/harvest.ts';
import { linkToInitiative, loadRoadmapView, renameInitiative, startPhase, type InitiativeLink } from '../initiatives/link.ts';
import { renderInitiativeContext, roadmapFromPlan, type RoadmapView } from '../initiatives/phasing.ts';
import { withStore } from '../initiatives/store.ts'; 
import { AGENT_ROLES, describeModelChain } from '../utils/model-router.ts';
import {
  blockedQaReport,
  stubDeveloperReport,
  stubDocumentationReport,
  stubExecutionPlan,
  stubPrWriterOutput,
  stubQaReport,
  stubReviewReport,
  stubRoundCommit,
  stubRunName,
  stubSecurityReport,
  stubTriageReport,
} from '../utils/dry-run-fixtures.ts';
import {
  cycleStateSchema,
  deliveryEditsSchema,
  deliveryReportSchema,
  developerReportSchema,
  documentationReportSchema,
  executionPlanSchema,
  factoryResultSchema,
  DEFAULT_PIPELINE,
  factoryTaskSchema,
  outcomeSchema,
  polishResultSchema,
  prTextSchema,
  prWriterAgentSchema,
  qaReportSchema,
  roundCommitSchema,
  reviewReportSchema,
  runContextSchema,
  runNameSchema,
  securityReportSchema,
  triageReportSchema,
  type AttemptHistory,
  type CycleState,
  type DeveloperReport,
  type ExecutionPlan,
  type Feedback,
  type Outcome,
  type PolishResult,
  type PrText,
  type QaReport,
  type Revision,
  type RunContext,
} from '../utils/schemas.ts';

/* ========================================================================== */
/* Helpers                                                                     */
/* ========================================================================== */

const MAX_STEPS = {
  plan: 25,
  developer: 60,
  qa: 30,
  triage: 20,
  review: 20,
  security: 20,
  documentation: 25,
} as const;

/** Stable fingerprint of a QA failure, used by triage for loop detection. */
function qaFailureSignature(report: QaReport): string | null {
  if (report.passed) return null;
  const parts = report.failures.map((failure) => `${failure.testId}|${failure.type}`).sort();
  const basis = parts.length > 0 ? parts.join('\n') : `${report.verdict}|${report.summary}`;
  return createHash('sha1').update(basis).digest('hex').slice(0, 12);
}

/** Context block describing the run, injected in every agent prompt. */
/**
 * The outcome of a quality gate as it is REPORTED. A stage that was switched off for the task still
 * hands the cycle a passing report (so it cannot block delivery), but it did not run: saying
 * `APPROVED` or `PASS` for it would claim a review or an audit that never happened.
 */
function reportedGate(enabled: boolean, status: string | null | undefined): string | null {
  return enabled ? (status ?? null) : 'SKIPPED';
}

function runBrief(run: RunContext, attempt: number): string {
  return promptSection('Run context', {
    runId: run.runId,
    attempt,
    maxAttempts: run.maxAttempts,
    repositoryPath: run.repoPath,
    repositoryName: run.repoName,
    workBranch: run.workBranch,
    baseBranch: run.baseBranch,
    stack: run.stack,
    testCommand: run.testCommand,
    conventionSources: run.conventions,
    traceDirectory: run.traceDir,
    ...(run.initiative && run.initiative.total > 1
      ? { phase: `${run.initiative.ordinal} of ${run.initiative.total} of "${run.initiative.title}": ${run.initiative.phaseTitle}` }
      : {}),
    ...(run.revision
      ? {
          // Every agent should know this is further work on an open pull request, not a fresh task.
          revision: {
            round: run.revision.round,
            continuesRun: run.revision.parentRunId,
            pullRequest: `#${run.revision.pullRequest.number} ${run.revision.pullRequest.url}`,
            reviewCommentsBeingAddressed: run.revision.comments.length,
          },
        }
      : {}),
  });
}

/** One review comment, rendered the way a developer would want to read it. */
function describeReviewComment(comment: Revision['comments'][number]): string {
  const where = comment.path ? ` (${comment.path}${comment.line ? `:${comment.line}` : ''})` : '';
  const kind = comment.category ? `[${comment.category}] ` : '';
  return `${kind}${comment.author}${where}: ${comment.body.trim()}`;
}

/** Comments that do not ask for a code change: they are answered (or left to a human), not implemented. */
const NOT_A_CHANGE_REQUEST: ReadonlySet<string> = new Set([...ANSWERED_AT_TRIAGE, 'BLOCKER_DISAGREEMENT']);

/** An uncategorised comment is assumed to ask for something: better to act on it than to ignore it. */
const asksForChange = (comment: Revision['comments'][number]): boolean =>
  !comment.category || !NOT_A_CHANGE_REQUEST.has(comment.category);

/**
 * The reviewer's comments as human feedback for the develop loop. This is the same channel the
 * quality gates use to send work back to the developer, so the existing prompt and the
 * `appliedFeedback` report already know how to deal with it.
 *
 * Only the comments that ask for a change are handed over as work. A question ("Why const here?")
 * given to the developer as something to "address" invites changes nobody asked for, so questions
 * and notes travel as context, clearly marked as not to be acted on. (If *nothing* asks for a
 * change, everything is passed through: the round was started on purpose.)
 */
export function reviewFeedback(revision: Revision): Feedback {
  const changes = revision.comments.filter(asksForChange);
  const actionable = changes.length > 0 ? changes : revision.comments;
  const remarks = changes.length > 0 ? revision.comments.filter((comment) => !asksForChange(comment)) : [];

  return {
    source: 'HUMAN',
    attempt: 1,
    hints: actionable.map(describeReviewComment),
    filesToInspect: [...new Set(revision.comments.flatMap((comment) => (comment.path ? [comment.path] : [])))],
    failingTests: [],
    doNotRetry: [],
    notes:
      `Round ${revision.round} on pull request #${revision.pullRequest.number}. The previous rounds' ` +
      'work is already committed on this branch; change only what the comments ask for.' +
      (remarks.length > 0
        ? ' The reviewer also left remarks that do not ask for a change - context only, do not act on ' +
          `them: ${remarks.map(describeReviewComment).join(' | ')}`
        : ''),
  };
}

/**
 * Commit message for a round: what this commit is for, not the plan's message from round 1.
 *
 * A round reuses the plan, and with it the plan's commit message - so the second commit of a pull
 * request used to read exactly like the first ("chore(ui): apply minor change") even when it only
 * reverted a keyword the reviewer asked about. This names the round and lists what was asked.
 */
export function revisionCommitMessage(revision: Revision): string {
  // The plain stand-in, used when the PR writer cannot answer. A round the triage named says what it is
  // about; one it did not is "address review feedback on PR #N".
  const named = revision.title ? cleanSubject(revision.title) : '';
  const subject = named
    ? `chore: ${named.charAt(0).toLowerCase()}${named.slice(1)}`
    : `chore: address review feedback on PR #${revision.pullRequest.number} (round ${revision.round})`;
  const asked = revision.comments.filter(asksForChange).slice(0, 5);
  const lines = asked.map((comment) => {
    const where = comment.path ? ` (${comment.path}${comment.line ? `:${comment.line}` : ''})` : '';
    const text = (comment.body.trim().split('\n')[0] ?? '').slice(0, 100);
    return `- ${comment.author}${where}: ${text}`;
  });
  return lines.length > 0 ? `${subject}\n\n${lines.join('\n')}` : subject;
}

/**
 * The plan a task has been working from. Read from the given run, and - when that run never got as
 * far as writing one (a round that failed early) - from the run it continued, and so on back.
 */
// Exported so the walk back through a chain of rounds can be tested directly.
export function loadPlanOfRun(runId: string): ExecutionPlan | null {
  let current: string | undefined = runId;
  for (let hops = 0; current && hops < 25; hops += 1) {
    const artifact = readArtifact(current, artifactFileName('pm-architect')) as
      | { status?: string; data?: { plan?: unknown } }
      | null;
    // A plan that stopped to ask a question is not a plan to build on.
    if (artifact && artifact.status !== 'CLARIFICATION_REQUIRED') {
      const parsed = executionPlanSchema.safeParse(artifact.data?.plan);
      if (parsed.success) return parsed.data;
    }
    const meta = readArtifact(current, 'run.json') as { parentRunId?: string } | null;
    current = meta?.parentRunId;
  }
  return null;
}

/** First state of the develop -> QA -> review loop for a given plan. */
function startCycle(run: RunContext, plan: ExecutionPlan, feedback: Feedback | null): CycleState {
  return {
    run,
    plan,
    attempt: 1,
    phase: 'DEVELOP',
    cycleComplete: false,
    escalate: false,
    escalationReason: null,
    rerunInfra: false,
    feedback,
    history: [],
    developerReport: null,
    qaReport: null,
    reviewReport: null,
    securityReport: null,
    triageReport: null,
    triageAttempt: null,
  } satisfies CycleState;
}

/** Severity gates that the triage agent is not allowed to wave through. */
function hasBlockingQuality(state: CycleState): boolean {
  const qaBroken = state.qaReport ? !state.qaReport.passed : false;
  const weakened = state.qaReport?.weakenedVerification.detected === true;
  const reviewBlocked = state.reviewReport?.status === 'CHANGES_REQUESTED';
  const securityBlocked = state.securityReport?.status === 'CHANGES_REQUESTED';
  const criticalFinding =
    state.securityReport?.findings.some(
      (finding) =>
        !finding.preExisting && (finding.severity === 'CRITICAL' || finding.severity === 'HIGH'),
    ) === true;
  const secretCommitted = (state.securityReport?.secretsDetected.length ?? 0) > 0;
  return qaBroken || weakened || reviewBlocked || securityBlocked || criticalFinding || secretCommitted;
}

function appendHistory(state: CycleState, notes: string): AttemptHistory[] {
  // Only attribute a triage decision to the attempt that actually produced it: otherwise a
  // later, successful attempt would inherit the previous iteration's decision.
  const triageOfThisAttempt = state.triageAttempt === state.attempt ? state.triageReport : null;
  const entry: AttemptHistory = {
    attempt: state.attempt,
    developerStatus: state.developerReport?.status ?? null,
    qaVerdict: state.qaReport?.verdict ?? null,
    qaFailureSignature: state.qaReport ? qaFailureSignature(state.qaReport) : null,
    reviewStatus: state.reviewReport?.status ?? null,
    securityStatus: state.securityReport?.status ?? null,
    triageDecision: triageOfThisAttempt?.decision ?? null,
    triageRootCause: triageOfThisAttempt?.rootCause.category ?? null,
    notes,
  };
  const history = state.history.filter((item) => item.attempt !== state.attempt);
  return [...history, entry].sort((a, b) => a.attempt - b.attempt);
}

/* ========================================================================== */
/* What the gates are shown of the change                                      */
/* ========================================================================== */

/** The three readers of the diff. QA looks for weakened tests, so it is shown the tests first. */
type DiffAudience = 'qa' | 'review' | 'security';

const DIFF_PRIORITY: Record<DiffAudience, ((path: string) => boolean) | undefined> = {
  qa: isTestFile,
  review: undefined,
  security: undefined,
};

/** QA does not need the production diff in the prompt: it reads the code it checks with its tools. */
const QA_DIFF_BUDGET_CHARS = 60_000;

/**
 * The change as one gate sees it: a condensed view of the COMPLETE diff, with a manifest of what is
 * and is not shown, and the complete patch saved for the agent to read (once per attempt - the three
 * gates look at the same working tree).
 *
 * This used to be `getDiff` as it came, cut in the middle by the process output cap without a word:
 * a 31-file, 107,409-character round reached QA, the reviewer and the security agent as 12 files and
 * 24,040 characters, and they could not tell.
 */
// Exported so the wiring (what is saved, what is recorded) can be exercised directly.
export async function loadDiffView(
  run: RunContext,
  attempt: number,
  audience: DiffAudience,
): Promise<{ files: string[]; view: DiffView | null }> {
  if (run.dryRun) return { files: [], view: null };

  const full = await getFullDiff(run.repoPath);
  const config = getFactoryConfig();

  const patchFile = path.join(traceDirFor(run.runId), 'context', `diff-attempt-${attempt}.patch`);
  if (!fs.existsSync(patchFile) || fs.statSync(patchFile).size !== Buffer.byteLength(full.diff)) {
    writeContextBlock(run.runId, `diff-attempt-${attempt}.patch`, full.diff);
  }

  const budget = audience === 'qa' ? Math.min(QA_DIFF_BUDGET_CHARS, config.diffBudgetChars) : config.diffBudgetChars;
  const view = viewDiff(full.diff, {
    budgetChars: budget,
    ...(DIFF_PRIORITY[audience] ? { priority: DIFF_PRIORITY[audience]! } : {}),
    // Only the CLI backend gives its read-only agents access to the trace directory.
    patchFile: config.provider === 'claude-cli' && config.claudeCliFileTools ? patchFile : null,
  });

  appendEvent(run.runId, {
    type: 'diff_view',
    attempt,
    audience,
    chars: full.diff.length,
    budget,
    ...view.coverage,
  });
  return { files: full.files, view };
}

/** What the reviewer and the security agent could not see, per gate, as the pull request should say it. */
export function diffCoverageNotes(runId: string): Partial<Record<DiffAudience, string>> {
  const notes: Partial<Record<DiffAudience, string>> = {};
  for (const event of readEvents(runId)) {
    if (event.type !== 'diff_view') continue;
    const view = event as unknown as { audience: DiffAudience } & DiffCoverage;
    const note = describeCoverage(view);
    // The last view of each gate is the one that judged the final code.
    if (note) notes[view.audience] = note;
    else delete notes[view.audience];
  }
  return notes;
}

/* ========================================================================== */
/* Naming the task                                                             */
/* ========================================================================== */

/** The namer is the cheapest call in the factory; it must never be the slowest. */
const NAMER_TIMEOUT_MS = 45_000;
/** Enough of any request to name it; the rest only costs tokens. */
const NAMER_MAX_REQUEST_CHARS = 4_000;

/**
 * Names the task with the run-namer agent: the title for the run history and the words of the branch.
 *
 * Never fails and never waits long: if the agent cannot answer (signed out, usage limit, 45 seconds
 * gone), the task is named from its own first sentence and the run goes on. Which one happened is in
 * the artifact, and the Studio can say so.
 */
// Exported so the failure path can be exercised directly.
export async function nameTask(
  run: { runId: string; repoPath: string; repoName: string },
  task: string,
  logger: { warn?: (...args: any[]) => void } | undefined,
): Promise<{ name: RunName; source: 'agent' | 'fallback' }> {
  appendEvent(run.runId, { type: 'run_naming', phase: 'started' });
  const started = Date.now();
  try {
    const result = await invokeAgent({
      agent: runNamerAgent,
      role: 'run-namer',
      step: 'run-namer',
      runId: run.runId,
      repoPath: run.repoPath,
      repoName: run.repoName,
      prompt: composePrompt(
        '# Request to name',
        '',
        task.length > NAMER_MAX_REQUEST_CHARS ? `${task.slice(0, NAMER_MAX_REQUEST_CHARS)}\n[... the request goes on ...]` : task,
        '',
        'Name this task: a title, a slug and a type.',
      ),
      schema: runNameSchema,
      dryRunResult: stubRunName(),
      timeoutMs: NAMER_TIMEOUT_MS,
      // Its own model, then the same one told what it broke. Never the pricier model the ladder ends with.
      maxRungs: 2,
    });
    const name = normalizeRunName(result.object, task);
    writeArtifact({
      runId: run.runId,
      step: 'run-namer',
      status: 'COMPLETED',
      durationMs: Date.now() - started,
      model: result.servedByModel,
      data: name,
    });
    return { name, source: 'agent' };
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    const name = fallbackRunName(task);
    writeArtifact({
      runId: run.runId,
      step: 'run-namer',
      status: 'FALLBACK',
      durationMs: Date.now() - started,
      data: { ...name, error: message },
    });
    appendEvent(run.runId, { type: 'run_namer_fallback', error: message });
    logger?.warn?.(`[factory] the run namer could not answer; named from the request instead: ${message}`, {
      runId: run.runId,
    });
    return { name, source: 'fallback' };
  }
}

/* ========================================================================== */
/* Step 0 - prepare run                                                        */
/* ========================================================================== */

const prepareRunStep = createStep({
  id: 'prepare-run',
  description:
    'Resolves and validates the target repository, detects the stack, creates the work branch ' +
    'and opens the run trace directory.',
  inputSchema: factoryTaskSchema,
  outputSchema: z.object({ run: runContextSchema }),
  execute: async ({ inputData, runId, mastra }) => {
    const config = getFactoryConfig();
    const logger = mastra?.getLogger?.();

    const repoPath = resolveRepoPath(inputData.repo, { requireGit: !config.dryRun });
    const repoName = path.basename(repoPath);
    const stack = detectProjectStack(repoPath);

    const effectiveRunId = runId ?? generateRunId(repoName);
    // Where the task builds on. Chosen explicitly (`--base-branch`, or a round on a pull request),
    // otherwise the checked-out branch - unless that is one the factory made for an earlier task,
    // which must not become the base of this one (see `chooseBaseBranch`).
    const baseChoice: { base: string; note?: string } =
      inputData.baseBranch !== undefined ? { base: inputData.baseBranch } : await chooseBaseBranch(repoPath);
    const baseBranch = baseChoice.base;

    if (!config.dryRun && !(await isWorkingTreeClean(repoPath))) {
      throw new Error(
        `Target repository "${repoPath}" has uncommitted changes. Commit or stash them before ` +
          'starting a factory run: the factory needs a clean baseline to produce a reviewable diff.',
      );
    }

    const conventions = getConventionSources(repoPath);
    const models = Object.fromEntries(AGENT_ROLES.map((role) => [role, describeModelChain(role)]));

    // Who this task is. A new task gets the next id; a round keeps the id and the name of its task.
    // The CLI may have recorded the run already (it does, the moment it starts one).
    const revision = inputData.revision;
    const rootRecord = revision
      ? (readArtifact(revision.rootRunId, 'run.json') as { taskId?: string; title?: string; initiativeId?: string; phaseId?: string } | null)
      : null;
    // A retry of a prepare that failed halfway keeps the id it had: ids are not spent twice.
    const earlier = readArtifact(effectiveRunId, 'run.json') as { taskId?: string; phaseId?: string } | null;
    const taskId = revision ? rootRecord?.taskId : (earlier?.taskId ?? (await allocateTaskId()));
    const mode: InitiativeLink['mode'] = inputData.phase ? 'phase' : revision ? 'round' : 'new';
    const provisionalName = fallbackRunName(inputData.task);
    const provisionalTitle = revision
      ? roundTitle(rootRecord?.title ?? fallbackRunName(revision.originalTask).title, revision.round, revision.title)
      : provisionalName.title;
    const workBranchFor = (name: RunName): string =>
      inputData.branchName ?? branchNameFor(taskId ?? effectiveRunId.slice(-4), name);

    const run: RunContext = {
      runId: effectiveRunId,
      traceDir: '',
      task: inputData.task,
      ...(inputData.clarifications === undefined ? {} : { clarifications: inputData.clarifications }),
      repoPath,
      repoName,
      baseBranch,
      workBranch: workBranchFor(provisionalName),
      branchCreated: false,
      stack,
      testCommand: inputData.testCommand ?? stack.testCommand,
      requesterCriteria: inputData.acceptanceCriteria ?? [],
      conventions,
      maxAttempts: inputData.maxAttempts ?? config.maxAttempts,
      autoCommit: inputData.autoCommit ?? true,
      createPullRequest: inputData.createPullRequest ?? true,
      interactive: (inputData.interactive ?? true) && !config.nonInteractive,
      dryRun: config.dryRun,
      startedAt: new Date().toISOString(),
      // Stage selection is resolved once, here, so every later step reads one source of truth.
      pipeline: { ...DEFAULT_PIPELINE, ...(inputData.pipeline ?? {}) },
      ...(inputData.revision ? { revision: inputData.revision } : {}),
      ...(taskId ? { taskId } : {}),
      title: provisionalTitle,
      ...(inputData.phasing ? { phasingMode: inputData.phasing } : {}),
    };

    const { traceDir, startedAt } = openRunTrace({
      runId: run.runId,
      task: run.task,
      repoPath,
      repoName,
      branch: run.workBranch,
      baseBranch,
      models,
      pipeline: run.pipeline,
      ...(taskId ? { taskId } : {}),
      title: provisionalTitle,
      titleSource: revision ? 'round' : 'fallback',
      // Where this run sits in the story of its pull request. A plain run is round 1 of its own
      // chain; a revision points at the round it continues so the UI can show them as one task.
      kind: run.revision ? 'revision' : 'run',
      rootRunId: run.revision?.rootRunId ?? run.runId,
      round: run.revision?.round ?? 1,
      ...(run.revision
        ? {
            parentRunId: run.revision.parentRunId,
            pullRequest: {
              number: run.revision.pullRequest.number,
              url: run.revision.pullRequest.url,
              headBranch: run.revision.pullRequest.headBranch,
              baseBranch: run.revision.pullRequest.baseBranch,
            },
          }
        : {}),
      dryRun: config.dryRun,
      startedAt: run.startedAt,
    });
    run.traceDir = traceDir;
    run.startedAt = startedAt; // the run began when it was started, not when this step got going

    /** Bookkeeping around the run: a failure is recorded and the run goes on - except for a phase, which is what the run is for. */
    const tryLink = async (title: string): Promise<InitiativeLink | undefined> => {
      try {
        return await linkToInitiative({
          runId: run.runId,
          repoPath,
          task: inputData.task,
          provisionalTitle: title,
          ...(earlier?.phaseId ? { existing: { phaseId: earlier.phaseId } } : {}),
          ...(inputData.phase ? { phase: inputData.phase } : {}),
          ...(revision
            ? {
                roundOf: {
                  ...(rootRecord?.initiativeId ? { initiativeId: rootRecord.initiativeId } : {}),
                  ...(rootRecord?.phaseId ? { phaseId: rootRecord.phaseId } : {}),
                  ...(rootRecord?.taskId ? { rootTaskId: rootRecord.taskId } : {}),
                },
              }
            : {}),
        });
      } catch (error) {
        if (mode === 'phase') throw error;
        appendEvent(run.runId, { type: 'initiative_unavailable', error: (error as Error).message });
        logger?.warn?.(`[factory] the initiative store could not be used; the run goes on without it: ${(error as Error).message}`, { runId: run.runId });
        return undefined;
      }
    };

    // A phase (checked first: a phase that is not ready stops the run before anything is spent) and a
    // round already exist. A new task is filed once it has its name and its branch.
    let link = mode === 'new' ? undefined : await tryLink(provisionalTitle);

    // Name the task. Before the branch is made: the branch is named for what the work is.
    if (mode === 'new') {
      const { name, source } = await nameTask({ runId: run.runId, repoPath, repoName }, inputData.task, logger);
      run.title = name.title;
      run.workBranch = workBranchFor(name);
      updateRunMeta(run.runId, { title: name.title, titleSource: source, branch: run.workBranch });
    } else if (mode === 'phase' && link) {
      // A phase has its name already - nothing to ask a model.
      const name: RunName = { title: link.phaseTitle, slug: slugify(link.phaseTitle) || 'phase', type: guessBranchType(`${link.phaseTitle} ${inputData.task}`) };
      run.title = name.title;
      run.workBranch = workBranchFor(name);
      writeArtifact({ runId: run.runId, step: 'run-namer', status: 'COMPLETED', data: { ...name, source: 'phase' } });
      updateRunMeta(run.runId, { title: name.title, titleSource: 'phase', branch: run.workBranch });
    }

    if (baseChoice.note) {
      logger?.info?.(`[factory] ${baseChoice.note}`, { runId: run.runId, base: baseBranch });
      appendEvent(run.runId, { type: 'base_branch_chosen', base: baseBranch, note: baseChoice.note });
    }

    if (!config.dryRun) {
      const branch = await createBranch(repoPath, run.workBranch, baseBranch, {
        adoptRemote: inputData.branchName !== undefined,
        freshStart: true,
      });
      run.branchCreated = branch.created;
      run.workBranch = branch.branch;
      if (branch.note) {
        logger?.info?.(`[factory] ${branch.note}`, { runId: run.runId, branch: branch.branch });
        appendEvent(run.runId, { type: 'branch_synced', branch: branch.branch, note: branch.note });
      }
    }

    // The run has its name and its branch: file it under an initiative, and start its phase.
    if (mode === 'new') link = await tryLink(run.title ?? provisionalTitle);
    if (link) {
      run.initiative = link;
      updateRunMeta(run.runId, { initiativeId: link.id, phaseId: link.phaseId });
      if (mode === 'new' && run.title) await renameInitiative(link, run.title).catch(() => {});
      if (taskId) await startPhase(link, { taskId, rootRunId: run.revision?.rootRunId ?? run.runId, branch: run.workBranch }).catch((error: Error) => {
        appendEvent(run.runId, { type: 'initiative_unavailable', error: error.message });
      });
    }

    logger?.info?.('[factory] run prepared', {
      runId: run.runId,
      repository: repoPath,
      branch: run.workBranch,
      stack: stack.type,
      dryRun: config.dryRun,
    });
    appendEvent(run.runId, {
      type: 'step_completed',
      step: 'prepare-run',
      branch: run.workBranch,
      stack: stack.type,
      ...(run.taskId ? { taskId: run.taskId } : {}),
      ...(run.title ? { title: run.title } : {}),
      ...(run.initiative ? { initiativeId: run.initiative.id, phaseId: run.initiative.phaseId } : {}),
    });

    return { run };
  },
});

/* ========================================================================== */
/* Step 01 - plan (PM & Architect)                                             */
/* ========================================================================== */

/** What the architect is told about phasing, by what the user allowed and what kind of run this is. */
function phasingInstruction(run: RunContext): string {
  const initiative = run.initiative;
  if (initiative?.mode === 'phase') {
    return `This run implements phase ${initiative.ordinal} of ${initiative.total} of a roadmap that already exists. Plan exactly that phase and set \`phasing: null\`.`;
  }
  if (initiative?.mode === 'round' || run.revision) return 'This is a further round on an open pull request. Set `phasing: null`.';
  switch (run.phasingMode) {
    case 'off':
      return 'The user does not want this split into phases. Set `phasing: null` and plan one pull request.';
    case 'on':
      return (
        'The user asked for this to be planned in phases. Unless the request genuinely fits one reviewable pull request, ' +
        'set `phasing.phased: true` with the roadmap, and plan only Phase 1.'
      );
    default:
      return 'Propose phases only if the request is too big for one reviewable pull request (see "Phasing" in your instructions). Otherwise set `phasing: null`.';
  }
}

/** The initiative as the architect reads it - for a phase of a roadmap, and for a round that plans again. */
async function initiativeContextFor(run: RunContext): Promise<string> {
  const initiative = run.initiative;
  if (!initiative || initiative.mode === 'new') return '';
  try {
    return await withStore(async (store) => {
      const loaded = await store.getInitiative(initiative.id);
      return loaded ? renderInitiativeContext(loaded, initiative.phaseId, await store.listBacklog(initiative.id, 'OPEN')) : '';
    });
  } catch {
    return '';
  }
}

const planStep = createStep({
  id: 'plan',
  description:
    'PM & Architect agent: scans the codebase, applies the convention cascade and produces the ' +
    'execution plan. Suspends for clarification when the requirement is blocking-ambiguous.',
  inputSchema: z.object({ run: runContextSchema }),
  outputSchema: cycleStateSchema,
  suspendSchema: z.object({
    reason: z.literal('CLARIFICATION_REQUIRED'),
    questions: z.array(z.string()),
    planSummary: z.string(),
    runId: z.string(),
  }),
  resumeSchema: z.object({
    clarifications: z.string().describe('Answers to the clarification questions.'),
  }),
  execute: async ({ inputData, resumeData, suspend, mastra }) => {
    const run = inputData.run;
    const logger = mastra?.getLogger?.();
    const clarifications = resumeData?.clarifications ?? run.clarifications;

    // A further round on an open pull request. When the comments only ask for changes to the
    // implementation, the plan of the previous round still stands: reuse it (no agent call, no
    // tokens) instead of re-deriving what was already decided.
    const revision = run.revision;
    if (revision?.action === 'RERUN_IMPLEMENTATION') {
      const previousPlan = loadPlanOfRun(revision.parentRunId);
      if (previousPlan) {
        writeArtifact({
          runId: run.runId,
          step: 'pm-architect',
          status: 'REUSED',
          data: { plan: previousPlan, reusedFrom: revision.parentRunId, clarificationsUsed: null },
        });
        logger?.info?.(
          `[factory] round ${revision.round}: reusing the plan of ${revision.parentRunId}; the review comments go straight to the developer`,
          { runId: run.runId },
        );
        return startCycle(run, previousPlan, reviewFeedback(revision));
      }
      logger?.warn?.('[factory] the previous plan could not be read - planning again from the comments', {
        runId: run.runId,
        parentRunId: revision.parentRunId,
      });
    }

    // The architect's artifact is rewritten on this second pass, so without a record here the
    // human's answer would only survive as `clarificationsUsed`. Log it as its own event so the
    // question -> answer -> plan exchange can be replayed in the UI.
    if (resumeData?.clarifications) {
      appendEvent(run.runId, {
        type: 'human_input',
        step: 'plan',
        gate: 'CLARIFICATION_REQUIRED',
        answer: resumeData.clarifications,
      });
      logger?.info?.('[factory] clarification received, re-planning', { runId: run.runId });
    }

    // What the architect is told about phasing, and - for a phase of a roadmap or a re-plan of a round -
    // the initiative it belongs to.
    const initiativeContext = await initiativeContextFor(run);
    const prompt = composePrompt(
      '# Task',
      '',
      run.task,
      runBrief(run, 1),
      promptSection('Phasing', phasingInstruction(run)),
      promptSection('Initiative context', initiativeContext),
      promptSection('Acceptance criteria required by the requester', run.requesterCriteria),
      promptSection('Clarifications provided by the human', clarifications),
      revision
        ? [
            promptSection('Task of round 1 (already implemented and committed on this branch)', revision.originalTask),
            promptSection('Plan of the previous round', loadPlanOfRun(revision.parentRunId)),
            promptSection(
              `Review comments on pull request #${revision.pullRequest.number} that the new plan MUST address`,
              (revision.comments.some(asksForChange) ? revision.comments.filter(asksForChange) : revision.comments).map(
                describeReviewComment,
              ),
            ),
          ].join('\n')
        : '',
      [
        '',
        '## Instructions',
        '',
        `1. Inspect the repository at \`${run.repoPath}\` with your tools before planning.`,
        '2. Ground every target file path in files that exist (or clearly mark them as new).',
        '3. Honour the convention cascade and list the rules that constrain this task.',
        clarifications
          ? '4. The clarifications above are authoritative: set `ambiguityLevel` to NONE or MINOR.'
          : '4. Use `ambiguityLevel: BLOCKING` only if a wrong guess would produce throw-away work.',
        '',
      ].join('\n'),
    );

    const started = Date.now();
    const result = await invokeAgent({
      agent: pmArchitectAgent,
      role: 'pm-architect',
      step: 'pm-architect',
      runId: run.runId,
      repoPath: run.repoPath,
      repoName: run.repoName,
      prompt,
      schema: executionPlanSchema,
      maxSteps: MAX_STEPS.plan,
      dryRunResult: stubExecutionPlan(run.task, run.stack, Boolean(clarifications)),
    });

    const plan = result.object;
    writeArtifact({
      runId: run.runId,
      step: 'pm-architect',
      status: plan.ambiguityLevel === 'BLOCKING' ? 'CLARIFICATION_REQUIRED' : 'COMPLETED',
      durationMs: Date.now() - started,
      model: result.servedByModel,
      data: { plan, clarificationsUsed: clarifications ?? null },
    });

    if (plan.ambiguityLevel === 'BLOCKING' && !resumeData) {
      if (run.interactive) {
        logger?.warn?.('[factory] plan requires clarification, suspending run', {
          runId: run.runId,
          questions: plan.clarificationQuestions,
        });
        appendEvent(run.runId, {
          type: 'run_suspended',
          step: 'plan',
          reason: 'CLARIFICATION_REQUIRED',
          questions: plan.clarificationQuestions,
          // First-pass reading of the task: the artifact holding it is overwritten by the
          // second pass, so keep it here for the clarification history.
          planSummary: plan.summary,
        });
        const clarificationPayload = {
          reason: 'CLARIFICATION_REQUIRED' as const,
          questions: plan.clarificationQuestions,
          planSummary: plan.summary,
          runId: run.runId,
        };
        writePendingInput(run.runId, { ...clarificationPayload, step: 'plan' });
        return await suspend(clarificationPayload);
      }
      logger?.warn?.('[factory] blocking ambiguity in non-interactive mode: proceeding on assumptions', {
        runId: run.runId,
      });
      appendEvent(run.runId, {
        type: 'ambiguity_accepted',
        step: 'plan',
        questions: plan.clarificationQuestions,
      });
    }

    let updatedRun: RunContext = clarifications ? { ...run, clarifications } : run;

    // The architect may have judged the request too big for one pull request. Only a new task can
    // become a project: a phase already has its roadmap, and a round belongs to a phase.
    const roadmap = run.initiative?.mode === 'new' && run.phasingMode !== 'off' ? roadmapFromPlan(plan, run.title ?? run.task) : null;
    if (roadmap && run.initiative) {
      const asked = [...readEvents(run.runId)].reverse().find((e) => e.type === 'run_suspended' && e.reason === 'CLARIFICATION_REQUIRED') as
        | { questions?: unknown }
        | undefined;
      const decisions = clarifications
        ? [{ questions: Array.isArray(asked?.questions) ? (asked.questions as string[]) : [], answer: clarifications, at: new Date().toISOString() }]
        : undefined;
      try {
        const saved = await withStore((store) => store.setRoadmap(run.initiative!.id, { ...roadmap, ...(decisions ? { decisions } : {}) }));
        updatedRun = { ...updatedRun, initiative: { ...run.initiative, total: saved.phases.length, title: saved.title } };
        appendEvent(run.runId, { type: 'roadmap_set', initiativeId: saved.id, phases: saved.phases.map((phase) => phase.title), reason: plan.phasing?.reason ?? '' });
        logger?.info?.(`[factory] the architect split this into ${saved.phases.length} phases; this run is phase 1`, { runId: run.runId });
      } catch (error) {
        // The plan is still good for a pull request: the roadmap can be written by hand in the Studio.
        appendEvent(run.runId, { type: 'initiative_unavailable', error: (error as Error).message });
      }
    }

    // After a re-plan the developer still gets the reviewer's own words, not only the new plan.
    return startCycle(updatedRun, plan, revision ? reviewFeedback(revision) : null);
  },
});

/* ========================================================================== */
/* Step 02 - developer                                                         */
/* ========================================================================== */

const developerStep = createStep({
  id: 'developer',
  description:
    'Developer agent: implements the plan (production code and tests) in the target repository, ' +
    'applying the triage feedback of previous attempts.',
  inputSchema: cycleStateSchema,
  outputSchema: cycleStateSchema,
  execute: async ({ inputData, mastra }) => {
    const state = inputData;
    const { run, plan, attempt, feedback } = state;
    const logger = mastra?.getLogger?.();

    // RE-RUN_INFRA: the previous failure was environmental, the code is believed correct.
    if (state.rerunInfra) {
      const report = {
        status: 'COMPLETED' as const,
        summary:
          'Infrastructure re-run requested by triage: no code change was made, the previous ' +
          'implementation is re-validated as-is.',
        changedFiles: [],
        testsAdded: [],
        commandsRun: [],
        appliedFeedback: feedback?.hints ?? [],
        selfVerification: {
          localTestsPassed: false,
          notes: 'Skipped: the quality gate re-runs the suite.',
        },
        followUps: [],
        blockers: [],
      };
      writeArtifact({
        runId: run.runId,
        step: 'developer',
        attempt,
        status: 'SKIPPED_INFRA_RERUN',
        data: report,
      });
      return {
        ...state,
        developerReport: report,
        phase: 'QA',
        rerunInfra: false,
      } satisfies CycleState;
    }

    const prompt = composePrompt(
      '# Implementation request',
      '',
      run.revision && attempt === 1
        ? `This is round ${run.revision.round} on pull request #${run.revision.pullRequest.number}. ` +
          "The branch already contains the previous rounds' work. Make only the changes the " +
          "reviewer's comments below ask for."
        : attempt === 1
          ? 'Implement the execution plan below.'
          : `This is fix iteration ${attempt} of ${run.maxAttempts}. Address the feedback below.`,
      runBrief(run, attempt),
      promptSection('Original task', run.revision?.originalTask ?? run.task),
      run.revision ? promptSection('This round', run.task) : '',
      promptSection('Clarifications from the human', run.clarifications),
      promptSection('Execution plan', plan),
      promptSection('PREVIOUS ATTEMPT FEEDBACK', feedback),
      promptSection('Previous QA failures', state.qaReport?.failures),
      promptSection('Review items that must be fixed', state.reviewReport?.mustFixBeforeMerge),
      promptSection('Security items that must be fixed', state.securityReport?.mustFixBeforeMerge),
      promptSection('Attempt history', state.history),
      [
        '',
        '## Instructions',
        '',
        '1. Read the target files before editing them; prefer `edit-file` for surgical changes.',
        `2. Verify locally with: \`${run.testCommand ?? 'the repository test command'}\`.`,
        '3. Never commit, push or switch branches: delivery is a later, dedicated step.',
        '4. Never delete, skip or weaken a test to make the build pass.',
        attempt > 1 || feedback
          ? '5. Report in `appliedFeedback` how you addressed each hint, and do not repeat a ' +
            'strategy listed in `doNotRetry`.'
          : '5. Keep the change strictly within the plan scope.',
        '',
      ].join('\n'),
    );

    const started = Date.now();
    const result = await invokeAgent({
      agent: developerAgent,
      role: 'developer',
      step: 'developer',
      runId: run.runId,
      attempt,
      repoPath: run.repoPath,
      repoName: run.repoName,
      prompt,
      schema: developerReportSchema,
      maxSteps: MAX_STEPS.developer,
      dryRunResult: stubDeveloperReport(attempt, feedback?.hints ?? []),
    });

    const report = result.object;
    writeArtifact({
      runId: run.runId,
      step: 'developer',
      attempt,
      status: report.status,
      durationMs: Date.now() - started,
      model: result.servedByModel,
      data: report,
    });

    // No backend grants agents a file-deletion tool (Claude Code has none, and the factory's
    // own filesystem tools deliberately expose only read/write/edit). Deletions are therefore
    // declared in the report and applied here, deterministically and inside the workspace jail.
    const deletions = applyDeclaredDeletions(run.repoPath, report, run.dryRun);
    if (deletions.length > 0) {
      logger?.info?.('[factory] applied declared file deletions', {
        runId: run.runId,
        attempt,
        deleted: deletions,
      });
      appendEvent(run.runId, {
        type: 'file_deletions_applied',
        attempt,
        files: deletions,
      });
    }

    logger?.info?.('[factory] developer step finished', {
      runId: run.runId,
      attempt,
      status: report.status,
      changedFiles: report.changedFiles.length,
      deleted: deletions.length,
    });

    return { ...state, developerReport: report, phase: 'QA' } satisfies CycleState;
  },
});

/* ========================================================================== */
/* Step 03 - QA & tester                                                       */
/* ========================================================================== */

/**
 * Removes files the developer report marks as `DELETED` but which still exist on disk.
 *
 * Gives agents a real delete capability without a shell: they declare the intent in their
 * structured output and the workflow performs it. Every path goes through `resolveInsideRepo`,
 * so a declared deletion cannot escape the repository or touch `.git`.
 */
function applyDeclaredDeletions(
  repoPath: string,
  report: DeveloperReport,
  dryRun: boolean,
): string[] {
  if (dryRun) return [];
  const deleted: string[] = [];

  for (const entry of report.changedFiles) {
    if (entry.changeType !== 'DELETED') continue;
    try {
      const absolute = resolveInsideRepo(repoPath, entry.path);
      if (!fs.existsSync(absolute)) continue;
      const stats = fs.statSync(absolute);
      // Only ever remove regular files: a declared directory deletion is too blunt to apply
      // automatically and is left for the human reviewer.
      if (!stats.isFile()) continue;
      fs.rmSync(absolute);
      deleted.push(entry.path);
    } catch {
      // Rejected paths (outside the repo, or .git) are ignored rather than fatal: the diff
      // and the review gate will surface anything that actually matters.
    }
  }
  return deleted;
}

const qaTesterStep = createStep({
  id: 'qa-tester',
  description:
    'QA agent: runs the build and test suite, validates the acceptance criteria and produces a ' +
    'structured verdict with bug reports.',
  inputSchema: cycleStateSchema,
  outputSchema: cycleStateSchema,
  execute: async ({ inputData, mastra }) => {
    const state = inputData;
    const { run, plan, attempt } = state;
    const logger = mastra?.getLogger?.();

    // Stage disabled for this task: record a passing, explicitly-skipped report and move on.
    if (!run.pipeline.qa) {
      const report = skippedQaReport();
      writeArtifact({
        runId: run.runId,
        step: 'qa-tester',
        attempt,
        status: 'SKIPPED',
        data: report,
      });
      logger?.info?.('[factory] QA stage skipped (disabled for this task)', {
        runId: run.runId,
        attempt,
      });
      return { ...state, qaReport: report };
    }

    // The implementation is blocked: do not spend tokens re-validating nothing.
    if (state.developerReport?.status === 'BLOCKED') {
      const report = blockedQaReport(state.developerReport.blockers.join(' | '));
      writeArtifact({
        runId: run.runId,
        step: 'qa-tester',
        attempt,
        status: report.verdict,
        data: report,
      });
      return { ...state, qaReport: report, phase: 'TRIAGE' } satisfies CycleState;
    }

    // Deterministic pre-execution of test and build: cheaper and more reliable than asking
    // the model to be the one that remembers to run them. The agent still runs targeted commands.
    const checks = await runChecks(run, qaChecksLabel(attempt));
    const preExecutedTest = checks.test ? testPayload(checks.test) : null;
    const preExecutedBuild = checks.build ? buildPayload(checks.build) : null;

    // The patch is embedded in the prompt rather than left to a tool round-trip: the QA agent must
    // be able to spot deleted or weakened tests from primary evidence, and that must not depend on
    // which tools the active backend happens to expose. The tests' diff comes first.
    const { view: changes } = await loadDiffView(run, attempt, 'qa');

    const prompt = composePrompt(
      '# Quality gate',
      '',
      `Validate attempt ${attempt} of the change below and return a structured verdict.`,
      runBrief(run, attempt),
      promptSection('Original task', run.task),
      promptSection('Acceptance criteria', plan.acceptanceCriteria),
      promptSection('Test strategy from the plan', plan.testStrategy),
      promptSection('Developer report', state.developerReport),
      promptSection('Changes under test', changes?.text),
      promptSection('PRE-EXECUTED TEST SUITE', preExecutedTest),
      promptSection('PRE-EXECUTED BUILD', preExecutedBuild),
      promptSection('Previous attempt failures', state.history),
      [
        '',
        '## Instructions',
        '',
        '1. Trust only commands you actually executed; report their real exit codes.',
        '2. Verify every acceptance criterion; use `http-probe` for API/E2E criteria.',
        '3. Inspect the diff for deleted, skipped, disabled or loosened tests and report it in ' +
          '`weakenedVerification`. The tests are shown first; if a test file is only partly shown, ' +
          'open it before you conclude nothing was weakened.',
        '4. Classify every failure (COMPILATION / PRODUCTION_DEFECT / TEST_DEFECT / ' +
          'INFRASTRUCTURE / FLAKY) with the evidence that justifies the label.',
        '',
      ].join('\n'),
    );

    const started = Date.now();
    const result = await invokeAgent({
      agent: qaTesterAgent,
      role: 'qa-tester',
      step: 'qa-tester',
      runId: run.runId,
      attempt,
      repoPath: run.repoPath,
      repoName: run.repoName,
      prompt,
      schema: qaReportSchema,
      maxSteps: MAX_STEPS.qa,
      dryRunResult: stubQaReport(attempt),
    });

    const report = result.object;
    writeArtifact({
      runId: run.runId,
      step: 'qa-tester',
      attempt,
      status: report.verdict,
      durationMs: Date.now() - started,
      model: result.servedByModel,
      data: report,
    });

    logger?.info?.('[factory] QA step finished', {
      runId: run.runId,
      attempt,
      verdict: report.verdict,
      failures: report.failures.length,
    });

    return {
      ...state,
      qaReport: report,
      phase: report.passed ? 'VERIFY' : 'TRIAGE',
    } satisfies CycleState;
  },
});

/* ========================================================================== */
/* Step 04 - triage (reused for QA failures and verification rejections)       */
/* ========================================================================== */

type TriageSource = 'QA' | 'CODE_REVIEW';

/**
 * Builds a triage step. The same evaluator serves both failure sources, which keeps the
 * root-cause analysis and the loop detection consistent across the whole run.
 */
function createTriageStep(id: string, source: TriageSource) {
  return createStep({
    id,
    description:
      'Triage agent: determines the root cause of the failure and routes the run ' +
      '(RETRY_DEVELOPER / RE-RUN_INFRA / ESCALATE_HUMAN / APPROVE_AND_CONTINUE).',
    inputSchema: cycleStateSchema,
    outputSchema: cycleStateSchema,
    execute: async ({ inputData, mastra }) => {
      const state = inputData;
      const { run, attempt } = state;
      const logger = mastra?.getLogger?.();
      const atBudget = attempt >= run.maxAttempts;

      const prompt = composePrompt(
        '# Failure triage',
        '',
        source === 'QA'
          ? 'The quality gate rejected the change. Determine the root cause and route the run.'
          : 'The code review and/or the security audit requested changes. Determine the root ' +
            'cause and route the run.',
        runBrief(run, attempt),
        promptSection('Original task', run.task),
        promptSection('Execution plan', {
          summary: state.plan.summary,
          acceptanceCriteria: state.plan.acceptanceCriteria,
          tasks: state.plan.tasks,
        }),
        promptSection('Developer report (current attempt)', state.developerReport),
        promptSection('QA report', state.qaReport),
        promptSection('Code review report', state.reviewReport),
        promptSection('Security report', state.securityReport),
        promptSection('Attempt history (oldest first)', state.history),
        promptSection('Previous triage decision', state.triageReport),
        promptSection('Available run artifacts', listArtifacts(run.runId)),
        [
          '',
          '## Instructions',
          '',
          `1. Attempt ${attempt} of ${run.maxAttempts}.${
            atBudget ? ' The attempt budget is exhausted after this iteration.' : ''
          }`,
          '2. Use `read-run-artifacts` to compare this attempt with the previous ones before ' +
            'deciding, and state in `loopEvidence` whether the failure is repeating.',
          '3. `developerHints` must be concrete, reference files/symbols and differ from the ' +
            'hints already given.',
          '4. Never recommend deleting, skipping or weakening a test.',
          '',
        ].join('\n'),
      );

      const started = Date.now();
      const result = await invokeAgent({
        agent: triageAgent,
        role: 'triage',
        step: 'triage',
        runId: run.runId,
        attempt,
        repoPath: run.repoPath,
        repoName: run.repoName,
        prompt,
        schema: triageReportSchema,
        maxSteps: MAX_STEPS.triage,
        dryRunResult: stubTriageReport(attempt, source),
      });

      const report = result.object;

      /* --- deterministic guardrails over the model decision --------------- */
      let decision = report.decision;
      const overrides: string[] = [];

      if (decision === 'APPROVE_AND_CONTINUE' && hasBlockingQuality(state)) {
        decision = atBudget ? 'ESCALATE_HUMAN' : 'RETRY_DEVELOPER';
        overrides.push(
          'APPROVE_AND_CONTINUE rejected: a blocking quality or security gate is still failing.',
        );
      }
      if (report.loopDetected && decision !== 'ESCALATE_HUMAN') {
        decision = 'ESCALATE_HUMAN';
        overrides.push('Loop detected by the evaluator: escalating instead of retrying.');
      }
      if (atBudget && (decision === 'RETRY_DEVELOPER' || decision === 'RE-RUN_INFRA')) {
        decision = 'ESCALATE_HUMAN';
        overrides.push(
          `Attempt budget exhausted (${attempt}/${run.maxAttempts}): escalating to a human.`,
        );
      }

      const effectiveReport = { ...report, decision };
      writeArtifact({
        runId: run.runId,
        step: 'triage',
        attempt,
        status: decision,
        durationMs: Date.now() - started,
        model: result.servedByModel,
        data: {
          source,
          modelDecision: report.decision,
          effectiveDecision: decision,
          guardrailOverrides: overrides,
          report: effectiveReport,
        },
      });
      if (overrides.length > 0) {
        appendEvent(run.runId, {
          type: 'triage_guardrail',
          attempt,
          modelDecision: report.decision,
          effectiveDecision: decision,
          overrides,
        });
      }
      logger?.info?.('[factory] triage decision', {
        runId: run.runId,
        attempt,
        source,
        decision,
        rootCause: report.rootCause.category,
      });

      /* --- apply the decision to the loop state --------------------------- */
      const withReport: CycleState = {
        ...state,
        triageReport: effectiveReport,
        triageAttempt: attempt,
      };
      const history = appendHistory(withReport, `${source} failure triaged as ${decision}`);

      if (decision === 'APPROVE_AND_CONTINUE') {
        return {
          ...withReport,
          history,
          phase: 'DONE',
          cycleComplete: true,
          escalate: false,
          escalationReason: null,
          rerunInfra: false,
          feedback: null,
        } satisfies CycleState;
      }

      if (decision === 'ESCALATE_HUMAN') {
        return {
          ...withReport,
          history,
          phase: 'ESCALATED',
          cycleComplete: false,
          escalate: true,
          escalationReason:
            report.escalationSummary.trim() !== ''
              ? report.escalationSummary
              : `${report.rootCause.category}: ${report.rootCause.explanation}`,
          rerunInfra: false,
          feedback: null,
        } satisfies CycleState;
      }

      const feedback: Feedback = {
        source: decision === 'RE-RUN_INFRA' ? 'INFRA' : source === 'QA' ? 'QA' : 'CODE_REVIEW',
        attempt,
        hints: decision === 'RE-RUN_INFRA' ? report.infraActions : report.developerHints,
        filesToInspect: report.filesToInspect,
        failingTests: (state.qaReport?.failures ?? []).map((failure) => failure.testId),
        doNotRetry: state.history
          .map((item) => item.notes)
          .filter((note) => note.trim() !== '')
          .slice(-3),
        notes: `${report.summary} (root cause: ${report.rootCause.category})`,
      };

      return {
        ...withReport,
        history,
        attempt: attempt + 1,
        phase: 'DEVELOP',
        cycleComplete: false,
        escalate: false,
        escalationReason: null,
        rerunInfra: decision === 'RE-RUN_INFRA',
        feedback,
        reviewReport: null,
        securityReport: null,
      } satisfies CycleState;
    },
  });
}

const triageQaStep = createTriageStep('triage-qa', 'QA');
const triageVerificationStep = createTriageStep('triage-verification', 'CODE_REVIEW');

/* ========================================================================== */
/* Steps 05 / 06 - code review and security (parallel)                         */
/* ========================================================================== */

const codeReviewStep = createStep({
  id: 'code-review',
  description:
    'Reviewer agent: validates the diff against the convention cascade, the architecture and ' +
    'maintainability criteria.',
  inputSchema: cycleStateSchema,
  outputSchema: cycleStateSchema,
  execute: async ({ inputData, mastra }) => {
    const state = inputData;
    const { run, attempt } = state;
    const logger = mastra?.getLogger?.();

    // Stage disabled for this task: approve without reviewing, and say so in the artifact.
    if (!run.pipeline.review) {
      const report = skippedReviewReport();
      writeArtifact({
        runId: run.runId,
        step: 'code-review',
        attempt,
        status: 'SKIPPED',
        data: report,
      });
      logger?.info?.('[factory] review stage skipped (disabled for this task)', {
        runId: run.runId,
        attempt,
      });
      return { ...state, reviewReport: report };
    }

    const { view: changes } = await loadDiffView(run, attempt, 'review');

    const prompt = composePrompt(
      '# Code review',
      '',
      'Review the change below and decide whether it is fit to merge.',
      runBrief(run, attempt),
      promptSection('Original task', run.task),
      promptSection('Acceptance criteria', state.plan.acceptanceCriteria),
      promptSection('Convention notes from the plan', state.plan.conventionNotes),
      promptSection('Developer report', state.developerReport),
      promptSection('QA report (summary)', {
        verdict: state.qaReport?.verdict,
        totals: state.qaReport?.totals,
        weakenedVerification: state.qaReport?.weakenedVerification,
        // What QA flagged, so the review builds on it instead of finding it again from scratch (the
        // same one-line fix was reported separately by QA and by the reviewer in a real run).
        bugReports: state.qaReport?.bugReports?.map((bug) => ({
          title: bug.title,
          severity: bug.severity,
          evidence: bug.evidence,
        })),
      }),
      promptSection('Changes under review', changes?.text),
      [
        '',
        '## Instructions',
        '',
        '1. If a file is only partly shown, or not shown, open it before you judge it: an approval ' +
          'covers only what you looked at. Use `git-diff` yourself if you need more context.',
        '2. Report only findings a developer can act on: file, problem, expected change.',
        '3. `CHANGES_REQUESTED` requires at least one BLOCKER or MAJOR finding.',
        '4. Treat deleted, skipped or weakened tests as a BLOCKER.',
        '',
      ].join('\n'),
    );

    const started = Date.now();
    const result = await invokeAgent({
      agent: reviewerAgent,
      role: 'reviewer',
      step: 'code-review',
      runId: run.runId,
      attempt,
      repoPath: run.repoPath,
      repoName: run.repoName,
      prompt,
      schema: reviewReportSchema,
      maxSteps: MAX_STEPS.review,
      dryRunResult: stubReviewReport(attempt),
    });

    const report = result.object;
    writeArtifact({
      runId: run.runId,
      step: 'code-review',
      attempt,
      status: report.status,
      durationMs: Date.now() - started,
      model: result.servedByModel,
      data: report,
    });
    logger?.info?.('[factory] code review finished', {
      runId: run.runId,
      attempt,
      status: report.status,
      findings: report.findings.length,
    });

    return { ...state, reviewReport: report };
  },
});

const securityStep = createStep({
  id: 'security-scan',
  description:
    'Security agent: audits the diff for OWASP Top 10 issues, hardcoded secrets, injection ' +
    'flaws and dependency risks.',
  inputSchema: cycleStateSchema,
  outputSchema: cycleStateSchema,
  execute: async ({ inputData, mastra }) => {
    const state = inputData;
    const { run, attempt } = state;
    const logger = mastra?.getLogger?.();

    // Stage disabled for this task: pass without auditing, and say so in the artifact.
    if (!run.pipeline.security) {
      const report = skippedSecurityReport();
      writeArtifact({
        runId: run.runId,
        step: 'security',
        attempt,
        status: 'SKIPPED',
        data: report,
      });
      logger?.info?.('[factory] security stage skipped (disabled for this task)', {
        runId: run.runId,
        attempt,
      });
      return { ...state, securityReport: report };
    }

    const { view: changes } = await loadDiffView(run, attempt, 'security');

    const prompt = composePrompt(
      '# Security audit',
      '',
      'Audit the change below for security regressions.',
      runBrief(run, attempt),
      promptSection('Original task', run.task),
      promptSection('Developer report', state.developerReport),
      promptSection('Changes under audit', changes?.text),
      [
        '',
        '## Instructions',
        '',
        '1. If a file is only partly shown, or not shown, open it before you clear it: a pass covers ' +
          'only what you looked at. Trace untrusted input from entry point to sink before claiming a vulnerability.',
        '2. Only raise CRITICAL/HIGH for defensible, exploitable findings in this diff.',
        '3. Mask any secret you report; never reproduce its full value.',
        '4. Mark issues outside the diff as `preExisting: true` (they do not block this change).',
        '',
      ].join('\n'),
    );

    const started = Date.now();
    const result = await invokeAgent({
      agent: securityAgent,
      role: 'security',
      step: 'security',
      runId: run.runId,
      attempt,
      repoPath: run.repoPath,
      repoName: run.repoName,
      prompt,
      schema: securityReportSchema,
      maxSteps: MAX_STEPS.security,
      dryRunResult: stubSecurityReport(attempt),
    });

    const report = result.object;
    writeArtifact({
      runId: run.runId,
      step: 'security',
      attempt,
      status: `${report.status}/${report.riskLevel}`,
      durationMs: Date.now() - started,
      model: result.servedByModel,
      data: report,
    });
    logger?.info?.('[factory] security scan finished', {
      runId: run.runId,
      attempt,
      status: report.status,
      riskLevel: report.riskLevel,
    });

    return { ...state, securityReport: report };
  },
});

/** Merges the two parallel verification branches back into a single cycle state. */
const verificationMergeStep = createStep({
  id: 'verification-merge',
  description: 'Combines the code review and security results into the iteration state.',
  inputSchema: z.object({
    'code-review': cycleStateSchema,
    'security-scan': cycleStateSchema,
  }),
  outputSchema: cycleStateSchema,
  execute: async ({ inputData }) => {
    const review = inputData['code-review'];
    const security = inputData['security-scan'];
    return {
      ...review,
      securityReport: security.securityReport,
      phase: 'VERIFY',
    } satisfies CycleState;
  },
});

/** Both gates satisfied: the iteration is complete. */
const markCompleteStep = createStep({
  id: 'mark-complete',
  description: 'Marks the iteration as complete when QA, review and security are all satisfied.',
  inputSchema: cycleStateSchema,
  outputSchema: cycleStateSchema,
  execute: async ({ inputData, mastra }) => {
    const state = inputData;
    mastra?.getLogger?.()?.info?.('[factory] all quality gates satisfied', {
      runId: state.run.runId,
      attempt: state.attempt,
    });
    appendEvent(state.run.runId, {
      type: 'gates_passed',
      attempt: state.attempt,
      review: reportedGate(state.run.pipeline.review, state.reviewReport?.status),
      security: reportedGate(state.run.pipeline.security, state.securityReport?.status),
    });
    return {
      ...state,
      history: appendHistory(state, 'All quality gates satisfied'),
      phase: 'DONE',
      cycleComplete: true,
      escalate: false,
      feedback: null,
    } satisfies CycleState;
  },
});

/** Unifies the verification branch outputs. */
const verificationResolveStep = createStep({
  id: 'verification-resolve',
  description: 'Normalises the verification branch output into the iteration state.',
  inputSchema: z.object({
    'mark-complete': cycleStateSchema.optional(),
    'triage-verification': cycleStateSchema.optional(),
  }),
  outputSchema: cycleStateSchema,
  execute: async ({ inputData }) => {
    const resolved = inputData['mark-complete'] ?? inputData['triage-verification'];
    if (!resolved) throw new Error('Verification phase produced no state.');
    return resolved;
  },
});

const verificationPhase = createWorkflow({
  id: 'verification-phase',
  description: 'Parallel code review and security audit, followed by the approval decision.',
  inputSchema: cycleStateSchema,
  outputSchema: cycleStateSchema,
})
  .parallel([codeReviewStep, securityStep], {
    id: 'review-and-security',
    description: 'Code review and security audit run simultaneously on the same diff.',
  })
  .then(verificationMergeStep)
  .branch([
    [
      async ({ inputData }) =>
        inputData.reviewReport?.status !== 'CHANGES_REQUESTED' &&
        inputData.securityReport?.status !== 'CHANGES_REQUESTED',
      markCompleteStep,
    ],
    [
      async ({ inputData }) =>
        inputData.reviewReport?.status === 'CHANGES_REQUESTED' ||
        inputData.securityReport?.status === 'CHANGES_REQUESTED',
      triageVerificationStep,
    ],
  ])
  .then(verificationResolveStep)
  .commit();

/* ========================================================================== */
/* Implementation cycle (the intelligent loop)                                 */
/* ========================================================================== */

/** Unifies the QA branch outputs (triage or verification phase). */
const cycleResolveStep = createStep({
  id: 'cycle-resolve',
  description: 'Normalises the QA branch output into the iteration state.',
  inputSchema: z.object({
    'triage-qa': cycleStateSchema.optional(),
    'verification-phase': cycleStateSchema.optional(),
  }),
  outputSchema: cycleStateSchema,
  execute: async ({ inputData }) => {
    const resolved = inputData['triage-qa'] ?? inputData['verification-phase'];
    if (!resolved) throw new Error('Implementation cycle produced no state.');
    return resolved;
  },
});

const implementationCycle = createWorkflow({
  id: 'implementation-cycle',
  description:
    'One develop -> QA -> (triage | review + security) iteration. Repeats until every gate is ' +
    'satisfied or the triage agent escalates to a human.',
  inputSchema: cycleStateSchema,
  outputSchema: cycleStateSchema,
})
  .then(developerStep)
  .then(qaTesterStep)
  .branch([
    [async ({ inputData }) => inputData.qaReport?.passed !== true, triageQaStep],
    [async ({ inputData }) => inputData.qaReport?.passed === true, verificationPhase],
  ])
  .then(cycleResolveStep)
  .commit();

/* ========================================================================== */
/* Step 07 - documentation                                                     */
/* ========================================================================== */

/* ========================================================================== */
/* Step 06b - polish: the minor findings of the gates, fixed in one checked pass */
/* ========================================================================== */

/**
 * The polish pass, run at the start of the documentation step.
 *
 * It is not a step of its own on purpose. Mastra resumes a nested workflow by position: with a new
 * step in front of the delivery gate, a run left suspended there by an older version resumes one step
 * early and the PR writer runs a second time (checked against Mastra with a nested workflow suspended
 * under the old graph). Its artifact (`06-polish.json`), its events and its place in the Studio are
 * what make it a stage; where it sits in the code does not change that.
 *
 * It cannot fail the run: whatever goes wrong inside it leaves the working tree as it was and is
 * recorded as the result. The one exception is not being able to undo it, which stops the run.
 */
async function polishFindings(
  state: CycleState,
  logger: { info?: (...args: any[]) => void } | undefined,
): Promise<PolishResult> {
  const { run, attempt } = state;

  // A retry of the delivery comes back through here. The fixes of a pass that completed are in the
  // working tree already; asking again would pay twice for the same findings.
  const earlierArtifact = readArtifact(run.runId, artifactFileName('polish')) as { status?: string; data?: unknown } | null;
  const earlier = polishResultSchema.safeParse(earlierArtifact?.data);
  if (earlier.success && earlierArtifact?.status !== 'FAILED') return earlier.data;

  appendEvent(run.runId, { type: 'polish_started' });
  const started = Date.now();
  let servedBy: string | undefined;

  const result = await runPolishPass(
    {
      gates: { qa: state.qaReport, review: state.reviewReport, security: state.securityReport },
      enabled: run.pipeline.polish !== false,
      qaEnabled: run.pipeline.qa,
      dryRun: run.dryRun,
      before: state.qaReport?.totals ?? null,
      context: [
        runBrief(run, attempt),
        promptSection('Original task', run.revision?.originalTask ?? run.task),
        run.revision ? promptSection('This round', run.task) : '',
        promptSection('Execution plan', { summary: state.plan.summary, acceptanceCriteria: state.plan.acceptanceCriteria }),
      ],
    },
    {
      snapshot: () => snapshotWorkingTree(run.repoPath),
      restore: (tree) => restoreWorkingTree(run.repoPath, tree),
      changesSince: (tree) => changesSince(run.repoPath, tree),
      runChecks: async () => toCheckResult(await runChecks(run, polishChecksLabel)),
      askDeveloper: async (prompt, candidates) => {
        const answer = await invokeAgent({
          agent: developerAgent,
          role: 'developer',
          step: 'polish',
          runId: run.runId,
          attempt,
          repoPath: run.repoPath,
          repoName: run.repoName,
          prompt,
          schema: developerReportSchema,
          maxSteps: MAX_STEPS.developer,
          dryRunResult: {
            ...stubDeveloperReport(attempt, []),
            summary: '[dry-run] Polished the minor findings.',
            appliedFeedback: candidates.map((candidate) => `${candidate.id}: [dry-run] applied`),
          },
        });
        servedBy = answer.servedByModel;
        return answer.object;
      },
      note: (event) => appendEvent(run.runId, event as { type: string }),
    },
  );

  writeArtifact({
    runId: run.runId,
    step: 'polish',
    status: result.status,
    durationMs: Date.now() - started,
    ...(servedBy ? { model: servedBy } : {}),
    data: result,
  });
  logger?.info?.('[factory] polish pass finished', {
    runId: run.runId,
    status: result.status,
    applied: result.applied.length,
    asked: result.candidates.length,
  });
  return result;
}

const documentationStep = createStep({
  id: 'documentation',
  description:
    'First the polish pass (the minor findings of the gates, fixed once and checked), then the ' +
    'documentation agent: decides whether the change invalidates the documentation (README, ' +
    'CHANGELOG, docs, OpenAPI, AGENTS.md) and updates exactly that. Optional - the pull-request ' +
    'text is written by the PR writer, which always runs.',
  inputSchema: cycleStateSchema,
  outputSchema: z.object({
    cycle: cycleStateSchema,
    documentation: documentationReportSchema,
  }),
  execute: async ({ inputData, mastra }) => {
    const state = inputData;
    const { run, attempt } = state;
    const logger = mastra?.getLogger?.();

    // First, the minor findings of the gates: the documentation describes the code as it ends up.
    await polishFindings(state, logger);

    const diff = run.dryRun ? { diff: '', files: [] } : await getDiff(run.repoPath);

    // Stage disabled for this task: no docs work. (The pull-request text does not depend on this
    // stage - the PR writer step that follows always writes it.)
    if (!run.pipeline.documentation) {
      const report = skippedDocumentationReport();
      writeArtifact({
        runId: run.runId,
        step: 'documentation',
        status: 'SKIPPED',
        data: report,
      });
      logger?.info?.('[factory] documentation stage skipped (disabled for this task)', {
        runId: run.runId,
      });
      return { cycle: state, documentation: report };
    }

    const prompt = composePrompt(
      '# Documentation',
      '',
      'The change passed QA, code review and the security audit. Decide whether it makes any ' +
        'documentation wrong or incomplete, and update exactly that. If nothing needs updating, say so.',
      runBrief(run, attempt),
      promptSection('Original task', run.task),
      promptSection('Execution plan', {
        summary: state.plan.summary,
        acceptanceCriteria: state.plan.acceptanceCriteria,
        commitMessage: state.plan.commitMessage,
      }),
      promptSection('Developer report', state.developerReport),
      promptSection('QA report (summary)', {
        verdict: state.qaReport?.verdict,
        totals: state.qaReport?.totals,
        executedCommands: state.qaReport?.executedCommands,
      }),
      promptSection('Code review (summary)', {
        status: state.reviewReport?.status,
        summary: state.reviewReport?.summary,
      }),
      promptSection('Security (summary)', {
        status: state.securityReport?.status,
        riskLevel: state.securityReport?.riskLevel,
      }),
      promptSection('Changed files', diff.files),
      [
        '',
        '## Instructions',
        '',
        '1. Read the existing documentation and match its format before writing.',
        '2. Only write documentation files; never touch code, tests or build files.',
        '3. Every statement you write must be backed by the diff or the reports above.',
        '4. Do not write the commit message or the pull-request text: another agent does that.',
        '',
      ].join('\n'),
    );

    const started = Date.now();
    const result = await invokeAgent({
      agent: documentationAgent,
      role: 'documentation',
      step: 'documentation',
      runId: run.runId,
      attempt,
      repoPath: run.repoPath,
      repoName: run.repoName,
      prompt,
      schema: documentationReportSchema,
      maxSteps: MAX_STEPS.documentation,
      dryRunResult: stubDocumentationReport(),
    });

    const report = result.object;
    writeArtifact({
      runId: run.runId,
      step: 'documentation',
      attempt,
      status: report.status,
      durationMs: Date.now() - started,
      model: result.servedByModel,
      data: report,
    });
    logger?.info?.('[factory] documentation step finished', {
      runId: run.runId,
      status: report.status,
      updatedFiles: report.updatedFiles.length,
    });

    return { cycle: state, documentation: report };
  },
});

/* ========================================================================== */
/* Step 07b - pull-request text (PR writer)                                    */
/* ========================================================================== */

/** The polish pass of the run, as recorded (`null` for a run that never reached it). */
export function readPolishResult(runId: string): PolishResult | null {
  const parsed = polishResultSchema.safeParse((readArtifact(runId, artifactFileName('polish')) as { data?: unknown } | null)?.data);
  return parsed.success ? parsed.data : null;
}

/** What the PR writer works from, taken from the state of the cycle. */
function prTextContext(
  state: CycleState,
  documentation: z.infer<typeof documentationReportSchema> | null,
  files: string[],
  roadmap: RoadmapView | null = null,
): PrTextContext {
  return {
    roadmap,
    polish: readPolishResult(state.run.runId),
    task: state.run.task,
    plan: state.plan,
    developer: state.developerReport,
    qa: state.qaReport,
    review: state.reviewReport,
    security: state.securityReport,
    documentation,
    pipeline: state.run.pipeline,
    files,
    coverage: diffCoverageNotes(state.run.runId),
  };
}

/** The briefing of the PR writer: the reports (stages that were switched off are named as such) and the diff. */
function buildPrWriterPrompt(input: {
  state: CycleState;
  documentation: z.infer<typeof documentationReportSchema>;
  files: string[];
  diff: ReturnType<typeof condenseDiff>;
  recentSubjects: string[];
  roadmap: RoadmapView | null;
}): string {
  const { state, documentation, diff } = input;
  const { run } = state;

  const switchedOff = (
    [
      [run.pipeline.qa, 'QA'],
      [run.pipeline.review, 'Code review'],
      [run.pipeline.security, 'Security audit'],
      [run.pipeline.documentation, 'Documentation'],
    ] as const
  )
    .filter(([enabled]) => !enabled)
    .map(([, name]) => name);

  const notShown: string[] = [];
  if (diff.omitted.length > 0) notShown.push(`Left out of the diff (generated, or too large): ${diff.omitted.join(', ')}`);
  if (diff.shortened.length > 0) notShown.push(`Cut short in the diff: ${diff.shortened.join(', ')}`);

  return composePrompt(
    '# Commit message and pull request',
    '',
    'The change is finished. Write its commit message, the pull-request title and the pull-request ' +
      'description, from the diff and the reports below.',
    promptSection('Original task', run.task),
    promptSection('Execution plan', {
      summary: state.plan.summary,
      acceptanceCriteria: state.plan.acceptanceCriteria,
      // Written before any code existed: a starting point, not an answer.
      draftCommitMessage: state.plan.commitMessage,
    }),
    promptSection('Developer report', {
      summary: state.developerReport?.summary,
      changedFiles: state.developerReport?.changedFiles,
      testsAdded: state.developerReport?.testsAdded,
      followUps: state.developerReport?.followUps,
    }),
    run.pipeline.qa
      ? promptSection('QA report (summary)', {
          verdict: state.qaReport?.verdict,
          totals: state.qaReport?.totals,
          executedCommands: state.qaReport?.executedCommands?.map((c) => ({ command: c.command, exitCode: c.exitCode })),
        })
      : '',
    run.pipeline.review
      ? promptSection('Code review (summary)', { status: state.reviewReport?.status, summary: state.reviewReport?.summary })
      : '',
    run.pipeline.security
      ? promptSection('Security audit (summary)', {
          status: state.securityReport?.status,
          riskLevel: state.securityReport?.riskLevel,
        })
      : '',
    run.pipeline.documentation
      ? promptSection('Documentation step', {
          status: documentation.status,
          summary: documentation.summary,
          updatedFiles: documentation.updatedFiles,
          changelogEntry: documentation.changelogEntry,
          followUps: documentation.followUps,
        })
      : '',
    promptSection(
      'Roadmap (this pull request is one phase of a bigger piece of work; the factory adds a Roadmap section itself - do not write one)',
      input.roadmap
        ? [`This is phase ${input.roadmap.current} of ${input.roadmap.total} of "${input.roadmap.title}".`, ...input.roadmap.phases.map((p) => `${p.ordinal}. ${p.title} [${p.status}]`)].join('\n')
        : '',
    ),
    promptSection('Stages switched off for this task (they did not run - never describe them as having run)', switchedOff.join(', ')),
    promptSection(
      'Minor findings after the gates (the factory adds these to Quality gates and Follow-ups itself: do not repeat them)',
      (() => {
        const note = polishNote(readPolishResult(run.runId));
        return note ? [note.line, ...note.followUps.map((item) => `- not fixed: ${item}`)].join('\n') : '';
      })(),
    ),
    promptSection('Files changed', input.files),
    promptSection('Diff - the source of truth', diff.text === '' ? null : `\`\`\`diff\n${diff.text}\n\`\`\``),
    promptSection('What you were not shown', notShown.join('\n')),
    promptSection(
      `Recent commit subjects on ${run.baseBranch} (match this style)`,
      input.recentSubjects.map((line) => `- ${line}`).join('\n'),
    ),
    [
      '',
      '## Instructions',
      '',
      '1. The diff is the source of truth: write about what it shows, not about what the task or the plan intended.',
      '2. Do not write a "Quality gates" section - the factory adds it from the real results.',
      '3. Do not mention the factory, agents, AI or review rounds.',
      '',
    ].join('\n'),
  );
}

/** The briefing for the commit message of a round: what it was asked, what changed, and the style around it. */
function buildRoundCommitPrompt(input: {
  state: CycleState;
  revision: Revision;
  files: string[];
  diff: DiffView | null;
  recentSubjects: string[];
}): string {
  const { state, revision, diff } = input;
  const asked = revision.comments.some(asksForChange) ? revision.comments.filter(asksForChange) : revision.comments;

  return composePrompt(
    '# Commit message for a round',
    '',
    `Pull request #${revision.pullRequest.number} is already open. This is round ${revision.round}: it adds one commit to the branch. ` +
      'Write that commit\'s message from the change below.',
    promptSection('What this round was asked to do', state.run.task),
    promptSection('Review comments it answers (context - do not quote them)', asked.map(describeReviewComment)),
    promptSection('The developer report', {
      summary: state.developerReport?.summary,
      changedFiles: state.developerReport?.changedFiles,
      appliedFeedback: state.developerReport?.appliedFeedback,
    }),
    promptSection('Changes of this round (the commits of the earlier rounds are not part of it)', diff?.text),
    promptSection(
      `Recent commit subjects on ${state.run.baseBranch} (match this style)`,
      input.recentSubjects.map((line) => `- ${line}`).join('\n'),
    ),
    ['', '## Instructions', '', '1. The diff is the source of truth: describe what it shows.', '2. Return only `commitMessage`.', ''].join('\n'),
  );
}

/**
 * The message of the commit a round adds, written by the PR writer from this round's diff. The pull
 * request's title and description are not touched (they are empty here and delivery does not send them).
 *
 * If the writer cannot answer, the message is built from the round itself (`revisionCommitMessage`) -
 * what the commit said before this step existed - and the artifact says so. It never blocks a round.
 */
async function writeRoundCommit(
  state: CycleState,
  logger: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void } | undefined,
): Promise<PrText> {
  const { run, attempt } = state;
  const revision = run.revision!;
  const noPullRequestText = { title: '', body: '', labels: [] as string[], breakingChanges: false };
  const standIn = (note: string): PrText => ({
    commitMessage: revisionCommitMessage(revision),
    pullRequest: noPullRequestText,
    source: 'fallback',
    note,
  });

  const diff = run.dryRun ? { diff: '', files: [] as string[] } : await getFullDiff(run.repoPath);
  if (!run.dryRun && diff.files.length === 0) {
    const prText = standIn('The round changed no files, so there was nothing to describe.');
    writeArtifact({ runId: run.runId, step: 'pr-writer', attempt, status: 'SKIPPED', data: { reason: 'NO_CHANGES', ...prText } });
    logger?.info?.('[factory] pr-writer skipped: the round changed nothing', { runId: run.runId });
    return prText;
  }

  const started = Date.now();
  try {
    const view = run.dryRun ? null : viewDiff(diff.diff, { budgetChars: 60_000 });
    const recentSubjects = run.dryRun ? [] : await recentCommitSubjects(run.repoPath, run.baseBranch);
    const result = await invokeAgent({
      agent: prWriterAgent,
      role: 'pr-writer',
      step: 'pr-writer',
      runId: run.runId,
      attempt,
      repoPath: run.repoPath,
      repoName: run.repoName,
      prompt: buildRoundCommitPrompt({ state, revision, files: diff.files, diff: view, recentSubjects }),
      schema: roundCommitSchema,
      dryRunResult: stubRoundCommit(),
    });

    const { subject, body } = result.object.commitMessage;
    const message = composeCommitMessage(subject, body);
    const prText: PrText = message.trim() === '' ? standIn('The writer gave an empty message.') : { commitMessage: message, pullRequest: noPullRequestText, source: 'agent' };
    writeArtifact({
      runId: run.runId,
      step: 'pr-writer',
      attempt,
      status: prText.source === 'agent' ? 'COMPLETED' : 'FALLBACK',
      durationMs: Date.now() - started,
      model: result.servedByModel,
      data: { reason: 'ROUND', round: revision.round, ...prText },
    });
    logger?.info?.('[factory] pr-writer wrote the commit message of the round', { runId: run.runId, round: revision.round });
    return prText;
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    const prText = standIn(`The AI could not write this message (${explainAgentFailure(message)}). It was built from the round instead - read it, and edit it if you like.`);
    appendEvent(run.runId, { type: 'pr_writer_fallback', error: message });
    writeArtifact({
      runId: run.runId,
      step: 'pr-writer',
      attempt,
      status: 'FALLBACK',
      durationMs: Date.now() - started,
      data: { reason: 'ROUND', round: revision.round, ...prText, error: message },
    });
    logger?.warn?.(`[factory] pr-writer fell back to the plain message for the round: ${message}`, { runId: run.runId });
    return prText;
  }
}

/**
 * Step 07b - the commit message, the pull-request title and the pull-request description.
 *
 * **Mandatory**: it has no switch in the pipeline configuration and it always yields text. The
 * documentation stage used to write this text, so a task that turned documentation off was published
 * with a placeholder title and an empty description. Now the two are independent: this step decides
 * how the change is described, the documentation step decides whether the docs need to change.
 *
 * It does not call the agent in two cases that need no model: a further round on an existing pull
 * request (the title and description are already on GitHub, possibly edited by a person; the commit
 * message describes the round), and a run that changed nothing. If the agent cannot answer, the same
 * text is built from the reports, and the artifact and the delivery gate say so.
 */
// Exported so it can be exercised directly, like the delivery step.
export const prWriterStep = createStep({
  id: 'pr-writer',
  description:
    'PR writer agent: writes the commit message, the pull-request title and the pull-request ' +
    'description from the final diff and the reports. Mandatory - it runs whatever the pipeline selection.',
  inputSchema: z.object({
    cycle: cycleStateSchema,
    documentation: documentationReportSchema,
  }),
  outputSchema: z.object({
    cycle: cycleStateSchema,
    documentation: documentationReportSchema,
    prText: prTextSchema,
  }),
  execute: async ({ inputData, mastra }) => {
    const { cycle: state, documentation } = inputData;
    const { run, attempt } = state;
    const logger = mastra?.getLogger?.();
    const done = (prText: PrText) => ({ cycle: state, documentation, prText });

    // A further round on an open pull request: its title and description already exist, so the writer
    // is asked for the message of the one commit the round adds - and for nothing else.
    if (run.revision) return done(await writeRoundCommit(state, mastra?.getLogger?.()));

    const diff = run.dryRun ? { diff: '', files: [] } : await getFullDiff(run.repoPath);
    const roadmap = await loadRoadmapView(run.initiative);
    const context = prTextContext(state, documentation, diff.files, roadmap);

    if (!run.dryRun && diff.files.length === 0) {
      const prText = fallbackPrText(context, 'The run changed no files, so there was nothing to describe.');
      writeArtifact({ runId: run.runId, step: 'pr-writer', attempt, status: 'SKIPPED', data: { reason: 'NO_CHANGES', ...prText } });
      logger?.info?.('[factory] pr-writer skipped: nothing changed', { runId: run.runId });
      return done(prText);
    }

    const started = Date.now();
    try {
      const recentSubjects = run.dryRun ? [] : await recentCommitSubjects(run.repoPath, run.baseBranch);
      const condensed = condenseDiff(diff.diff, { maxChars: 60_000 });
      if (!run.dryRun) writeContextBlock(run.runId, 'pr-writer-diff.patch', condensed.text);

      const result = await invokeAgent({
        agent: prWriterAgent,
        role: 'pr-writer',
        step: 'pr-writer',
        runId: run.runId,
        attempt,
        repoPath: run.repoPath,
        repoName: run.repoName,
        prompt: buildPrWriterPrompt({ state, documentation, files: diff.files, diff: condensed, recentSubjects, roadmap }),
        schema: prWriterAgentSchema,
        dryRunResult: stubPrWriterOutput(run.task, run.workBranch),
      });

      const prText = normalizePrWriterOutput(result.object, context);
      writeArtifact({
        runId: run.runId,
        step: 'pr-writer',
        attempt,
        status: 'COMPLETED',
        durationMs: Date.now() - started,
        model: result.servedByModel,
        data: { ...prText, omitted: condensed.omitted, shortened: condensed.shortened },
      });
      logger?.info?.('[factory] pr-writer finished', { runId: run.runId, title: prText.pullRequest.title });
      return done(prText);
    } catch (error) {
      // Never a reason to stop: everything the text needs is already in the reports, and the human
      // reads (and can edit) it at the delivery gate before anything is published.
      const message = (error as Error).message ?? String(error);
      const prText = fallbackPrText(
        context,
        `The AI could not write this text (${explainAgentFailure(message)}). It was drafted from the reports of the run ` +
          'instead - read it, and edit it if you like.',
      );
      appendEvent(run.runId, { type: 'pr_writer_fallback', error: message });
      writeArtifact({
        runId: run.runId,
        step: 'pr-writer',
        attempt,
        status: 'FALLBACK',
        durationMs: Date.now() - started,
        data: { ...prText, error: message },
      });
      logger?.warn?.(`[factory] pr-writer fell back to the plain text: ${message}`, { runId: run.runId });
      return done(prText);
    }
  },
});

/* ========================================================================== */
/* Step 08 - delivery (commit, push, pull request)                             */
/* ========================================================================== */

/**
 * Tells the pull-request watcher about a delivery.
 *
 * - Always: register the pull request, so it is watched from now on (round 1 creates the entry, a
 *   later round moves it forward without resetting what was already handled).
 * - For a further round: mark the comments it addressed as handled, and - only when the human
 *   opted in - answer them on GitHub with the commit that fixed them.
 *
 * Never throws: this is bookkeeping after the irreversible part has succeeded.
 */
async function announcePullRequest(input: {
  run: RunContext;
  workBranch: string;
  title: string;
  url: string;
  commitSha: string | null;
  developerSummary: string | undefined;
  logger: { info?: (...args: any[]) => void; warn?: (...args: any[]) => void } | undefined;
  onNote: (note: string) => void;
}): Promise<void> {
  const { run, logger } = input;
  try {
    const number = run.revision?.pullRequest.number ?? pullRequestNumberFromUrl(input.url);
    if (!number) return;

    const entry = await registerPullRequest({
      repoPath: run.repoPath,
      number,
      url: input.url,
      title: input.title,
      headBranch: input.workBranch,
      baseBranch: run.baseBranch,
      runId: run.runId,
      ...(run.revision ? { rootRunId: run.revision.rootRunId, round: run.revision.round } : {}),
    });
    appendEvent(run.runId, { type: 'pr_registered', key: entry.key, number, url: input.url, round: entry.round });
    if (run.initiative) {
      try {
        await withStore((store) => store.linkPullRequest(run.initiative!.phaseId, { number, url: input.url, branch: input.workBranch }));
      } catch (error) {
        appendEvent(run.runId, { type: 'initiative_unavailable', error: (error as Error).message });
      }
    }
    logger?.info?.(`[factory] pull request #${number} is now watched for review comments`, { runId: run.runId });

    const revision = run.revision;
    if (!revision) return;

    await markCommentsHandled(pullRequestKey(run.repoPath, number), revision.comments.map((comment) => comment.id));
    appendEvent(run.runId, { type: 'comments_handled', count: revision.comments.length, ids: revision.comments.map((c) => c.id) });

    if (!revision.replyOnGitHub) return;

    const short = input.commitSha?.slice(0, 7);
    const summary = input.developerSummary?.trim().split('\n')[0]?.slice(0, 300);
    let posted = 0;
    for (const comment of revision.comments) {
      // Questions were answered at triage time; a disagreement is for a human to answer.
      if (comment.category && (ANSWERED_AT_TRIAGE.has(comment.category) || comment.category === 'BLOCKER_DISAGREEMENT')) continue;
      const body = `Addressed${short ? ` in \`${short}\`` : ''} (round ${revision.round}).${summary ? `\n\n${summary}` : ''}`;
      // In the conversation there is no thread to anchor to, so quote what is being answered.
      const outcome = await postReplyFor(
        run.repoPath,
        number,
        comment,
        comment.source === 'REVIEW_THREAD' && comment.threadId
          ? body
          : `> ${comment.body.trim().split('\n')[0]?.slice(0, 160)}\n\n${body}`,
      );
      if (outcome.posted) posted += 1;
      else input.onNote(`A reply on GitHub was not posted: ${outcome.reason ?? 'unknown reason'}`);
    }
    if (posted > 0) input.onNote(`Replied to ${posted} review comment${posted === 1 ? '' : 's'} on GitHub.`);
  } catch (error) {
    logger?.warn?.(`[factory] could not update the pull-request watcher: ${(error as Error).message}`, {
      runId: run.runId,
    });
  }
}

/**
 * What the run leaves for later - the findings nobody fixed, the follow-ups the agents named - goes to the
 * backlog of its initiative. The same finding twice is kept once, so running this on every pass of the
 * delivery step is fine. Bookkeeping: it never fails a delivery.
 */
async function harvestBacklog(
  run: RunContext,
  cycle: CycleState,
  documentation: z.infer<typeof documentationReportSchema>,
): Promise<void> {
  if (!run.initiative) return;
  try {
    const items = backlogFromRun({
      polish: readPolishResult(run.runId),
      developerFollowUps: cycle.developerReport?.followUps ?? [],
      documentationFollowUps: documentation.followUps,
    });
    if (items.length === 0) return;
    const added = await withStore((store) =>
      store.addBacklog(run.initiative!.id, items.map((item) => ({ ...item, phaseId: run.initiative!.phaseId }))),
    );
    if (added > 0) appendEvent(run.runId, { type: 'backlog_added', count: added });
  } catch (error) {
    appendEvent(run.runId, { type: 'initiative_unavailable', error: (error as Error).message });
  }
}

// Exported so the delivery logic (commit / push / pull request / retry) can be exercised directly.
export const pullRequestStep = createStep({
  id: 'pull-request',
  description: 'Commits the work, pushes the branch and opens a pull request.',
  inputSchema: z.object({
    cycle: cycleStateSchema,
    documentation: documentationReportSchema,
    // Optional only so a run that was suspended before the PR writer existed can still be resumed.
    prText: prTextSchema.optional(),
  }),
  outputSchema: outcomeSchema,
  suspendSchema: z.object({
    reason: z.literal('DELIVERY_APPROVAL_REQUIRED'),
    runId: z.string(),
    branch: z.string(),
    baseBranch: z.string(),
    commitSha: z.string().nullable(),
    commitMessage: z.string(),
    pullRequestTitle: z.string(),
    pullRequestBody: z.string(),
    pullRequestLabels: z.array(z.string()),
    /** Set when the text was not written by the AI (it could not answer): the human should read it with care. */
    pullRequestTextNote: z.string().optional(),
    filesChanged: z.number().int(),
    /** Set for a further round: pushing updates this pull request instead of opening one. */
    existingPullRequest: z.object({ number: z.number().int(), url: z.string() }).optional(),
    // What the human may still change. Published history is never rewritten, so a commit that is
    // already on the remote (or a branch that is) is offered read-only, with the reason.
    commitEditable: z.boolean(),
    commitLockedReason: z.string().optional(),
    branchEditable: z.boolean(),
    branchLockedReason: z.string().optional(),
  }),
  resumeSchema: z
    .object({
      approvePush: z
        .boolean()
        .describe('true: push the work branch to the remote. false: leave it local.'),
      approvePullRequest: z
        .boolean()
        .describe('true: open the pull request after pushing. Ignored when approvePush is false.'),
    })
    .extend(deliveryEditsSchema.shape),
  execute: async ({ inputData, resumeData, suspend, mastra }) => {
    const { cycle, documentation } = inputData;
    const run = cycle.run;
    await harvestBacklog(run, cycle, documentation);
    // The commit message, title and description come from the PR writer. A run suspended before that
    // step existed has none: it gets the plain text built from its reports.
    const text: PrText = inputData.prText ?? fallbackPrText(prTextContext(cycle, documentation, []));
    const logger = mastra?.getLogger?.();
    const pendingActions: string[] = [];
    const notes: string[] = [];

    // The branch the work lives on *now*. The persisted run context still holds the name the run
    // was created with, so a rename made at an earlier attempt is only found in the event log.
    let workBranch = run.dryRun ? run.workBranch : currentWorkBranch(run.runId, run.workBranch);

    // Ordered, user-facing record of what delivery did. It is persisted in the artifact (the
    // Studio renders it as the Delivery report) and mirrored to the console and the event log,
    // so every sub-step - commit, edit, push, pull request - leaves visible feedback.
    //
    // It starts with what earlier executions of this step did (the commit made before the approval
    // gate, a push that failed before a retry): this execution writes the report, but the delivery
    // it describes began earlier. Read before `record` appends anything.
    const earlier = run.dryRun ? [] : earlierDeliveryActions(run.runId);
    const committedEarlier = earlier.some((entry) => entry.action === 'commit' && entry.ok);
    const timeline: Array<{ at: string; action: string; ok: boolean; detail: string }> = [...earlier];
    const record = (action: string, ok: boolean, detail: string) => {
      timeline.push({ at: new Date().toISOString(), action, ok, detail });
      appendEvent(run.runId, { type: 'delivery_action', step: 'pull-request', action, ok, detail });
      const log = ok ? logger?.info : logger?.warn;
      log?.call(logger, `[factory] delivery ${action} ${ok ? 'ok' : 'FAILED'}: ${detail}`, {
        runId: run.runId,
        branch: workBranch,
      });
    };

    let committed = false;
    let commitSha: string | null = null;
    let pushed = false;
    let pullRequestCreated = false;
    let pullRequestUrl: string | null = null;
    let decision: { approvePush: boolean; approvePullRequest: boolean; source: 'human' | 'config' } | null =
      null;
    // A step failure that must be raised *after* the artifact is written, so the run keeps
    // the record of what was (and was not) published.
    let failure: { status: 'PUSH_FAILED' | 'PR_FAILED' | 'FAILED'; message: string } | null = null;
    let publicationState: Awaited<ReturnType<typeof inspectBranchPublication>> | null = null;
    // The commit leads back to its task: `Factory-Task: f0042` (a round carries its task's id).
    const plannedCommitMessage = withTaskTrailer(
      // A round: the message the PR writer wrote for it (or the stand-in built from the round). A run
      // suspended before that existed has none, and gets the stand-in.
      run.revision ? (inputData.prText?.commitMessage || revisionCommitMessage(run.revision)) : text.commitMessage,
      run.taskId,
    );

    // What the human chose last time (a retry starts from that, not from the original proposal).
    const prior = run.dryRun ? {} : latestDeliveryEdits(run.runId);
    let pullRequestTitle = prior.pullRequestTitle ?? text.pullRequest.title;
    let pullRequestBody = prior.pullRequestBody ?? text.pullRequest.body;

    if (run.dryRun) {
      notes.push('Dry run: no commit, push or pull request was performed.');
    } else {
      try {
        if (run.autoCommit) {
          const commit = await commitAll(run.repoPath, plannedCommitMessage);
          // The commit of this delivery may have been made by an earlier execution of this step
          // (always, once the approval gate has been answered): the tree is clean now, but the run
          // did commit.
          committed = commit.committed || committedEarlier;
          commitSha = commit.sha;
          if (commit.committed) {
            // The subject only: a commit message now has a body, and the full text is in the report.
            record('commit', true, `Committed ${commit.sha?.slice(0, 7) ?? ''} "${plannedCommitMessage.split('\n')[0]}"`);
          } else if (commit.reason && !committedEarlier) {
            notes.push(commit.reason);
          }
        } else {
          pendingActions.push('Commit the working tree (autoCommit was disabled).');
        }

        publicationState = await inspectBranchPublication(run.repoPath, workBranch, run.baseBranch);
      } catch (error) {
        failure = { status: 'FAILED', message: `Delivery failed while committing: ${(error as Error).message}` };
        record('commit', false, (error as Error).message);
      }

      // Work that still has to reach the remote. It is not only "I just committed": on a retry
      // or a resumed run the commit already exists, yet the branch may be unpushed or may have
      // been pushed without a pull request.
      const hasWorkToPublish =
        committed ||
        (publicationState?.needsPush ?? false) ||
        (publicationState?.aheadOfBase ?? 0) > 0;

      const editability = hasWorkToPublish
        ? await assessDeliveryEditability(run.repoPath, workBranch, publicationState)
        : null;

      // Human in the loop: the commit is local and reviewable, so the irreversible part
      // (publishing the branch and opening a PR) waits for an explicit decision.
      // NOTE: this stays outside any try/catch - `suspend()` must not be intercepted.
      if (!failure && hasWorkToPublish && run.interactive && resumeData === undefined) {
        logger?.info?.('[factory] delivery awaiting human approval, suspending run', {
          runId: run.runId,
          branch: workBranch,
          commitSha,
        });
        appendEvent(run.runId, {
          type: 'run_suspended',
          step: 'pull-request',
          reason: 'DELIVERY_APPROVAL_REQUIRED',
          branch: workBranch,
        });
        const deliveryPayload = {
          reason: 'DELIVERY_APPROVAL_REQUIRED' as const,
          runId: run.runId,
          branch: workBranch,
          baseBranch: run.baseBranch,
          commitSha: commitSha ?? (await getBranchSha(run.repoPath, workBranch)),
          // The commit as it really is (a retry shows the message that was already amended).
          commitMessage: (await getCommitMessage(run.repoPath, workBranch)) ?? plannedCommitMessage,
          pullRequestTitle,
          pullRequestBody,
          pullRequestLabels: text.pullRequest.labels,
          ...(text.source === 'fallback' && text.note && !run.revision ? { pullRequestTextNote: text.note } : {}),
          filesChanged: cycle.developerReport?.changedFiles?.length ?? 0,
          ...(run.revision
            ? {
                existingPullRequest: {
                  number: run.revision.pullRequest.number,
                  url: run.revision.pullRequest.url,
                },
              }
            : {}),
          commitEditable: editability?.commitEditable ?? false,
          ...(editability?.commitLockedReason ? { commitLockedReason: editability.commitLockedReason } : {}),
          branchEditable: editability?.branchEditable ?? false,
          ...(editability?.branchLockedReason ? { branchLockedReason: editability.branchLockedReason } : {}),
        };
        writePendingInput(run.runId, { ...deliveryPayload, step: 'pull-request' });
        return await suspend(deliveryPayload);
      }

      if (!failure) {
        // A resumed run follows the human decision; a non-interactive run keeps the old flags.
        const approvePush = resumeData ? resumeData.approvePush : run.createPullRequest;
        const approvePullRequest = resumeData
          ? resumeData.approvePush && resumeData.approvePullRequest
          : run.createPullRequest;
        decision = { approvePush, approvePullRequest, source: resumeData ? 'human' : 'config' };

        // Final values, not a diff: the last submission describes the whole choice, so a retry
        // can pre-fill its form from it.
        const edits = resumeData ? sanitizeDeliveryEdits(resumeData) : {};

        appendEvent(run.runId, { type: 'delivery_decision', step: 'pull-request', ...decision });
        if (resumeData) {
          appendEvent(run.runId, {
            type: 'human_input',
            step: 'pull-request',
            gate: 'DELIVERY_APPROVAL_REQUIRED',
            approvePush,
            approvePullRequest,
            ...(Object.keys(edits).length > 0 ? { edits } : {}),
          });
        }
        logger?.info?.(
          `[factory] delivery decision: push=${approvePush} pullRequest=${approvePullRequest} (${decision.source})`,
          { runId: run.runId, branch: workBranch },
        );

        try {
          /* ---- the human's edits, applied before anything is published ---- */
          if (hasWorkToPublish && resumeData) {
            if (edits.commitMessage) {
              const current = await getCommitMessage(run.repoPath, workBranch);
              if (edits.commitMessage !== current) {
                if (editability?.commitEditable) {
                  const amended = await amendTipCommitMessage(run.repoPath, edits.commitMessage);
                  if (amended.amended) {
                    commitSha = amended.sha ?? commitSha;
                    record('edit', true, `Commit message changed to "${edits.commitMessage.split('\n')[0]}"`);
                  } else {
                    notes.push(`The commit message was not changed: ${amended.reason ?? 'git refused'}`);
                  }
                } else {
                  notes.push(
                    `The commit message was not changed: ${editability?.commitLockedReason ?? 'it is locked.'}`,
                  );
                }
              }
            }

            if (edits.branchName && edits.branchName !== workBranch) {
              if (editability?.branchEditable) {
                const renamed = await renameBranch(run.repoPath, workBranch, edits.branchName);
                if (renamed.renamed) {
                  appendEvent(run.runId, { type: 'branch_renamed', from: workBranch, to: edits.branchName });
                  updateRunMeta(run.runId, { branch: edits.branchName });
                  record('edit', true, `Branch renamed ${workBranch} -> ${edits.branchName}`);
                  workBranch = edits.branchName;
                  publicationState = await inspectBranchPublication(run.repoPath, workBranch, run.baseBranch);
                } else {
                  notes.push(`The branch was not renamed: ${renamed.reason ?? 'git refused'}`);
                }
              } else {
                notes.push(`The branch was not renamed: ${editability?.branchLockedReason ?? 'it is locked.'}`);
              }
            }

            if (edits.pullRequestTitle && edits.pullRequestTitle !== text.pullRequest.title) {
              record('edit', true, `Pull request title set to "${edits.pullRequestTitle}"`);
            }
            if (edits.pullRequestBody !== undefined && edits.pullRequestBody !== text.pullRequest.body) {
              record('edit', true, 'Pull request description edited');
            }
            pullRequestTitle = edits.pullRequestTitle ?? pullRequestTitle;
            pullRequestBody = edits.pullRequestBody ?? pullRequestBody;
          }

          if (!approvePush) {
            if (hasWorkToPublish) {
              pendingActions.push(
                resumeData
                  ? 'Push declined by the human: the commit is local only.'
                  : 'Pull-request creation was disabled for this run.',
              );
              notes.push('Nothing was published: the work stays on the local branch.');
            }
          } else if (hasWorkToPublish) {
            // 1. Push - unless the remote already holds everything (typical on a retry).
            if (publicationState?.published) {
              pushed = true;
              record('push', true, `${workBranch} is already up to date on origin - nothing to push`);
              notes.push('The branch was already pushed - no new push was needed.');
            } else {
              if (!committed) {
                notes.push('No new changes to commit, but found unpushed commits - pushing them now.');
              }
              logger?.info?.(`[factory] delivery pushing ${workBranch} to origin...`, {
                runId: run.runId,
              });
              const push = await pushBranch(run.repoPath, workBranch);
              pushed = push.pushed;
              if (push.pushed) {
                record('push', true, `Pushed ${workBranch} to origin`);
              } else {
                const reason = push.reason ?? 'unknown reason';
                record('push', false, reason);
                pendingActions.push(`Push manually: ${reason}`);
                if (resumeData) {
                  failure = {
                    status: 'PUSH_FAILED',
                    message: `Pushing "${workBranch}" failed: ${reason}`,
                  };
                }
              }
            }

            // 2. Pull request - whenever the branch is on the remote, whether or not this
            //    execution had to push it. (Previously a branch that was already pushed never
            //    got its pull request, so a retry could not recover.)
            if (pushed && run.revision) {
              // Further round on an open pull request: the push IS the update. There is nothing to
              // create - and asking GitHub to would only produce an "already exists" error.
              pullRequestCreated = true;
              pullRequestUrl = run.revision.pullRequest.url;
              record(
                'pull-request',
                true,
                `Updated pull request #${run.revision.pullRequest.number} (new commit pushed to ${workBranch})`,
              );
              notes.push(`Round ${run.revision.round}: pull request #${run.revision.pullRequest.number} was updated, not re-opened.`);
            } else if (pushed && approvePullRequest) {
              logger?.info?.(
                `[factory] delivery opening pull request ${workBranch} -> ${run.baseBranch}...`,
                { runId: run.runId },
              );
              const pullRequest = await createPullRequest(run.repoPath, {
                title: pullRequestTitle,
                body: pullRequestBody,
                baseBranch: run.baseBranch,
                headBranch: workBranch,
                labels: text.pullRequest.labels,
              });
              if (pullRequest.created) {
                pullRequestCreated = true;
                pullRequestUrl = pullRequest.url;
                record(
                  'pull-request',
                  true,
                  pullRequest.alreadyExisted
                    ? `A pull request was already open: ${pullRequest.url ?? '(url unknown)'}`
                    : `Opened pull request ${pullRequest.url ?? ''}`.trim(),
                );
                if (pullRequest.alreadyExisted) {
                  notes.push('A pull request for this branch already existed - it was reused.');
                }
                if (pullRequest.droppedLabels?.length) {
                  notes.push(
                    `Labels that do not exist in the repository were skipped: ${pullRequest.droppedLabels.join(', ')}.`,
                  );
                }
              } else {
                const reason = pullRequest.reason ?? 'unknown reason';
                record('pull-request', false, reason);
                pendingActions.push(`Open the pull request manually: ${reason}`);
                pendingActions.push(
                  `gh pr create --base ${run.baseBranch} --head ${workBranch} --fill`,
                );
                // The human explicitly asked for this pull request, so not delivering it is a
                // failure to report - not a quiet footnote.
                if (resumeData) {
                  failure = {
                    status: 'PR_FAILED',
                    message: `The branch "${workBranch}" was pushed but the pull request could not be opened: ${reason}`,
                  };
                }
              }
            } else if (pushed && !approvePullRequest) {
              pendingActions.push('Pull request declined by the human: the branch is pushed only.');
            }
          }
        } catch (error) {
          // Last line of defence: whatever happened, the artifact below still gets written.
          const message = (error as Error).message ?? String(error);
          record('error', false, message);
          failure = { status: 'FAILED', message: `Delivery failed unexpectedly: ${message}` };
        }
      }
    }

    const hasWork =
      committed ||
      (publicationState?.needsPush ?? false) ||
      (publicationState?.aheadOfBase ?? 0) > 0;

    // The commit that is being delivered, as it is now (after any edit) - also on a retry,
    // where nothing was committed in this execution.
    const deliveredCommitMessage = hasWork ? await getCommitMessage(run.repoPath, workBranch) : null;
    const deliveredCommitSha = hasWork ? (commitSha ?? (await getBranchSha(run.repoPath, workBranch))) : null;

    // The "notification" to the pull-request watcher (before the report, so its notes are in it): register the PR the moment it exists, and for a
    // further round record which comments are done with. Bookkeeping must never fail a delivery.
    if (!failure && pullRequestCreated && pullRequestUrl) {
      await announcePullRequest({
        run,
        workBranch,
        title: pullRequestTitle,
        url: pullRequestUrl,
        commitSha: deliveredCommitSha,
        developerSummary: cycle.developerReport?.summary,
        logger,
        onNote: (note) => notes.push(note),
      });
    }

    const delivery = {
      committed,
      commitSha: deliveredCommitSha,
      commitMessage: deliveredCommitMessage,
      pushed,
      pullRequestCreated,
      pullRequestUrl,
      branch: workBranch,
      pendingActions,
      notes,
    };

    const artifactStatus =
      failure?.status ??
      (pullRequestCreated
        ? run.revision
          ? 'PR_UPDATED'
          : 'PR_CREATED'
        : pushed
          ? 'PUSHED'
          : hasWork
            ? 'COMMITTED'
            : 'NO_CHANGES');

    writeArtifact({
      runId: run.runId,
      step: 'delivery',
      status: artifactStatus,
      data: {
        delivery,
        // What was actually used - the proposal, or the human's edit of it.
        pullRequest: { ...text.pullRequest, title: pullRequestTitle, body: pullRequestBody },
        baseBranch: run.baseBranch,
        decision,
        publication: publicationState,
        timeline,
        error: failure?.message ?? null,
      },
    });
    logger?.info?.('[factory] delivery step finished', {
      runId: run.runId,
      status: artifactStatus,
      committed,
      pushed,
      pullRequestUrl,
    });

    if (failure) {
      // Fail the step (the artifact above is already on disk). The run is then restartable
      // with "Retry run", which re-asks for approval and - because the branch is already
      // published - goes straight to the part that failed.
      throw new Error(failure.message);
    }

    return {
      status: pullRequestCreated ? 'DELIVERED' : 'DELIVERED_WITHOUT_PR',
      // Carries a renamed branch to the final summary.
      run: { ...run, workBranch },
      plan: cycle.plan,
      attempts: cycle.attempt,
      history: cycle.history,
      qaReport: cycle.qaReport,
      reviewReport: cycle.reviewReport,
      securityReport: cycle.securityReport,
      developerReport: cycle.developerReport,
      triageReport: cycle.triageReport,
      documentationReport: documentation,
      deliveryReport: deliveryReportSchema.parse(delivery),
      escalation: null,
    } satisfies Outcome;
  },
});

const deliveryPhase = createWorkflow({
  id: 'delivery-phase',
  description:
    'Documentation update, then the PR writer (commit message and pull-request text, always), ' +
    'then commit, push and pull-request creation.',
  inputSchema: cycleStateSchema,
  outputSchema: outcomeSchema,
})
  .then(documentationStep)
  .then(prWriterStep)
  .then(pullRequestStep)
  .commit();

/* ========================================================================== */
/* Escalation phase (human in the loop)                                        */
/* ========================================================================== */

const escalationStep = createStep({
  id: 'escalation',
  description:
    'Pauses the run for human intervention, recording the root cause, the attempt history and ' +
    'the question that needs an answer.',
  inputSchema: cycleStateSchema,
  outputSchema: outcomeSchema,
  suspendSchema: z.object({
    reason: z.string(),
    question: z.string(),
    attempt: z.number().int(),
    maxAttempts: z.number().int(),
    rootCause: z.string(),
    history: z.array(z.unknown()),
    traceDir: z.string(),
    resumeCommand: z.string(),
  }),
  resumeSchema: z.object({
    decision: z
      .enum(['ABORT', 'ACKNOWLEDGE'])
      .describe('ABORT: stop and discard. ACKNOWLEDGE: record the decision and close the run.'),
    guidance: z
      .string()
      .optional()
      .describe('Guidance for the next run (pass it back as `clarifications`).'),
  }),
  execute: async ({ inputData, resumeData, suspend, mastra }) => {
    const state = inputData;
    const run = state.run;
    const logger = mastra?.getLogger?.();

    const reason = state.escalationReason ?? 'Escalated by the triage agent.';
    const question =
      state.triageReport?.humanQuestion?.trim() !== ''
        ? (state.triageReport?.humanQuestion ?? '')
        : 'How should the factory proceed with this task?';
    const resumeCommand = `npm run factory -- resume --run-id ${run.runId} --decision ACKNOWLEDGE --guidance "<your answer>"`;

    if (!resumeData && run.interactive) {
      logger?.error?.('[factory] escalating to human, run suspended', {
        runId: run.runId,
        attempt: state.attempt,
        reason,
      });
      appendEvent(run.runId, {
        type: 'run_escalated',
        attempt: state.attempt,
        reason,
        question,
        rootCause: state.triageReport?.rootCause.category ?? null,
      });
      writeArtifact({
        runId: run.runId,
        step: 'escalation',
        status: 'SUSPENDED',
        data: {
          attempt: state.attempt,
          maxAttempts: run.maxAttempts,
          reason,
          question,
          rootCause: state.triageReport?.rootCause ?? null,
          loopEvidence: state.triageReport?.loopEvidence ?? null,
          history: state.history,
          resumeCommand,
        },
      });
      const escalationPayload = {
        reason,
        question,
        attempt: state.attempt,
        maxAttempts: run.maxAttempts,
        rootCause: state.triageReport?.rootCause.category ?? 'UNKNOWN',
        history: state.history,
        traceDir: run.traceDir,
        resumeCommand,
      };
      writePendingInput(run.runId, {
        ...escalationPayload,
        reason: 'ESCALATION_REQUIRED',
        escalationReason: reason,
        step: 'escalation',
      });
      return await suspend(escalationPayload);
    }

    const decision = resumeData?.decision ?? 'ACKNOWLEDGE';
    const guidance = resumeData?.guidance ?? null;

    logger?.error?.('[factory] run closed after escalation', {
      runId: run.runId,
      decision,
      reason,
    });
    appendEvent(run.runId, {
      type: 'escalation_resolved',
      decision,
      guidance,
      reason,
      nonInteractive: !run.interactive,
    });
    writeArtifact({
      runId: run.runId,
      step: 'escalation',
      status: decision,
      data: {
        attempt: state.attempt,
        maxAttempts: run.maxAttempts,
        reason,
        question,
        humanDecision: decision,
        humanGuidance: guidance,
        rootCause: state.triageReport?.rootCause ?? null,
        history: state.history,
        resumeCommand,
      },
    });

    return {
      status: decision === 'ABORT' ? 'ABORTED_BY_HUMAN' : 'ESCALATED_TO_HUMAN',
      run,
      plan: state.plan,
      attempts: state.attempt,
      history: state.history,
      qaReport: state.qaReport,
      reviewReport: state.reviewReport,
      securityReport: state.securityReport,
      developerReport: state.developerReport,
      triageReport: state.triageReport,
      documentationReport: null,
      deliveryReport: null,
      escalation: { reason, question, humanDecision: decision, humanGuidance: guidance, resumeCommand },
    } satisfies Outcome;
  },
});

const escalationPhase = createWorkflow({
  id: 'escalation-phase',
  description: 'Human-in-the-loop pause: the run stops and waits for a decision.',
  inputSchema: cycleStateSchema,
  outputSchema: outcomeSchema,
})
  .then(escalationStep)
  .commit();

/* ========================================================================== */
/* Finalize - summary.json                                                     */
/* ========================================================================== */

const finalizeStep = createStep({
  id: 'finalize',
  description: 'Aggregates run metrics and writes logs/<runId>/summary.json.',
  inputSchema: z.object({
    'delivery-phase': outcomeSchema.optional(),
    'escalation-phase': outcomeSchema.optional(),
  }),
  outputSchema: factoryResultSchema,
  execute: async ({ inputData, mastra }) => {
    const outcome = inputData['delivery-phase'] ?? inputData['escalation-phase'];
    if (!outcome) throw new Error('No outcome was produced by the factory workflow.');

    const run = outcome.run;
    const logger = mastra?.getLogger?.();
    const metrics = aggregateRunMetrics(run.runId);
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - new Date(run.startedAt).getTime();
    const pullRequestUrl = outcome.deliveryReport?.pullRequestUrl ?? null;

    const summary = {
      runId: run.runId,
      status: outcome.status,
      task: run.task,
      kind: run.revision ? 'revision' : 'run',
      rootRunId: run.revision?.rootRunId ?? run.runId,
      round: run.revision?.round ?? 1,
      ...(run.revision ? { parentRunId: run.revision.parentRunId } : {}),
      ...(run.taskId ? { taskId: run.taskId } : {}),
      ...(run.title ? { title: run.title } : {}),
      ...(run.initiative ? { initiativeId: run.initiative.id, phaseId: run.initiative.phaseId } : {}),
      repository: run.repoPath,
      branch: run.workBranch,
      startedAt: run.startedAt,
      finishedAt: finishedAt.toISOString(),
      durationMs,
      attempts: outcome.attempts,
      pullRequestUrl,
      tokens: metrics.tokens,
      agentCalls: metrics.agentCalls,
      toolCalls: metrics.toolCalls,
      modelsUsed: metrics.modelsUsed,
      steps: metrics.steps,
      artifacts: listArtifacts(run.runId),
      escalation: outcome.escalation,
      gates: {
        qa: reportedGate(run.pipeline.qa, outcome.qaReport?.verdict),
        codeReview: reportedGate(run.pipeline.review, outcome.reviewReport?.status),
        security: reportedGate(run.pipeline.security, outcome.securityReport?.status),
        documentation: reportedGate(run.pipeline.documentation, outcome.documentationReport?.status),
      },
      history: outcome.history,
      dryRun: run.dryRun,
    };

    const summaryPath = writeSummary(run.runId, summary);

    const headline =
      outcome.status === 'DELIVERED'
        ? `Pull request created: ${pullRequestUrl}`
        : outcome.status === 'DELIVERED_WITHOUT_PR'
          ? 'Change delivered on the work branch (no pull request).'
          : outcome.status === 'ABORTED_BY_HUMAN'
            ? 'Run aborted by the human operator.'
            : `Escalated to a human: ${outcome.escalation?.reason ?? 'unknown reason'}`;

    logger?.info?.('[factory] run finished', {
      runId: run.runId,
      status: outcome.status,
      attempts: outcome.attempts,
      totalTokens: metrics.tokens.total,
      durationMs,
    });

    return {
      runId: run.runId,
      status: outcome.status,
      repository: run.repoPath,
      branch: run.workBranch,
      attempts: outcome.attempts,
      pullRequestUrl,
      traceDir: run.traceDir,
      summaryPath,
      summary: headline,
      escalation: outcome.escalation,
    };
  },
});

/* ========================================================================== */
/* The workflow                                                                */
/* ========================================================================== */

export const softwareFactoryWorkflow = createWorkflow({
  id: 'software-factory',
  description:
    'End-to-end multi-agent software factory: plan -> implement -> test -> triage loop -> ' +
    'review + security -> document -> pull request.',
  inputSchema: factoryTaskSchema,
  outputSchema: factoryResultSchema,
})
  .then(prepareRunStep)
  .then(planStep)
  .dountil(implementationCycle, async ({ inputData }) => {
    // Exit when every gate is satisfied, when a human is required, or as a hard safety net
    // if the attempt counter ever runs past its budget.
    return (
      inputData.cycleComplete ||
      inputData.escalate ||
      inputData.attempt > inputData.run.maxAttempts + 1
    );
  })
  .branch([
    [async ({ inputData }) => inputData.escalate || !inputData.cycleComplete, escalationPhase],
    [async ({ inputData }) => inputData.cycleComplete && !inputData.escalate, deliveryPhase],
  ])
  .then(finalizeStep)
  .commit();

export const factoryWorkflows = { softwareFactoryWorkflow };
