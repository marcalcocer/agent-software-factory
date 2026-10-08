#!/usr/bin/env -S npx tsx
/**
 * Graph smoke test.
 *
 * Executes the complete factory workflow once per dry-run scenario and asserts the routing,
 * the loop behaviour, the suspend/resume contract and the artifacts written to `logs/<runId>/`.
 * No LLM is called and the target repository is never modified, so this is safe to run in CI
 * and without provider credentials.
 *
 *   npm run smoke
 *   npm run smoke -- --scenario retry
 */
import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';

process.env.FACTORY_DRY_RUN = 'true';
process.env.FACTORY_ALLOW_PUSH = process.env.FACTORY_ALLOW_PUSH ?? 'false';
process.env.FACTORY_ALLOW_PR = process.env.FACTORY_ALLOW_PR ?? 'false';
process.env.FACTORY_LOG_LEVEL = process.env.FACTORY_LOG_LEVEL ?? 'warn';

const { mastra } = await import('../mastra/index.ts');
const { generateRunId, traceDirFor } = await import('../tools/logger-tools.ts');
const { PROJECT_ROOT } = await import('../utils/factory-config.ts');

interface ScenarioExpectation {
  scenario: string;
  description: string;
  interactive: boolean;
  /** Expected terminal status, or `suspended` when human input must be requested. */
  expect: 'suspended' | string;
  /** Resume payload applied when the run suspends, plus the status expected afterwards. */
  resume?: { data: Record<string, unknown>; expect: string };
  expectedAttempts?: number;
  requiredArtifacts: string[];
}

const SCENARIOS: ScenarioExpectation[] = [
  {
    scenario: 'happy',
    description: 'plan -> develop -> QA pass -> review+security approve -> docs -> delivery',
    interactive: false,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 1,
    requiredArtifacts: [
      '01-pm-architect.json',
      '02-developer.json',
      '03-qa-tester.json',
      '05-code-review.json',
      '06-security.json',
      '07-documentation.json',
      '08-pull-request.json',
      'summary.json',
    ],
  },
  {
    scenario: 'retry',
    description: 'QA fails -> triage RETRY_DEVELOPER -> second attempt passes',
    interactive: false,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 2,
    requiredArtifacts: [
      '02-developer.json',
      '03-qa-tester.json',
      '04-triage.json',
      '02-developer.attempt-2.json',
      '03-qa-tester.attempt-2.json',
      'summary.json',
    ],
  },
  {
    scenario: 'infra',
    description: 'QA fails on environment -> triage RE-RUN_INFRA -> developer skipped -> pass',
    interactive: false,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 2,
    requiredArtifacts: ['04-triage.json', '02-developer.attempt-2.json', 'summary.json'],
  },
  {
    scenario: 'review-changes',
    description: 'QA passes but review requests changes -> triage -> fixed on attempt 2',
    interactive: false,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 2,
    requiredArtifacts: ['05-code-review.json', '04-triage.json', '05-code-review.attempt-2.json'],
  },
  {
    scenario: 'security-block',
    description: 'security audit blocks the change -> triage -> fixed on attempt 2',
    interactive: false,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 2,
    requiredArtifacts: ['06-security.json', '04-triage.json', '06-security.attempt-2.json'],
  },
  {
    scenario: 'escalate',
    description: 'repeated identical failure -> loop detected -> suspend for human',
    interactive: true,
    expect: 'suspended',
    resume: { data: { decision: 'ACKNOWLEDGE', guidance: 'Use HALF_UP rounding.' }, expect: 'ESCALATED_TO_HUMAN' },
    requiredArtifacts: ['04-triage.json', '09-escalation.json'],
  },
  {
    scenario: 'escalate',
    description: 'same failure in CI mode -> escalation recorded without suspending',
    interactive: false,
    expect: 'ESCALATED_TO_HUMAN',
    requiredArtifacts: ['09-escalation.json', 'summary.json'],
  },
  {
    scenario: 'clarify',
    description: 'blocking ambiguity -> suspend -> resume with clarifications -> delivery',
    interactive: true,
    expect: 'suspended',
    resume: { data: { clarifications: 'Round half-cent amounts up (HALF_UP).' }, expect: 'DELIVERED_WITHOUT_PR' },
    requiredArtifacts: ['01-pm-architect.json'],
  },
];

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}\n`);
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function runScenario(expectation: ScenarioExpectation, index: number): Promise<void> {
  process.env.FACTORY_DRY_RUN_SCENARIO = expectation.scenario;
  process.env.FACTORY_NON_INTERACTIVE = expectation.interactive ? 'false' : 'true';

  const label = `[${index + 1}/${SCENARIOS.length}] ${expectation.scenario}${
    expectation.interactive ? ' (interactive)' : ' (ci)'
  }`;
  process.stdout.write(`\n${label}: ${expectation.description}\n`);

  const workflow = mastra.getWorkflow('softwareFactoryWorkflow');
  const runId = generateRunId(`smoke-${expectation.scenario}`);
  const run = await workflow.createRun({ runId });

  let result = await run.start({
    inputData: {
      task: `Smoke test the factory graph for the "${expectation.scenario}" scenario.`,
      repo: PROJECT_ROOT,
      maxAttempts: 2,
      autoCommit: false,
      createPullRequest: false,
      interactive: expectation.interactive,
    },
  });

  if (expectation.expect === 'suspended') {
    check(`${label} suspends for human input`, result.status === 'suspended', `status=${result.status}`);
    if (result.status === 'suspended') {
      check(
        `${label} suspend payload is actionable`,
        JSON.stringify(result.suspendPayload ?? {}).length > 20,
        JSON.stringify(result.suspendPayload).slice(0, 110),
      );
    }

    if (expectation.resume) {
      const resumeRun = await workflow.createRun({ runId });
      result = await resumeRun.resume({ resumeData: expectation.resume.data as never });
      check(
        `${label} resumes to ${expectation.resume.expect}`,
        result.status === 'success' && result.result.status === expectation.resume.expect,
        result.status === 'success' ? `status=${result.result.status}` : `status=${result.status}`,
      );
    }
  } else {
    check(
      `${label} completes with ${expectation.expect}`,
      result.status === 'success' && result.result.status === expectation.expect,
      result.status === 'success'
        ? `status=${result.result.status}`
        : `status=${result.status} ${
            result.status === 'failed' ? (result.error?.message ?? '') : ''
          }`,
    );
  }

  if (result.status === 'failed') {
    process.stderr.write(`${result.error?.stack ?? result.error?.message ?? 'unknown error'}\n`);
    return;
  }

  if (expectation.expectedAttempts !== undefined && result.status === 'success') {
    check(
      `${label} used ${expectation.expectedAttempts} attempt(s)`,
      result.result.attempts === expectation.expectedAttempts,
      `attempts=${result.result.attempts}`,
    );
  }

  const traceDir = traceDirFor(runId);
  const present = fs.existsSync(traceDir) ? fs.readdirSync(traceDir) : [];
  const missing = expectation.requiredArtifacts.filter((artifact) => !present.includes(artifact));
  check(`${label} writes the expected artifacts`, missing.length === 0, missing.length > 0 ? `missing: ${missing.join(', ')}` : `${present.length} files`);

  check(
    `${label} writes the run event log`,
    fs.existsSync(path.join(traceDir, 'events.ndjson')),
  );

  const summaryPath = path.join(traceDir, 'summary.json');
  if (fs.existsSync(summaryPath)) {
    const summary = readJsonFile(summaryPath);
    const steps = (summary?.steps as unknown[] | undefined) ?? [];
    const models = (summary?.modelsUsed as unknown[] | undefined) ?? [];
    check(
      `${label} summary.json is complete`,
      Boolean(summary?.runId) &&
        Boolean(summary?.status) &&
        typeof summary?.durationMs === 'number' &&
        Boolean(summary?.tokens) &&
        steps.length > 0 &&
        models.length > 0,
      `steps=${steps.length} models=${models.length} agentCalls=${String(summary?.agentCalls)}`,
    );
  }
}

/* -------------------------------------------------------------------------- */

const onlyScenario = process.argv.includes('--scenario')
  ? process.argv[process.argv.indexOf('--scenario') + 1]
  : undefined;

const selected = onlyScenario
  ? SCENARIOS.filter((entry) => entry.scenario === onlyScenario)
  : SCENARIOS;

process.stdout.write(
  `\nFactory graph smoke test (dry run, no LLM calls)\nscenarios: ${selected.length}\n`,
);

for (const [index, expectation] of selected.entries()) {
  try {
    await runScenario(expectation, index);
  } catch (error) {
    check(
      `[${index + 1}] ${expectation.scenario} threw`,
      false,
      error instanceof Error ? error.message : String(error),
    );
    if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  }
}

const failed = results.filter((entry) => !entry.ok);
process.stdout.write(
  `\n${'-'.repeat(60)}\n${results.length - failed.length}/${results.length} checks passed\n`,
);
if (failed.length > 0) {
  process.stdout.write(`\nFailed checks:\n${failed.map((entry) => `  - ${entry.name}: ${entry.detail}`).join('\n')}\n`);
}

process.exit(failed.length === 0 ? 0 : 1);
