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
 *
 * The traces and the workflow database go to a throwaway directory, never to the real `logs/`:
 * a smoke run in the real one lands in the Studio's run history and in the database that holds
 * real suspended runs. Set `FACTORY_LOG_DIR` to keep them (CI does, to upload them on failure).
 * A failed run keeps its directory and prints where it is.
 */
import 'dotenv/config';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedLogDir =
  process.env.FACTORY_LOG_DIR === undefined || process.env.FACTORY_LOG_DIR.trim() === ''
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'factory-smoke-'))
    : undefined;
if (isolatedLogDir) {
  process.env.FACTORY_LOG_DIR = isolatedLogDir;
  process.env.FACTORY_STORAGE_URL = `file:${path.join(isolatedLogDir, 'factory.db')}`;
}

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
  /** Optional stages to switch off for this scenario (what `--no-qa` / `--no-docs` ... do). */
  pipeline?: { qa?: boolean; review?: boolean; security?: boolean; documentation?: boolean };
  /** Further assertions on what the run wrote. Each entry is `[name, ok, detail]`. */
  extraChecks?: (traceDir: string) => Array<[string, boolean, string?]>;
}

/**
 * What must hold for the pull-request text of any run that reaches delivery: it was written by the PR
 * writer (whatever the documentation stage did), the delivery used exactly that text, and the
 * "Quality gates" section is the factory's own - it states the true outcome of every stage.
 */
function prTextChecks(
  traceDir: string,
  expected: { documentation: string; expectGates: string[] },
): Array<[string, boolean, string?]> {
  const read = (file: string): Record<string, any> | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(traceDir, file), 'utf8')) as Record<string, any>;
    } catch {
      return null;
    }
  };
  const docs = read('07-documentation.json');
  const writer = read('07-pr-writer.json');
  const delivery = read('08-pull-request.json');
  const body: string = writer?.data?.pullRequest?.body ?? '';
  const title: string = writer?.data?.pullRequest?.title ?? '';
  const checks: Array<[string, boolean, string?]> = [
    ['documentation artifact has the expected status', docs?.status === expected.documentation, `status=${String(docs?.status)}`],
    ['the PR writer ran and completed', writer?.status === 'COMPLETED', `status=${String(writer?.status)}`],
    ['the PR writer produced a title, a description and a commit message', title !== '' && body.length > 40 && String(writer?.data?.commitMessage ?? '') !== '', title],
    ['the title is not the raw task text', title !== '' && !title.startsWith('Smoke test the factory graph'), title],
    ['delivery used the PR writer\'s title', delivery?.data?.pullRequest?.title === title, String(delivery?.data?.pullRequest?.title)],
    ['delivery used the PR writer\'s description', delivery?.data?.pullRequest?.body === body],
    ['the description carries no placeholder about a disabled stage', !/this description was not written/i.test(body)],
  ];
  for (const line of expected.expectGates) {
    checks.push([`the Quality gates section says "${line}"`, body.includes(`- ${line}`)]);
  }
  return checks;
}

/**
 * What `summary.json` reports for the quality gates. A stage that was switched off did not run, so it
 * must read `SKIPPED` - never the passing verdict its placeholder report carries.
 */
function gateChecks(
  traceDir: string,
  expected: { qa: string; codeReview: string; security: string; documentation: string },
): Array<[string, boolean, string?]> {
  let gates: Record<string, unknown> = {};
  try {
    gates = (JSON.parse(fs.readFileSync(path.join(traceDir, 'summary.json'), 'utf8')) as { gates?: Record<string, unknown> }).gates ?? {};
  } catch {
    // reported below
  }
  return (Object.keys(expected) as Array<keyof typeof expected>).map((gate) => [
    `summary.json reports ${gate} as ${expected[gate]}`,
    gates[gate] === expected[gate],
    `reported=${String(gates[gate])}`,
  ]);
}

/**
 * What must hold for the identity of any run: it was named by the run namer before the architect, it
 * has a task id, its branch follows the convention `factory/<id>/<type>-<slug>`, the title and the id
 * reached the run record and the summary, and the record was completed rather than started twice.
 */
function namingChecks(traceDir: string): Array<[string, boolean, string?]> {
  const read = (file: string): Record<string, any> | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(traceDir, file), 'utf8')) as Record<string, any>;
    } catch {
      return null;
    }
  };
  const events = (() => {
    try {
      return fs
        .readFileSync(path.join(traceDir, 'events.ndjson'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, any>);
    } catch {
      return [];
    }
  })();
  const namer = read('00-run-namer.json');
  const meta = read('run.json');
  const summary = read('summary.json');
  const firstOf = (type: string) => events.findIndex((event) => event.type === type);
  const branch = String(meta?.branch ?? '');

  return [
    ['the run namer named the task', namer?.status === 'COMPLETED' && Boolean(namer?.data?.title), String(namer?.status)],
    ['the task has an id', /^f\d{4,}$/.test(String(meta?.taskId)), String(meta?.taskId)],
    [
      'the branch follows factory/<id>/<type>-<slug>',
      branch === `factory/${meta?.taskId}/${namer?.data?.type}-${namer?.data?.slug}`,
      branch,
    ],
    ['the title reached the run record', meta?.title === namer?.data?.title && meta?.titleSource === 'agent', `${meta?.title} (${meta?.titleSource})`],
    ['the summary carries the id and the title', summary?.taskId === meta?.taskId && summary?.title === meta?.title, `${summary?.taskId} ${summary?.title}`],
    [
      'the task was named before the architect planned',
      firstOf('run_naming') !== -1 &&
        firstOf('run_naming') < events.findIndex((event) => event.type === 'step_artifact' && event.step === 'pm-architect'),
      `naming@${firstOf('run_naming')}`,
    ],
    ['the run was started once, not twice', events.filter((event) => event.type === 'run_started').length === 1, String(events.filter((event) => event.type === 'run_started').length)],
  ];
}

const SCENARIOS: ScenarioExpectation[] = [
  {
    scenario: 'happy',
    description: 'plan -> develop -> QA pass -> review+security approve -> docs -> delivery',
    interactive: false,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 1,
    requiredArtifacts: [
      '00-run-namer.json',
      '01-pm-architect.json',
      '02-developer.json',
      '03-qa-tester.json',
      '05-code-review.json',
      '06-security.json',
      '07-documentation.json',
      '07-pr-writer.json',
      '08-pull-request.json',
      'summary.json',
    ],
    extraChecks: (dir) => [
      ...namingChecks(dir),
      ...gateChecks(dir, { qa: 'PASS', codeReview: 'APPROVED', security: 'PASS', documentation: 'COMPLETED' }),
    ],
  },
  {
    scenario: 'happy',
    description:
      'documentation switched OFF: the commit message and PR text are still written (PR writer is mandatory)',
    interactive: false,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 1,
    pipeline: { documentation: false },
    requiredArtifacts: ['07-documentation.json', '07-pr-writer.json', '08-pull-request.json', 'summary.json'],
    extraChecks: (dir) => [
      ...prTextChecks(dir, { documentation: 'SKIPPED', expectGates: ['Documentation: not run (disabled for this task)'] }),
      ...gateChecks(dir, { qa: 'PASS', codeReview: 'APPROVED', security: 'PASS', documentation: 'SKIPPED' }),
    ],
  },
  {
    scenario: 'happy',
    description:
      'every optional stage OFF: the PR text is still written, and says plainly that nothing ran',
    interactive: false,
    expect: 'DELIVERED_WITHOUT_PR',
    expectedAttempts: 1,
    pipeline: { qa: false, review: false, security: false, documentation: false },
    requiredArtifacts: ['07-pr-writer.json', '08-pull-request.json', 'summary.json'],
    extraChecks: (dir) => [
      ...prTextChecks(dir, {
        documentation: 'SKIPPED',
        expectGates: [
          'QA: not run (disabled for this task)',
          'Code review: not run (disabled for this task)',
          'Security audit: not run (disabled for this task)',
          'Documentation: not run (disabled for this task)',
        ],
      }),
      ...gateChecks(dir, { qa: 'SKIPPED', codeReview: 'SKIPPED', security: 'SKIPPED', documentation: 'SKIPPED' }),
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
      ...(expectation.pipeline ? { pipeline: expectation.pipeline } : {}),
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

  for (const [name, ok, detail] of expectation.extraChecks?.(traceDir) ?? []) {
    check(`${label} ${name}`, ok, detail ?? '');
  }

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

if (isolatedLogDir) {
  if (failed.length === 0) {
    fs.rmSync(isolatedLogDir, { recursive: true, force: true });
  } else {
    process.stdout.write(`\nTraces of this run were kept in ${isolatedLogDir}\n`);
  }
}

process.exit(failed.length === 0 ? 0 : 1);
