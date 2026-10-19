/**
 * Reports used when an optional stage is disabled for a task.
 *
 * A disabled stage still has to produce a report, because later steps read those reports to
 * decide whether the cycle is complete. The reports below are deliberately *passing*: the user
 * chose to skip the stage, so it must not block delivery. They are equally deliberately
 * explicit about being skipped, so a reader of `summary.json` never mistakes a skipped gate for
 * a gate that actually ran and found nothing.
 *
 * No LLM call is made for a skipped stage: that is the point of disabling it.
 */
import type {
  DocumentationReport,
  QaReport,
  ReviewReport,
  SecurityReport,
} from './schemas.ts';

/** Prefix making the reason visible in every artifact and summary. */
const SKIPPED = 'Stage disabled for this task.';

export function skippedQaReport(): QaReport {
  return {
    verdict: 'PASS',
    passed: true,
    summary: `${SKIPPED} The build and test suite were not executed, so there is no test evidence for this change.`,
    executedCommands: [],
    totals: { tests: null, passed: null, failed: null, skipped: null },
    failures: [],
    e2eChecks: [],
    weakenedVerification: { detected: false, evidence: [] },
    bugReports: [],
    recommendation: 'Enable the QA stage to verify this change against the test suite.',
  };
}

export function skippedReviewReport(): ReviewReport {
  return {
    status: 'APPROVED',
    summary: `${SKIPPED} The diff was not reviewed.`,
    scores: { correctness: 3, maintainability: 3, conventions: 3, testQuality: 3 },
    findings: [],
    conventionViolations: [],
    architectureNotes: ['Enable the review stage to get a code review of this change.'],
    positives: [],
    mustFixBeforeMerge: [],
  };
}

export function skippedSecurityReport(): SecurityReport {
  return {
    status: 'PASS',
    riskLevel: 'NONE',
    summary: `${SKIPPED} No security audit was performed on this change.`,
    findings: [],
    secretsDetected: [],
    dependencyRisks: [],
    mustFixBeforeMerge: [],
  };
}

export function skippedDocumentationReport(): DocumentationReport {
  return {
    status: 'SKIPPED',
    summary: `${SKIPPED} No documentation was reviewed or updated.`,
    updatedFiles: [],
    changelogEntry: { section: 'None', entries: [] },
    openApiUpdated: false,
    openApiNotes: '',
    followUps: [],
  };
}
