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
 *   delivery-phase: 07 documentation -> 08 commit/push/draft PR
 *        |
 *   finalize (summary.json)
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { documentationAgent } from '../agents/documentation.agent.ts';
import { developerAgent } from '../agents/developer.agent.ts';
import { pmArchitectAgent } from '../agents/pm-architect.agent.ts';
import { qaTesterAgent } from '../agents/qa-tester.agent.ts';
import { reviewerAgent } from '../agents/reviewer.agent.ts';
import { securityAgent } from '../agents/security.agent.ts';
import { triageAgent } from '../agents/triage.agent.ts';
import {
  commitAll,
  createBranch,
  createDraftPullRequest,
  getCurrentBranch,
  getDiff,
  isWorkingTreeClean,
  pushBranch,
} from '../tools/git-tools.ts';
import {
  appendEvent,
  aggregateRunMetrics,
  createRunTrace,
  generateRunId,
  listArtifacts,
  writeArtifact,
  writeContextBlock,
  writeSummary,
} from '../tools/logger-tools.ts';
import { detectProjectStack, runSuite } from '../tools/test-runner-tools.ts';
import { composePrompt, invokeAgent, promptSection } from '../utils/agent-runner.ts';
import { getConventionSources } from '../utils/context-loader.ts';
import { getFactoryConfig, resolveRepoPath } from '../utils/factory-config.ts';
import { AGENT_ROLES, describeModelChain } from '../utils/model-router.ts';
import {
  blockedQaReport,
  stubDeveloperReport,
  stubDocumentationReport,
  stubExecutionPlan,
  stubQaReport,
  stubReviewReport,
  stubSecurityReport,
  stubTriageReport,
} from '../utils/dry-run-fixtures.ts';
import {
  cycleStateSchema,
  deliveryReportSchema,
  developerReportSchema,
  documentationReportSchema,
  executionPlanSchema,
  factoryResultSchema,
  factoryTaskSchema,
  outcomeSchema,
  qaReportSchema,
  reviewReportSchema,
  runContextSchema,
  securityReportSchema,
  triageReportSchema,
  type AttemptHistory,
  type CycleState,
  type Feedback,
  type Outcome,
  type QaReport,
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

function slugify(value: string, maxLength = 40): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLength) || 'task'
  );
}

/** Stable fingerprint of a QA failure, used by triage for loop detection. */
function qaFailureSignature(report: QaReport): string | null {
  if (report.passed) return null;
  const parts = report.failures.map((failure) => `${failure.testId}|${failure.type}`).sort();
  const basis = parts.length > 0 ? parts.join('\n') : `${report.verdict}|${report.summary}`;
  return createHash('sha1').update(basis).digest('hex').slice(0, 12);
}

/** Context block describing the run, injected in every agent prompt. */
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
  });
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
    const baseBranch = inputData.baseBranch ?? (await getCurrentBranch(repoPath));
    const workBranch =
      inputData.branchName ?? `factory/${slugify(inputData.task, 32)}-${effectiveRunId.slice(-4)}`;

    if (!config.dryRun && !(await isWorkingTreeClean(repoPath))) {
      throw new Error(
        `Target repository "${repoPath}" has uncommitted changes. Commit or stash them before ` +
          'starting a factory run: the factory needs a clean baseline to produce a reviewable diff.',
      );
    }

    const conventions = getConventionSources(repoPath);
    const models = Object.fromEntries(AGENT_ROLES.map((role) => [role, describeModelChain(role)]));

    const run: RunContext = {
      runId: effectiveRunId,
      traceDir: '',
      task: inputData.task,
      ...(inputData.clarifications === undefined ? {} : { clarifications: inputData.clarifications }),
      repoPath,
      repoName,
      baseBranch,
      workBranch,
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
    };

    const { traceDir } = createRunTrace({
      runId: run.runId,
      task: run.task,
      repoPath,
      repoName,
      branch: workBranch,
      baseBranch,
      models,
      dryRun: config.dryRun,
      startedAt: run.startedAt,
    });
    run.traceDir = traceDir;

    if (!config.dryRun) {
      const branch = await createBranch(repoPath, workBranch, baseBranch);
      run.branchCreated = branch.created;
      run.workBranch = branch.branch;
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
    });

    return { run };
  },
});

/* ========================================================================== */
/* Step 01 - plan (PM & Architect)                                             */
/* ========================================================================== */

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

    const prompt = composePrompt(
      '# Task',
      '',
      run.task,
      runBrief(run, 1),
      promptSection('Acceptance criteria required by the requester', run.requesterCriteria),
      promptSection('Clarifications provided by the human', clarifications),
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
        });
        return await suspend({
          reason: 'CLARIFICATION_REQUIRED',
          questions: plan.clarificationQuestions,
          planSummary: plan.summary,
          runId: run.runId,
        });
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

    const updatedRun: RunContext = clarifications ? { ...run, clarifications } : run;

    return {
      run: updatedRun,
      plan,
      attempt: 1,
      phase: 'DEVELOP',
      cycleComplete: false,
      escalate: false,
      escalationReason: null,
      rerunInfra: false,
      feedback: null,
      history: [],
      developerReport: null,
      qaReport: null,
      reviewReport: null,
      securityReport: null,
      triageReport: null,
      triageAttempt: null,
    } satisfies CycleState;
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
      attempt === 1
        ? 'Implement the execution plan below.'
        : `This is fix iteration ${attempt} of ${run.maxAttempts}. Address the feedback below.`,
      runBrief(run, attempt),
      promptSection('Original task', run.task),
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
        attempt > 1
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

    logger?.info?.('[factory] developer step finished', {
      runId: run.runId,
      attempt,
      status: report.status,
      changedFiles: report.changedFiles.length,
    });

    return { ...state, developerReport: report, phase: 'QA' } satisfies CycleState;
  },
});

/* ========================================================================== */
/* Step 03 - QA & tester                                                       */
/* ========================================================================== */

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

    // Deterministic pre-execution of the suite: cheaper and more reliable than asking the
    // model to be the one that remembers to run it. The agent still runs targeted commands.
    let preExecuted: string | null = null;
    if (!run.dryRun && run.testCommand) {
      const execution = await runSuite(run.repoPath, run.testCommand);
      const outputPath = writeContextBlock(
        run.runId,
        `qa-suite-attempt-${attempt}.log`,
        `$ ${execution.command}\nexit=${execution.exitCode} duration=${execution.durationMs}ms\n\n` +
          `--- stdout ---\n${execution.stdoutTail}\n--- stderr ---\n${execution.stderrTail}\n`,
      );
      appendEvent(run.runId, {
        type: 'suite_executed',
        attempt,
        command: execution.command,
        exitCode: execution.exitCode,
        durationMs: execution.durationMs,
        log: path.basename(outputPath),
      });
      preExecuted = JSON.stringify(
        {
          command: execution.command,
          exitCode: execution.exitCode,
          durationMs: execution.durationMs,
          timedOut: execution.timedOut,
          totals: execution.parsed,
          stdoutTail: execution.stdoutTail.slice(-8_000),
          stderrTail: execution.stderrTail.slice(-8_000),
        },
        null,
        2,
      );
    }

    const diff = run.dryRun
      ? { files: [], diff: '' }
      : await getDiff(run.repoPath, { nameOnly: true });

    const prompt = composePrompt(
      '# Quality gate',
      '',
      `Validate attempt ${attempt} of the change below and return a structured verdict.`,
      runBrief(run, attempt),
      promptSection('Original task', run.task),
      promptSection('Acceptance criteria', plan.acceptanceCriteria),
      promptSection('Test strategy from the plan', plan.testStrategy),
      promptSection('Developer report', state.developerReport),
      promptSection('Changed files', diff.files),
      promptSection('PRE-EXECUTED SUITE', preExecuted),
      promptSection('Previous attempt failures', state.history),
      [
        '',
        '## Instructions',
        '',
        '1. Trust only commands you actually executed; report their real exit codes.',
        '2. Verify every acceptance criterion; use `http-probe` for API/E2E criteria.',
        '3. Inspect the diff for deleted, skipped, disabled or loosened tests and report it in ' +
          '`weakenedVerification`.',
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

    const diff = run.dryRun ? { diff: '', files: [] } : await getDiff(run.repoPath);
    if (!run.dryRun) {
      writeContextBlock(run.runId, `diff-attempt-${attempt}.patch`, diff.diff);
    }

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
      }),
      promptSection('Changed files', diff.files),
      promptSection('Diff', diff.diff === '' ? null : `\`\`\`diff\n${diff.diff}\n\`\`\``),
      [
        '',
        '## Instructions',
        '',
        '1. Use `git-diff` yourself if you need more context than the diff above.',
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

    const diff = run.dryRun ? { diff: '', files: [] } : await getDiff(run.repoPath);

    const prompt = composePrompt(
      '# Security audit',
      '',
      'Audit the change below for security regressions.',
      runBrief(run, attempt),
      promptSection('Original task', run.task),
      promptSection('Developer report', state.developerReport),
      promptSection('Changed files', diff.files),
      promptSection('Diff', diff.diff === '' ? null : `\`\`\`diff\n${diff.diff}\n\`\`\``),
      [
        '',
        '## Instructions',
        '',
        '1. Trace untrusted input from entry point to sink before claiming a vulnerability.',
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
      review: state.reviewReport?.status,
      security: state.securityReport?.status,
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

const documentationStep = createStep({
  id: 'documentation',
  description:
    'Documentation agent: updates CHANGELOG/docs/OpenAPI and writes the pull-request description.',
  inputSchema: cycleStateSchema,
  outputSchema: z.object({
    cycle: cycleStateSchema,
    documentation: documentationReportSchema,
  }),
  execute: async ({ inputData, mastra }) => {
    const state = inputData;
    const { run, attempt } = state;
    const logger = mastra?.getLogger?.();

    const diff = run.dryRun ? { diff: '', files: [] } : await getDiff(run.repoPath);

    const prompt = composePrompt(
      '# Documentation and pull request',
      '',
      'The change passed QA, code review and the security audit. Update the documentation it ' +
        'invalidates and write the pull-request description.',
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
        '3. Every claim in the pull-request body must be backed by the reports above.',
        `4. Base the pull request on \`${run.baseBranch}\` from \`${run.workBranch}\`.`,
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
      dryRunResult: stubDocumentationReport(run.task, run.workBranch),
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
/* Step 08 - delivery (commit, push, draft pull request)                       */
/* ========================================================================== */

const pullRequestStep = createStep({
  id: 'pull-request',
  description: 'Commits the work, pushes the branch and opens a draft pull request.',
  inputSchema: z.object({
    cycle: cycleStateSchema,
    documentation: documentationReportSchema,
  }),
  outputSchema: outcomeSchema,
  execute: async ({ inputData, mastra }) => {
    const { cycle, documentation } = inputData;
    const run = cycle.run;
    const logger = mastra?.getLogger?.();
    const pendingActions: string[] = [];
    const notes: string[] = [];

    let committed = false;
    let commitSha: string | null = null;
    let pushed = false;
    let pullRequestCreated = false;
    let pullRequestUrl: string | null = null;
    const commitMessage = cycle.plan.commitMessage || documentation.pullRequest.title;

    if (run.dryRun) {
      notes.push('Dry run: no commit, push or pull request was performed.');
    } else {
      if (run.autoCommit) {
        const commit = await commitAll(run.repoPath, commitMessage);
        committed = commit.committed;
        commitSha = commit.sha;
        if (!commit.committed && commit.reason) notes.push(commit.reason);
      } else {
        pendingActions.push('Commit the working tree (autoCommit was disabled).');
      }

      if (committed && run.createPullRequest) {
        const push = await pushBranch(run.repoPath, run.workBranch);
        pushed = push.pushed;
        if (!push.pushed && push.reason) {
          pendingActions.push(`Push manually: ${push.reason}`);
        }

        if (pushed) {
          const pullRequest = await createDraftPullRequest(run.repoPath, {
            title: documentation.pullRequest.title,
            body: documentation.pullRequest.body,
            baseBranch: run.baseBranch,
            labels: documentation.pullRequest.labels,
          });
          pullRequestCreated = pullRequest.created;
          pullRequestUrl = pullRequest.url;
          if (!pullRequest.created && pullRequest.reason) {
            pendingActions.push(`Open the pull request manually: ${pullRequest.reason}`);
          }
        }
      } else if (!run.createPullRequest) {
        pendingActions.push('Pull-request creation was disabled for this run.');
      }
    }

    const delivery = {
      committed,
      commitSha,
      commitMessage: committed ? commitMessage : null,
      pushed,
      pullRequestCreated,
      pullRequestUrl,
      branch: run.workBranch,
      pendingActions,
      notes,
    };

    writeArtifact({
      runId: run.runId,
      step: 'delivery',
      status: pullRequestCreated ? 'PR_CREATED' : committed ? 'COMMITTED' : 'NO_CHANGES',
      data: { delivery, pullRequest: documentation.pullRequest },
    });
    logger?.info?.('[factory] delivery step finished', {
      runId: run.runId,
      committed,
      pushed,
      pullRequestUrl,
    });

    return {
      status: pullRequestCreated ? 'DELIVERED' : 'DELIVERED_WITHOUT_PR',
      run,
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
  description: 'Documentation update followed by commit, push and draft pull-request creation.',
  inputSchema: cycleStateSchema,
  outputSchema: outcomeSchema,
})
  .then(documentationStep)
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
      return await suspend({
        reason,
        question,
        attempt: state.attempt,
        maxAttempts: run.maxAttempts,
        rootCause: state.triageReport?.rootCause.category ?? 'UNKNOWN',
        history: state.history,
        traceDir: run.traceDir,
        resumeCommand,
      });
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
        qa: outcome.qaReport?.verdict ?? null,
        codeReview: outcome.reviewReport?.status ?? null,
        security: outcome.securityReport?.status ?? null,
        documentation: outcome.documentationReport?.status ?? null,
      },
      history: outcome.history,
      dryRun: run.dryRun,
    };

    const summaryPath = writeSummary(run.runId, summary);

    const headline =
      outcome.status === 'DELIVERED'
        ? `Draft pull request created: ${pullRequestUrl}`
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
    'review + security -> document -> draft pull request.',
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
