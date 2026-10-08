/**
 * Shared data contracts of the software factory.
 *
 * These schemas are the interface between agents, workflow steps and the JSON artifacts
 * written to `logs/<runId>/`. Agent output schemas use `.nullable()` instead of `.optional()`
 * because strict structured-output modes require every property to be present.
 */
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Workflow input                                                              */
/* -------------------------------------------------------------------------- */

export const factoryTaskSchema = z.object({
  task: z.string().min(10).describe('The requirement to implement, in English.'),
  repo: z
    .string()
    .describe('Target repository: a folder name inside the workspace root or an absolute path.'),
  baseBranch: z.string().optional().describe('Branch to start from. Defaults to the current HEAD.'),
  branchName: z.string().optional().describe('Work branch name. Defaults to a generated one.'),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  testCommand: z.string().optional().describe('Override the auto-detected test command.'),
  acceptanceCriteria: z.array(z.string()).optional().describe('Extra criteria from the requester.'),
  clarifications: z
    .string()
    .optional()
    .describe('Answers to previous clarification questions, or human guidance after escalation.'),
  autoCommit: z.boolean().optional().describe('Commit the work on success (default: true).'),
  createPullRequest: z.boolean().optional().describe('Open a draft PR on success (default: true).'),
  interactive: z
    .boolean()
    .optional()
    .describe('Allow the workflow to suspend for human input (default: true).'),
});
export type FactoryTask = z.infer<typeof factoryTaskSchema>;

/* -------------------------------------------------------------------------- */
/* Run context                                                                 */
/* -------------------------------------------------------------------------- */

export const projectStackSchema = z.object({
  type: z.string().describe('maven | gradle | npm | pnpm | yarn | python | go | rust | unknown'),
  language: z.string(),
  buildCommand: z.string().nullable(),
  testCommand: z.string().nullable(),
  lintCommand: z.string().nullable(),
  markers: z.array(z.string()).describe('Files that identified the stack.'),
});
export type ProjectStack = z.infer<typeof projectStackSchema>;

export const runContextSchema = z.object({
  runId: z.string(),
  traceDir: z.string(),
  task: z.string(),
  clarifications: z.string().optional(),
  repoPath: z.string(),
  repoName: z.string(),
  baseBranch: z.string(),
  workBranch: z.string(),
  branchCreated: z.boolean(),
  stack: projectStackSchema,
  testCommand: z.string().nullable(),
  requesterCriteria: z.array(z.string()),
  conventions: z.object({
    globalRuleFiles: z.array(z.string()),
    projectRulesFile: z.string().nullable(),
  }),
  maxAttempts: z.number().int(),
  autoCommit: z.boolean(),
  createPullRequest: z.boolean(),
  interactive: z.boolean(),
  dryRun: z.boolean(),
  startedAt: z.string(),
});
export type RunContext = z.infer<typeof runContextSchema>;

/* -------------------------------------------------------------------------- */
/* 01 - PM & Architect                                                         */
/* -------------------------------------------------------------------------- */

export const executionPlanSchema = z.object({
  summary: z.string().describe('One-paragraph abstract of the plan.'),
  understanding: z.string().describe('The requirement restated in behavioural terms.'),
  ambiguityLevel: z
    .enum(['NONE', 'MINOR', 'BLOCKING'])
    .describe('BLOCKING only when a human decision is strictly required.'),
  clarificationQuestions: z.array(z.string()).describe('Closed questions, one sentence each.'),
  assumptions: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()).describe('Verifiable statements defining "done".'),
  tasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      type: z.enum(['FEATURE', 'BUGFIX', 'TEST', 'REFACTOR', 'DOCS', 'INFRA']),
      targetFiles: z.array(z.string()).describe('Repository-relative paths.'),
      risk: z.enum(['LOW', 'MEDIUM', 'HIGH']),
      dependsOn: z.array(z.string()),
    }),
  ),
  testStrategy: z.object({
    unitTests: z.array(z.string()),
    integrationTests: z.array(z.string()),
    e2eChecks: z.array(z.string()),
    commands: z.array(z.string()).describe('Exact commands to run the suites.'),
  }),
  conventionNotes: z.array(z.string()).describe('Global/project rules constraining this task.'),
  outOfScope: z.array(z.string()),
  risks: z.array(
    z.object({
      description: z.string(),
      severity: z.enum(['LOW', 'MEDIUM', 'HIGH']),
      mitigation: z.string(),
    }),
  ),
  suggestedBranchName: z.string(),
  commitMessage: z.string().describe('Conventional Commits subject, <= 72 characters.'),
});
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;

/* -------------------------------------------------------------------------- */
/* 02 - Developer                                                              */
/* -------------------------------------------------------------------------- */

export const developerReportSchema = z.object({
  status: z.enum(['COMPLETED', 'PARTIAL', 'BLOCKED']),
  summary: z.string(),
  changedFiles: z.array(
    z.object({
      path: z.string(),
      changeType: z.enum(['ADDED', 'MODIFIED', 'DELETED']),
      purpose: z.string(),
    }),
  ),
  testsAdded: z.array(
    z.object({
      path: z.string(),
      level: z.enum(['UNIT', 'INTEGRATION', 'E2E']),
      description: z.string(),
    }),
  ),
  commandsRun: z.array(
    z.object({ command: z.string(), exitCode: z.number().int(), summary: z.string() }),
  ),
  appliedFeedback: z.array(z.string()).describe('One entry per hint addressed on a retry.'),
  selfVerification: z.object({ localTestsPassed: z.boolean(), notes: z.string() }),
  followUps: z.array(z.string()),
  blockers: z.array(z.string()),
});
export type DeveloperReport = z.infer<typeof developerReportSchema>;

/* -------------------------------------------------------------------------- */
/* 03 - QA & Tester                                                            */
/* -------------------------------------------------------------------------- */

export const qaFailureTypeSchema = z.enum([
  'COMPILATION',
  'PRODUCTION_DEFECT',
  'TEST_DEFECT',
  'INFRASTRUCTURE',
  'FLAKY',
]);

export const qaReportSchema = z.object({
  verdict: z.enum(['PASS', 'FAIL', 'BLOCKED']),
  passed: z.boolean(),
  summary: z.string(),
  executedCommands: z.array(
    z.object({
      command: z.string(),
      exitCode: z.number().int(),
      durationMs: z.number().int(),
      timedOut: z.boolean(),
    }),
  ),
  totals: z.object({
    tests: z.number().int().nullable(),
    passed: z.number().int().nullable(),
    failed: z.number().int().nullable(),
    skipped: z.number().int().nullable(),
  }),
  failures: z.array(
    z.object({
      testId: z.string(),
      type: qaFailureTypeSchema,
      message: z.string(),
      file: z.string().nullable(),
      line: z.number().int().nullable(),
      stackExcerpt: z.string().nullable(),
      suspectedRootCause: z.string(),
    }),
  ),
  e2eChecks: z.array(
    z.object({
      name: z.string(),
      request: z.string(),
      expected: z.string(),
      actual: z.string(),
      passed: z.boolean(),
    }),
  ),
  weakenedVerification: z.object({ detected: z.boolean(), evidence: z.array(z.string()) }),
  bugReports: z.array(
    z.object({
      title: z.string(),
      severity: z.enum(['BLOCKER', 'CRITICAL', 'MAJOR', 'MINOR']),
      stepsToReproduce: z.array(z.string()),
      expected: z.string(),
      actual: z.string(),
      evidence: z.string(),
    }),
  ),
  recommendation: z.string().describe('The single most useful next action for the developer.'),
});
export type QaReport = z.infer<typeof qaReportSchema>;

/* -------------------------------------------------------------------------- */
/* 04 - Triage (Director / Evaluator)                                          */
/* -------------------------------------------------------------------------- */

export const triageDecisionValues = [
  'RETRY_DEVELOPER',
  'RE-RUN_INFRA',
  'ESCALATE_HUMAN',
  'APPROVE_AND_CONTINUE',
] as const;

export const triageReportSchema = z.object({
  decision: z.enum(triageDecisionValues),
  rootCause: z.object({
    category: z.enum([
      'PRODUCTION_CODE',
      'TEST_CODE',
      'MISSING_DEPENDENCY',
      'ENVIRONMENT',
      'FLAKY_TEST',
      'AMBIGUOUS_REQUIREMENT',
      'CONTRADICTORY_REQUIREMENT',
      'INFINITE_LOOP',
      'EXTERNAL_SERVICE',
      'CONVENTION_VIOLATION',
      'SECURITY_DEFECT',
      'UNKNOWN',
    ]),
    explanation: z.string(),
    evidence: z.array(z.string()),
  }),
  confidence: z.number().min(0).max(1),
  loopDetected: z.boolean(),
  loopEvidence: z.string(),
  developerHints: z.array(z.string()).describe('Concrete, actionable, different from last time.'),
  filesToInspect: z.array(z.string()),
  infraActions: z.array(z.string()),
  humanQuestion: z.string(),
  escalationSummary: z.string(),
  summary: z.string(),
});
export type TriageReport = z.infer<typeof triageReportSchema>;

/* -------------------------------------------------------------------------- */
/* 05 - Code review                                                            */
/* -------------------------------------------------------------------------- */

export const reviewReportSchema = z.object({
  status: z.enum(['APPROVED', 'APPROVED_WITH_SUGGESTIONS', 'CHANGES_REQUESTED']),
  summary: z.string(),
  scores: z.object({
    correctness: z.number().int().min(1).max(5),
    maintainability: z.number().int().min(1).max(5),
    conventions: z.number().int().min(1).max(5),
    testQuality: z.number().int().min(1).max(5),
  }),
  findings: z.array(
    z.object({
      severity: z.enum(['BLOCKER', 'MAJOR', 'MINOR', 'NIT']),
      file: z.string(),
      line: z.number().int().nullable(),
      issue: z.string(),
      suggestion: z.string(),
      rule: z.string().nullable(),
    }),
  ),
  conventionViolations: z.array(
    z.object({
      rule: z.string(),
      source: z.enum(['GLOBAL_RULES', 'PROJECT_AGENTS_MD', 'LANGUAGE_IDIOM']),
      file: z.string(),
      detail: z.string(),
    }),
  ),
  architectureNotes: z.array(z.string()),
  positives: z.array(z.string()),
  mustFixBeforeMerge: z.array(z.string()),
});
export type ReviewReport = z.infer<typeof reviewReportSchema>;

/* -------------------------------------------------------------------------- */
/* 06 - Security                                                               */
/* -------------------------------------------------------------------------- */

export const securityReportSchema = z.object({
  status: z.enum(['PASS', 'PASS_WITH_WARNINGS', 'CHANGES_REQUESTED']),
  riskLevel: z.enum(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  summary: z.string(),
  findings: z.array(
    z.object({
      severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']),
      category: z.string().describe('Short vulnerability class, e.g. SQL_INJECTION, XSS, SSRF.'),
      owasp: z.string().nullable().describe('OWASP Top 10 id, e.g. A03:2021.'),
      cwe: z.string().nullable(),
      file: z.string(),
      line: z.number().int().nullable(),
      evidence: z.string(),
      impact: z.string(),
      remediation: z.string(),
      preExisting: z.boolean(),
    }),
  ),
  secretsDetected: z.array(
    z.object({
      file: z.string(),
      line: z.number().int().nullable(),
      kind: z.string(),
      evidence: z.string().describe('Masked evidence. Never include the full secret.'),
      action: z.string(),
    }),
  ),
  dependencyRisks: z.array(
    z.object({
      dependency: z.string(),
      version: z.string(),
      issue: z.string(),
      severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']),
      recommendation: z.string(),
    }),
  ),
  mustFixBeforeMerge: z.array(z.string()),
});
export type SecurityReport = z.infer<typeof securityReportSchema>;

/* -------------------------------------------------------------------------- */
/* 07 - Documentation                                                          */
/* -------------------------------------------------------------------------- */

export const documentationReportSchema = z.object({
  status: z.enum(['COMPLETED', 'PARTIAL', 'SKIPPED']),
  summary: z.string(),
  updatedFiles: z.array(
    z.object({
      path: z.string(),
      changeType: z.enum(['ADDED', 'MODIFIED']),
      description: z.string(),
    }),
  ),
  changelogEntry: z.object({
    section: z.enum(['Added', 'Changed', 'Fixed', 'Removed', 'Security', 'None']),
    entries: z.array(z.string()),
  }),
  openApiUpdated: z.boolean(),
  openApiNotes: z.string(),
  pullRequest: z.object({
    title: z.string().describe('Conventional Commits style, <= 72 characters.'),
    body: z.string().describe('Markdown body with Summary, Changes, Test plan, Quality gates.'),
    labels: z.array(z.string()),
    breakingChanges: z.boolean(),
    testPlan: z.array(z.string()),
  }),
  followUps: z.array(z.string()),
});
export type DocumentationReport = z.infer<typeof documentationReportSchema>;

/* -------------------------------------------------------------------------- */
/* 08 - Delivery                                                               */
/* -------------------------------------------------------------------------- */

export const deliveryReportSchema = z.object({
  committed: z.boolean(),
  commitSha: z.string().nullable(),
  commitMessage: z.string().nullable(),
  pushed: z.boolean(),
  pullRequestCreated: z.boolean(),
  pullRequestUrl: z.string().nullable(),
  branch: z.string(),
  pendingActions: z.array(z.string()).describe('Manual steps left to the human operator.'),
  notes: z.array(z.string()),
});
export type DeliveryReport = z.infer<typeof deliveryReportSchema>;

/* -------------------------------------------------------------------------- */
/* Iteration state                                                             */
/* -------------------------------------------------------------------------- */

export const feedbackSchema = z.object({
  source: z.enum(['QA', 'CODE_REVIEW', 'SECURITY', 'TRIAGE', 'INFRA', 'HUMAN']),
  attempt: z.number().int(),
  hints: z.array(z.string()),
  filesToInspect: z.array(z.string()),
  failingTests: z.array(z.string()),
  doNotRetry: z.array(z.string()).describe('Strategies that already failed.'),
  notes: z.string(),
});
export type Feedback = z.infer<typeof feedbackSchema>;

export const attemptHistorySchema = z.object({
  attempt: z.number().int(),
  developerStatus: z.string().nullable(),
  qaVerdict: z.string().nullable(),
  qaFailureSignature: z.string().nullable().describe('Stable fingerprint used for loop detection.'),
  reviewStatus: z.string().nullable(),
  securityStatus: z.string().nullable(),
  triageDecision: z.string().nullable(),
  triageRootCause: z.string().nullable(),
  notes: z.string(),
});
export type AttemptHistory = z.infer<typeof attemptHistorySchema>;

export const cycleStateSchema = z.object({
  run: runContextSchema,
  plan: executionPlanSchema,
  attempt: z.number().int().describe('1-based index of the current develop/QA/review iteration.'),
  phase: z.enum(['DEVELOP', 'QA', 'VERIFY', 'TRIAGE', 'DONE', 'ESCALATED']),
  cycleComplete: z.boolean().describe('Loop exit flag: QA + review + security all satisfied.'),
  escalate: z.boolean().describe('Loop exit flag: human intervention required.'),
  escalationReason: z.string().nullable(),
  rerunInfra: z.boolean().describe('Last triage asked for an infrastructure re-run.'),
  feedback: feedbackSchema.nullable(),
  history: z.array(attemptHistorySchema),
  developerReport: developerReportSchema.nullable(),
  qaReport: qaReportSchema.nullable(),
  reviewReport: reviewReportSchema.nullable(),
  securityReport: securityReportSchema.nullable(),
  triageReport: triageReportSchema.nullable(),
});
export type CycleState = z.infer<typeof cycleStateSchema>;

/* -------------------------------------------------------------------------- */
/* Outcome / final result                                                      */
/* -------------------------------------------------------------------------- */

export const outcomeSchema = z.object({
  status: z.enum([
    'DELIVERED',
    'DELIVERED_WITHOUT_PR',
    'ESCALATED_TO_HUMAN',
    'ABORTED_BY_HUMAN',
    'BLOCKED',
  ]),
  run: runContextSchema,
  plan: executionPlanSchema,
  attempts: z.number().int(),
  history: z.array(attemptHistorySchema),
  qaReport: qaReportSchema.nullable(),
  reviewReport: reviewReportSchema.nullable(),
  securityReport: securityReportSchema.nullable(),
  developerReport: developerReportSchema.nullable(),
  triageReport: triageReportSchema.nullable(),
  documentationReport: documentationReportSchema.nullable(),
  deliveryReport: deliveryReportSchema.nullable(),
  escalation: z
    .object({
      reason: z.string(),
      question: z.string(),
      humanDecision: z.string().nullable(),
      humanGuidance: z.string().nullable(),
      resumeCommand: z.string(),
    })
    .nullable(),
});
export type Outcome = z.infer<typeof outcomeSchema>;

export const runSummarySchema = z.object({
  runId: z.string(),
  status: outcomeSchema.shape.status,
  task: z.string(),
  repository: z.string(),
  branch: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().int(),
  attempts: z.number().int(),
  pullRequestUrl: z.string().nullable(),
  tokens: z.object({
    input: z.number().int(),
    output: z.number().int(),
    reasoning: z.number().int(),
    cached: z.number().int(),
    total: z.number().int(),
  }),
  agentCalls: z.number().int(),
  toolCalls: z.number().int(),
  modelsUsed: z.array(
    z.object({
      role: z.string(),
      requestedModel: z.string(),
      servedByModel: z.string(),
      calls: z.number().int(),
      inputTokens: z.number().int(),
      outputTokens: z.number().int(),
      totalTokens: z.number().int(),
      durationMs: z.number().int(),
      failovers: z.number().int(),
    }),
  ),
  steps: z.array(
    z.object({
      step: z.string(),
      attempt: z.number().int(),
      status: z.string(),
      durationMs: z.number().int(),
      artifact: z.string().nullable(),
    }),
  ),
  artifacts: z.array(z.string()),
  escalation: outcomeSchema.shape.escalation,
});
export type RunSummary = z.infer<typeof runSummarySchema>;

export const factoryResultSchema = z.object({
  runId: z.string(),
  status: outcomeSchema.shape.status,
  repository: z.string(),
  branch: z.string(),
  attempts: z.number().int(),
  pullRequestUrl: z.string().nullable(),
  traceDir: z.string(),
  summaryPath: z.string(),
  summary: z.string(),
  escalation: outcomeSchema.shape.escalation,
});
export type FactoryResult = z.infer<typeof factoryResultSchema>;
