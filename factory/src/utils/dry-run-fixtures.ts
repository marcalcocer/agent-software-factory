/**
 * Dry-run fixtures.
 *
 * With `FACTORY_DRY_RUN=true` no LLM is called: every agent invocation returns one of these
 * canned, schema-valid results. This exists to verify the **graph** - routing, loops, triage
 * decisions, artifacts and summaries - deterministically, with zero token cost, and to let
 * the factory be exercised in CI without provider credentials.
 *
 * `FACTORY_DRY_RUN_SCENARIO` selects the failure path to simulate.
 */
import type {
  DeveloperReport,
  DocumentationReport,
  ExecutionPlan,
  PrWriterAgentOutput,
  ProjectStack,
  QaReport,
  ReviewReport,
  RoundCommitOutput,
  RunNameOutput,
  SecurityReport,
  TriageReport,
} from './schemas.ts';

export const DRY_RUN_SCENARIOS = [
  'happy',
  'retry',
  'infra',
  'review-changes',
  'security-block',
  'escalate',
  'clarify',
  'polish',
  'phased',
] as const;

export type DryRunScenario = (typeof DRY_RUN_SCENARIOS)[number];

export function getDryRunScenario(): DryRunScenario {
  const requested = (process.env.FACTORY_DRY_RUN_SCENARIO ?? 'happy').trim() as DryRunScenario;
  return DRY_RUN_SCENARIOS.includes(requested) ? requested : 'happy';
}

/* -------------------------------------------------------------------------- */
/* 01 - Execution plan                                                         */
/* -------------------------------------------------------------------------- */

export function stubExecutionPlan(
  task: string,
  stack: ProjectStack,
  hasClarifications: boolean,
): ExecutionPlan {
  const scenario = getDryRunScenario();
  const blocking = scenario === 'clarify' && !hasClarifications;

  return {
    summary: `[dry-run] Plan for: ${task.slice(0, 120)}`,
    understanding: '[dry-run] The requirement was restated in behavioural terms.',
    ambiguityLevel: blocking ? 'BLOCKING' : 'NONE',
    clarificationQuestions: blocking
      ? ['[dry-run] Which rounding mode must be applied to half-cent amounts?']
      : [],
    assumptions: hasClarifications ? ['[dry-run] Applied the clarifications provided.'] : [],
    acceptanceCriteria: [
      '[dry-run] The new behaviour is covered by a unit test.',
      '[dry-run] The existing test suite still passes.',
    ],
    tasks: [
      {
        id: 'T1',
        title: '[dry-run] Implement the requested behaviour',
        description: '[dry-run] Production code change described by the plan.',
        type: 'FEATURE',
        targetFiles: ['src/main/example.ts'],
        risk: 'LOW',
        dependsOn: [],
      },
      {
        id: 'T2',
        title: '[dry-run] Cover the behaviour with tests',
        description: '[dry-run] Unit test for the happy path and the boundaries.',
        type: 'TEST',
        targetFiles: ['src/test/example.test.ts'],
        risk: 'LOW',
        dependsOn: ['T1'],
      },
    ],
    testStrategy: {
      unitTests: ['[dry-run] exampleService: happy path, boundary, invalid input'],
      integrationTests: [],
      e2eChecks: [],
      commands: [stack.testCommand ?? 'npm test'],
    },
    conventionNotes: ['[dry-run] Global testing conventions apply: no weakened verification.'],
    outOfScope: ['[dry-run] Unrelated refactors.'],
    risks: [
      {
        description: '[dry-run] Low risk change.',
        severity: 'LOW',
        mitigation: '[dry-run] Covered by tests.',
      },
    ],
    suggestedBranchName: 'feature/dry-run-change',
    commitMessage: 'feat(example): dry-run change',
    // The architect proposes phases only in the scenario that exercises them.
    phasing:
      scenario === 'phased'
        ? {
            phased: true,
            reason: '[dry-run] Too big for one pull request.',
            initiativeTitle: '[dry-run] Rework the example module',
            phases: [
              {
                title: '[dry-run] Foundation',
                goal: '[dry-run] The base the others build on.',
                scope: ['[dry-run] core types', '[dry-run] wiring'],
                acceptance: ['[dry-run] the build passes'],
                dependsOn: [],
              },
              {
                title: '[dry-run] Screens',
                goal: '[dry-run] Apply it to the screens.',
                scope: ['[dry-run] list screen', '[dry-run] detail screen'],
                acceptance: ['[dry-run] screens use the new types'],
                dependsOn: [1],
              },
              {
                title: '[dry-run] Cleanup',
                goal: '[dry-run] Remove the old code.',
                scope: ['[dry-run] dead code'],
                acceptance: ['[dry-run] nothing refers to the old module'],
                dependsOn: [],
              },
            ],
          }
        : null,
  };
}

/* -------------------------------------------------------------------------- */
/* 02 - Developer                                                              */
/* -------------------------------------------------------------------------- */

export function stubDeveloperReport(attempt: number, appliedHints: string[]): DeveloperReport {
  return {
    status: 'COMPLETED',
    summary: `[dry-run] Implementation attempt ${attempt} completed.`,
    changedFiles: [
      { path: 'src/main/example.ts', changeType: 'MODIFIED', purpose: '[dry-run] Feature code.' },
    ],
    testsAdded: [
      {
        path: 'src/test/example.test.ts',
        level: 'UNIT',
        description: '[dry-run] Covers the new behaviour.',
      },
    ],
    commandsRun: [{ command: 'npm test', exitCode: 0, summary: '[dry-run] Local suite green.' }],
    appliedFeedback: appliedHints.map((hint) => `[dry-run] Addressed: ${hint}`),
    selfVerification: { localTestsPassed: true, notes: '[dry-run] Verified locally.' },
    followUps: [],
    blockers: [],
  };
}

/* -------------------------------------------------------------------------- */
/* 03 - QA                                                                     */
/* -------------------------------------------------------------------------- */

function failingQaReport(type: QaReport['failures'][number]['type'], attempt: number): QaReport {
  return {
    verdict: 'FAIL',
    passed: false,
    summary: `[dry-run] Attempt ${attempt} failed with a ${type} failure.`,
    executedCommands: [
      { command: 'npm test', exitCode: 1, durationMs: 4_200, timedOut: false },
    ],
    totals: { tests: 24, passed: 23, failed: 1, skipped: 0 },
    failures: [
      {
        testId: 'ExampleService > rounds half-cent amounts up',
        type,
        message: '[dry-run] expected 10.13 but received 10.12',
        file: 'src/test/example.test.ts',
        line: 42,
        stackExcerpt: '[dry-run] at ExampleService.calculateNet (src/main/example.ts:48)',
        suspectedRootCause:
          type === 'INFRASTRUCTURE'
            ? '[dry-run] Test database container was not ready.'
            : '[dry-run] Rounding applied before the tax multiplication.',
      },
    ],
    e2eChecks: [],
    weakenedVerification: { detected: false, evidence: [] },
    bugReports: [
      {
        title: '[dry-run] Half-cent amounts are rounded down',
        severity: 'MAJOR',
        stepsToReproduce: ['[dry-run] Call calculateNet with 10.125'],
        expected: '10.13',
        actual: '10.12',
        evidence: '[dry-run] Unit test output.',
      },
    ],
    recommendation:
      '[dry-run] Move the rounding after the multiplication in src/main/example.ts:48.',
  };
}

export function stubQaReport(attempt: number): QaReport {
  const scenario = getDryRunScenario();

  if (scenario === 'retry' && attempt === 1) return failingQaReport('PRODUCTION_DEFECT', attempt);
  if (scenario === 'infra' && attempt === 1) return failingQaReport('INFRASTRUCTURE', attempt);
  if (scenario === 'escalate') return failingQaReport('PRODUCTION_DEFECT', attempt);

  return {
    verdict: 'PASS',
    passed: true,
    summary: `[dry-run] Build and suite green on attempt ${attempt}; acceptance criteria verified.`,
    executedCommands: [
      { command: 'npm test', exitCode: 0, durationMs: 3_800, timedOut: false },
    ],
    totals: { tests: 24, passed: 24, failed: 0, skipped: 0 },
    failures: [],
    e2eChecks: [],
    weakenedVerification: { detected: false, evidence: [] },
    bugReports: [],
    recommendation: '[dry-run] No action required.',
  };
}

/** Deterministic QA report used when the developer step reports BLOCKED (no LLM call). */
export function blockedQaReport(reason: string): QaReport {
  return {
    verdict: 'BLOCKED',
    passed: false,
    summary: `Quality gate not executed: the implementation step is blocked. ${reason}`,
    executedCommands: [],
    totals: { tests: null, passed: null, failed: null, skipped: null },
    failures: [],
    e2eChecks: [],
    weakenedVerification: { detected: false, evidence: [] },
    bugReports: [],
    recommendation: 'Resolve the implementation blockers before running the quality gate again.',
  };
}

/* -------------------------------------------------------------------------- */
/* 04 - Triage                                                                 */
/* -------------------------------------------------------------------------- */

export function stubTriageReport(attempt: number, source: string): TriageReport {
  const scenario = getDryRunScenario();

  if (scenario === 'escalate' && attempt >= 2) {
    return {
      decision: 'ESCALATE_HUMAN',
      rootCause: {
        category: 'INFINITE_LOOP',
        explanation: '[dry-run] The same assertion failed in two consecutive attempts.',
        evidence: ['[dry-run] attempt 1 and 2 share the same failure signature'],
      },
      confidence: 0.9,
      loopDetected: true,
      loopEvidence: '[dry-run] Identical failure signature across attempts 1 and 2.',
      developerHints: [],
      filesToInspect: ['src/main/example.ts'],
      infraActions: [],
      humanQuestion: '[dry-run] Which rounding mode is authoritative for half-cent amounts?',
      escalationSummary: '[dry-run] Two attempts failed identically; the requirement is ambiguous.',
      summary: '[dry-run] Escalating: loop detected.',
    };
  }

  if (scenario === 'infra' && attempt === 1) {
    return {
      decision: 'RE-RUN_INFRA',
      rootCause: {
        category: 'ENVIRONMENT',
        explanation: '[dry-run] The test container was not ready when the suite started.',
        evidence: ['[dry-run] connection refused on port 5432'],
      },
      confidence: 0.8,
      loopDetected: false,
      loopEvidence: '',
      developerHints: [],
      filesToInspect: [],
      infraActions: ['[dry-run] Wait for the database container, then re-run the suite.'],
      humanQuestion: '',
      escalationSummary: '',
      summary: '[dry-run] Environmental failure: re-running the infrastructure.',
    };
  }

  return {
    decision: 'RETRY_DEVELOPER',
    rootCause: {
      category: source === 'CODE_REVIEW' ? 'CONVENTION_VIOLATION' : 'PRODUCTION_CODE',
      explanation: '[dry-run] Rounding is applied before the multiplication.',
      evidence: ['[dry-run] src/main/example.ts:48'],
    },
    confidence: 0.85,
    loopDetected: false,
    loopEvidence: '',
    developerHints: [
      '[dry-run] Move the rounding after the tax multiplication in src/main/example.ts:48.',
      '[dry-run] Add a boundary test for 10.125.',
    ],
    filesToInspect: ['src/main/example.ts', 'src/test/example.test.ts'],
    infraActions: [],
    humanQuestion: '',
    escalationSummary: '',
    summary: '[dry-run] Real defect with an actionable fix: retrying the developer.',
  };
}

/* -------------------------------------------------------------------------- */
/* 05 - Review                                                                 */
/* -------------------------------------------------------------------------- */

export function stubReviewReport(attempt: number): ReviewReport {
  const scenario = getDryRunScenario();

  if (scenario === 'review-changes' && attempt === 1) {
    return {
      status: 'CHANGES_REQUESTED',
      summary: '[dry-run] The change needs a boundary test and an error path.',
      scores: { correctness: 4, maintainability: 3, conventions: 3, testQuality: 2 },
      findings: [
        {
          severity: 'MAJOR',
          file: 'src/main/example.ts',
          line: 48,
          issue: '[dry-run] The invalid-input path is unhandled.',
          suggestion: '[dry-run] Validate the argument and throw a domain exception.',
          rule: 'global-rules/java-conventions.md#6-error-handling',
        },
      ],
      conventionViolations: [
        {
          rule: 'Every behavioural change ships with tests',
          source: 'GLOBAL_RULES',
          file: 'src/test/example.test.ts',
          detail: '[dry-run] No boundary test for the half-cent case.',
        },
      ],
      architectureNotes: [],
      positives: ['[dry-run] Change is well scoped.'],
      mustFixBeforeMerge: [
        '[dry-run] Handle invalid input in calculateNet and add a boundary test for 10.125.',
      ],
    };
  }

  // Approved, with a concrete minor remark and a nit: the polish pass fixes the first, only reports the second.
  if (scenario === 'polish') {
    return {
      status: 'APPROVED_WITH_SUGGESTIONS',
      summary: '[dry-run] Correct, with two small remarks.',
      scores: { correctness: 5, maintainability: 4, conventions: 4, testQuality: 5 },
      findings: [
        {
          severity: 'MINOR',
          file: 'src/main/example.ts',
          line: 12,
          issue: '[dry-run] A stale comment.',
          suggestion: '[dry-run] Remove the comment.',
          rule: null,
        },
        {
          severity: 'NIT',
          file: 'src/main/example.ts',
          line: 30,
          issue: '[dry-run] A name could be shorter.',
          suggestion: '[dry-run] Rename it.',
          rule: null,
        },
      ],
      conventionViolations: [],
      architectureNotes: [],
      positives: ['[dry-run] Clear naming and focused diff.'],
      mustFixBeforeMerge: [],
    };
  }

  return {
    status: 'APPROVED',
    summary: '[dry-run] Change is correct, idiomatic and well tested.',
    scores: { correctness: 5, maintainability: 5, conventions: 5, testQuality: 5 },
    findings: [],
    conventionViolations: [],
    architectureNotes: ['[dry-run] Layering respected.'],
    positives: ['[dry-run] Clear naming and focused diff.'],
    mustFixBeforeMerge: [],
  };
}

/* -------------------------------------------------------------------------- */
/* 06 - Security                                                               */
/* -------------------------------------------------------------------------- */

export function stubSecurityReport(attempt: number): SecurityReport {
  const scenario = getDryRunScenario();

  if (scenario === 'security-block' && attempt === 1) {
    return {
      status: 'CHANGES_REQUESTED',
      riskLevel: 'HIGH',
      summary: '[dry-run] The diff concatenates request data into a SQL statement.',
      findings: [
        {
          severity: 'HIGH',
          category: 'SQL_INJECTION',
          owasp: 'A03:2021',
          cwe: 'CWE-89',
          file: 'src/main/example.ts',
          line: 61,
          evidence: '[dry-run] `"SELECT * FROM invoices WHERE id = " + id`',
          impact: '[dry-run] An attacker can read arbitrary rows.',
          remediation: '[dry-run] Use a parameterised query.',
          preExisting: false,
        },
      ],
      secretsDetected: [],
      dependencyRisks: [],
      mustFixBeforeMerge: ['[dry-run] Replace the concatenated SQL with a parameterised query.'],
    };
  }

  return {
    status: 'PASS',
    riskLevel: 'NONE',
    summary: '[dry-run] No security regression introduced by this diff.',
    findings: [],
    secretsDetected: [],
    dependencyRisks: [],
    mustFixBeforeMerge: [],
  };
}

/* -------------------------------------------------------------------------- */
/* 07 - Documentation                                                          */
/* -------------------------------------------------------------------------- */

export function stubDocumentationReport(): DocumentationReport {
  return {
    status: 'COMPLETED',
    summary: '[dry-run] Changelog entry added.',
    updatedFiles: [
      {
        path: 'CHANGELOG.md',
        changeType: 'MODIFIED',
        description: '[dry-run] Added an entry under Fixed.',
      },
    ],
    changelogEntry: { section: 'Fixed', entries: ['[dry-run] Half-cent amounts round correctly.'] },
    openApiUpdated: false,
    openApiNotes: '[dry-run] No HTTP contract changed.',
    followUps: [],
  };
}

/* -------------------------------------------------------------------------- */
/* 07 - Pull-request text (PR writer)                                          */
/* -------------------------------------------------------------------------- */

export function stubPrWriterOutput(task: string, branch: string): PrWriterAgentOutput {
  return {
    commitMessage: {
      subject: 'feat(example): dry-run change',
      body: '[dry-run] Canned commit message body.',
    },
    pullRequest: {
      title: 'feat(example): dry-run change',
      body: [
        '## Summary',
        '',
        `[dry-run] ${task.slice(0, 160)}`,
        '',
        '## Changes',
        '',
        '- [dry-run] Feature code and unit tests.',
        '',
        '## Test plan',
        '',
        '- `npm test` -> exit 0',
        '',
        '## Risks & rollback',
        '',
        `[dry-run] Low risk. Revert branch \`${branch}\`.`,
      ].join('\n'),
      labels: ['dry-run'],
      breakingChanges: false,
    },
  };
}

/** What the run namer answers in a dry run: fixed, so the branch of a smoke run is predictable. */
export function stubRunName(): RunNameOutput {
  return { title: '[dry-run] Exercise the factory graph', slug: 'dry-run-exercise-graph', type: 'chore' };
}

/** What the PR writer answers for a round in a dry run. */
export function stubRoundCommit(): RoundCommitOutput {
  return { commitMessage: { subject: 'fix(example): dry-run follow-up', body: '[dry-run] Canned message for the commit of a round.' } };
}
