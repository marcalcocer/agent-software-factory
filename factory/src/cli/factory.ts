#!/usr/bin/env -S npx tsx
/**
 * Command line interface of the software factory.
 *
 *   npm run factory -- run --repo <name|path> --task "<requirement>"
 *   npm run factory -- resume --run-id <runId> --clarifications "<answers>"
 *   npm run factory -- resume --run-id <runId> --decision ACKNOWLEDGE --guidance "<answer>"
 *   npm run factory -- list [--limit 10]
 *   npm run factory -- show --run-id <runId>
 *   npm run factory -- doctor
 *
 * Flags are parsed before the Mastra instance is imported so that `--dry-run` and
 * `--non-interactive` can configure the runtime through the environment.
 */
import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';

type FlagValue = string | boolean;

interface ParsedArgs {
  command: string;
  flags: Record<string, FlagValue>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const withoutDashes = token.slice(2);
    if (withoutDashes.includes('=')) {
      const separator = withoutDashes.indexOf('=');
      flags[withoutDashes.slice(0, separator)] = withoutDashes.slice(separator + 1);
      continue;
    }
    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) {
      if (withoutDashes.startsWith('no-')) flags[withoutDashes.slice(3)] = false;
      else flags[withoutDashes] = true;
      continue;
    }
    flags[withoutDashes] = next;
    index += 1;
  }

  return { command, flags, positionals };
}

function asString(value: FlagValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function asBoolean(value: FlagValue | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function asInteger(value: FlagValue | undefined): number | undefined {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const HELP = `
agent-software-factory - multi-agent software factory powered by Mastra

Usage:
  npm run factory -- <command> [flags]

Commands:
  run         Execute the factory against a target repository
  resume      Resume a suspended run, or restart a failed one from its last step
  pr-feedback Triage human review comments on a pull request and route them back into the factory
  list        List recent runs and their status
  show        Print the summary.json of a run
  doctor      Check configuration, credentials and external tooling
  help        Show this help

run flags:
  --repo <name|path>        Target repository (folder inside the workspace root, or absolute)
  --task "<requirement>"    The requirement to implement (English)
  --base-branch <branch>    Branch to start from (default: current HEAD)
  --branch <branch>         Work branch name (default: factory/<slug>-<id>)
  --max-attempts <n>        Develop/QA/review iterations before escalation (default: 3)
  --test-command "<cmd>"    Override the auto-detected test command
  --criteria "<c1;c2>"      Extra acceptance criteria, separated by ';'
  --clarifications "<text>" Pre-answer the architect's questions / human guidance
  --no-commit               Do not commit the result
  --no-pr                   Do not open a draft pull request
  --non-interactive         Never suspend: escalations end the run (CI mode)
  --dry-run                 Execute the full graph with stubbed LLM calls (no cost, no writes)
  --scenario <name>         Dry-run scenario: happy | retry | infra | review-changes |
                            security-block | escalate | clarify

resume flags:
  --run-id <runId>          Run to resume or restart (required)
  --clarifications "<text>" Answers for a plan clarification request
  --decision <ABORT|ACKNOWLEDGE>  Decision for a human escalation
  --guidance "<text>"       Guidance recorded with the decision
  --approve-push <true|false>     Delivery gate: push the work branch to the remote
  --approve-pr <true|false>       Delivery gate: open the draft pull request after pushing

pr-feedback flags:
  --repo <name|path>        Target repository (required)
  --pr <number>             Pull-request number to triage (required)
  --post-replies            Post the drafted replies back to the pull request
  --include-resolved        Also triage comments in already-resolved threads
  --auto-rerun              Immediately start the follow-up run when code changes are needed
  --step <stepId>           Explicit step to re-enter (optional; failed runs restart
                            from their failed step automatically)

Examples:
  npm run factory -- run --repo invest-track --task "Add pagination to GET /api/positions"
  npm run factory -- run --repo ~/workspace/home-auth --task "Fix token refresh race" --max-attempts 4
  npm run factory -- run --repo invest-track --task "Smoke test the graph" --dry-run
  npm run factory -- resume --run-id 20251008-234512-invest-track-a1b2 --decision ACKNOWLEDGE
`;

/** Applies CLI flags that must be visible to the runtime configuration. */
function applyEnvironmentFlags(flags: Record<string, FlagValue>): void {
  if (asBoolean(flags['dry-run'])) process.env.FACTORY_DRY_RUN = 'true';
  if (asBoolean(flags['non-interactive'])) process.env.FACTORY_NON_INTERACTIVE = 'true';
  const scenario = asString(flags.scenario);
  if (scenario) process.env.FACTORY_DRY_RUN_SCENARIO = scenario;
  const logLevel = asString(flags['log-level']);
  if (logLevel) process.env.FACTORY_LOG_LEVEL = logLevel;
}

function printJson(label: string, value: unknown): void {
  process.stdout.write(`\n${label}\n${JSON.stringify(value, null, 2)}\n`);
}

function heading(text: string): void {
  process.stdout.write(`\n${'='.repeat(Math.min(78, text.length + 4))}\n  ${text}\n${'='.repeat(Math.min(78, text.length + 4))}\n`);
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

async function commandRun(flags: Record<string, FlagValue>): Promise<number> {
  const repo = asString(flags.repo);
  const task = asString(flags.task);

  if (!repo || !task) {
    process.stderr.write('Both --repo and --task are required.\n');
    process.stdout.write(HELP);
    return 2;
  }

  const { mastra } = await import('../mastra/index.ts');
  const { generateRunId } = await import('../tools/logger-tools.ts');
  const { getFactoryConfig, resolveRepoPath } = await import('../utils/factory-config.ts');
  const { checkProviderCredentials } = await import('../utils/model-router.ts');

  const config = getFactoryConfig();
  if (!config.dryRun) {
    const credentials = checkProviderCredentials();
    if (credentials.ready.length === 0) {
      process.stderr.write(
        [
          `No LLM provider credentials found.`,
          ``,
          `Either set an API key: ${credentials.missing.map((entry) => entry.envKey).join(', ')}`,
          ``,
          `Or run on your Claude Pro/Max subscription - no API key needed. Make sure the Claude`,
          `Code CLI is installed and logged in (claude login), then select the CLI backend:`,
          ``,
          `  FACTORY_PROVIDER=claude-cli npm run factory -- run ...`,
          ``,
          `Verify the session first with: FACTORY_PROVIDER=claude-cli npm run factory -- doctor --probe`,
          ``,
          `Or run with --dry-run to exercise the graph without any LLM call.`,
          ``,
        ].join('\n'),
      );
      return 2;
    }
    if (credentials.missing.length > 0) {
      process.stdout.write(
        `[warn] Missing credentials for: ${credentials.missing
          .map((entry) => `${entry.provider} (${entry.envKey})`)
          .join(', ')} - those fallbacks are unavailable.\n`,
      );
    }
  }

  const repoPath = resolveRepoPath(repo, { requireGit: !config.dryRun });
  const runId = generateRunId(path.basename(repoPath));
  const criteria = asString(flags.criteria);

  const inputData = {
    task,
    repo: repoPath,
    ...(asString(flags['base-branch']) ? { baseBranch: asString(flags['base-branch'])! } : {}),
    ...(asString(flags.branch) ? { branchName: asString(flags.branch)! } : {}),
    ...(asInteger(flags['max-attempts']) ? { maxAttempts: asInteger(flags['max-attempts'])! } : {}),
    ...(asString(flags['test-command']) ? { testCommand: asString(flags['test-command'])! } : {}),
    ...(criteria ? { acceptanceCriteria: criteria.split(';').map((entry) => entry.trim()).filter(Boolean) } : {}),
    ...(asString(flags.clarifications) ? { clarifications: asString(flags.clarifications)! } : {}),
    ...(asBoolean(flags.commit) === false ? { autoCommit: false } : {}),
    ...(asBoolean(flags.pr) === false ? { createPullRequest: false } : {}),
    ...(config.nonInteractive ? { interactive: false } : {}),
  };

  // Fail fast: if no test command is available and not in dry-run, error before spending agent calls
  if (!config.dryRun && !inputData.testCommand) {
    const { detectProjectStack } = await import('../tools/test-runner-tools.ts');
    const stack = detectProjectStack(repoPath);
    if (!stack.testCommand) {
      process.stderr.write(
        [
          `No runnable verification configured for this repository.`,
          ``,
          `The factory cannot detect a test command — repo root and immediate subdirectories`,
          `have no recognized manifest (package.json, pom.xml, build.gradle, go.mod, etc.)`,
          ``,
          `Stack detected: ${stack.type} in ${stack.cwd === '.' ? 'repo root' : stack.cwd + '/'}`,
          `Markers found: ${stack.markers.length > 0 ? stack.markers.join(', ') : '(none)'}`,
          ``,
          `Either:`,
          `  - Add a build manifest at the repo root or in a subproject directory`,
          `  - Pass --test-command "<command>" to run a specific test suite`,
          `  - Use --dry-run to exercise the graph without verification`,
          ``,
        ].join('\n'),
      );
      return 2;
    }
  }

  heading(`Factory run ${runId}`);
  printJson('Input', { ...inputData, dryRun: config.dryRun });

  const startedAt = new Date().toISOString();
  const workflow = mastra.getWorkflow('softwareFactoryWorkflow');
  const run = await workflow.createRun({ runId });

  let result: Awaited<ReturnType<typeof run.start>>;
  try {
    result = await run.start({ inputData });
  } catch (error) {
    await writeFailureSummary(runId, {
      task,
      repository: repoPath,
      startedAt,
      error,
      dryRun: config.dryRun,
    });
    heading(`Run ${runId} FAILED`);
    process.stderr.write(`${(error as Error)?.message ?? String(error)}\n`);
    return 1;
  }

  if (result.status === 'success') {
    heading(`Run ${runId}: ${result.result.status}`);
    printJson('Result', result.result);
    process.stdout.write(
      `\nTrace directory: ${result.result.traceDir}\nSummary: ${result.result.summaryPath}\n`,
    );
    return result.result.status === 'DELIVERED' || result.result.status === 'DELIVERED_WITHOUT_PR'
      ? 0
      : 1;
  }

  if (result.status === 'suspended') {
    heading(`Run ${runId} SUSPENDED - human input required`);
    printJson('Suspended steps', result.suspended);
    printJson('Suspend payload', result.suspendPayload);
    process.stdout.write(
      '\nResume with:\n' +
        `  npm run factory -- resume --run-id ${runId} --clarifications "<answers>"\n` +
        `  npm run factory -- resume --run-id ${runId} --decision ACKNOWLEDGE --guidance "<answer>"\n`,
    );
    return 3;
  }

  heading(`Run ${runId} FAILED`);
  if (result.status === 'failed') {
    await writeFailureSummary(runId, {
      task,
      repository: repoPath,
      startedAt,
      error: result.error,
      dryRun: config.dryRun,
    });
    process.stderr.write(`${result.error?.message ?? String(result.error)}\n`);
    if (result.error?.stack) process.stderr.write(`${result.error.stack}\n`);
  } else {
    printJson('Result', result);
  }
  return 1;
}

/**
 * Write a minimal `summary.json` for runs that fail before the workflow reaches
 * its finalize step (e.g. prepare-run rejects a dirty working tree). Without this
 * the run has no trace dir, so the CLI/studio cannot show *why* it failed.
 * Never overwrites an existing summary.
 */
async function writeFailureSummary(
  runId: string,
  meta: {
    task: string;
    repository: string;
    startedAt: string;
    error: unknown;
    dryRun: boolean;
  },
): Promise<void> {
  const { traceDirFor, writeSummary } = await import('../tools/logger-tools.ts');
  const summaryPath = path.join(traceDirFor(runId), 'summary.json');
  if (fs.existsSync(summaryPath)) return;

  const error = meta.error as { message?: string; stack?: string } | undefined;
  const finishedAt = new Date().toISOString();
  writeSummary(runId, {
    runId,
    status: 'FAILED',
    task: meta.task,
    repository: meta.repository,
    branch: null,
    startedAt: meta.startedAt,
    finishedAt,
    durationMs: new Date(finishedAt).getTime() - new Date(meta.startedAt).getTime(),
    attempts: 0,
    pullRequestUrl: null,
    error: error?.message ?? String(meta.error),
    errorStack: error?.stack ?? null,
    tokens: { total: 0, input: 0, output: 0 },
    agentCalls: 0,
    toolCalls: 0,
    modelsUsed: [],
    steps: [],
    artifacts: [],
    gates: { qa: null, codeReview: null, security: null, documentation: null },
    history: [],
    dryRun: meta.dryRun,
  });
}

/**
 * Find the deepest step that failed so a failed run can be restarted from it.
 * Nested workflow steps are keyed as `parent.child`, so the longest key is the
 * most specific (leaf) failure - the right place to re-enter the graph.
 */
function findResumeStep(state: unknown): string | undefined {
  const steps = (state as { steps?: Record<string, { status?: string }> } | null)?.steps ?? {};
  return Object.entries(steps)
    .filter(([, value]) => value?.status === 'failed')
    .map(([stepId]) => stepId)
    .sort((a, b) => b.split('.').length - a.split('.').length || b.localeCompare(a))[0];
}

function reportResumeResult(
  runId: string,
  result: {
    status: string;
    result?: { status?: string; traceDir?: string; summaryPath?: string };
    suspendPayload?: unknown;
  },
): number {
  if (result.status === 'success') {
    heading(`Run ${runId}: ${result.result?.status ?? 'COMPLETED'}`);
    printJson('Result', result.result);
    return 0;
  }
  if (result.status === 'suspended') {
    heading(`Run ${runId} SUSPENDED again - human input required`);
    printJson('Suspend payload', result.suspendPayload);
    return 3;
  }
  heading(`Run ${runId} FAILED`);
  printJson('Result', result);
  return 1;
}

async function commandResume(flags: Record<string, FlagValue>): Promise<number> {
  const runId = asString(flags['run-id']);
  if (!runId) {
    process.stderr.write('--run-id is required.\n');
    return 2;
  }

  const { mastra } = await import('../mastra/index.ts');
  const workflow = mastra.getWorkflow('softwareFactoryWorkflow');

  const state = await workflow.getWorkflowRunById(runId);
  if (!state) {
    process.stderr.write(
      `Run "${runId}" was not found in storage. Use \`npm run factory -- list\` to see known runs.\n`,
    );
    return 2;
  }

  const explicitStep = asString(flags.step);
  const run = await workflow.createRun({ runId });

  // A failed run is re-entered from the step that failed. Mastra's timeTravel re-runs
  // the graph from that step while reusing every persisted step result before it, so
  // the planner's work, earlier attempts and the git branch are all preserved.
  if (state.status === 'failed') {
    const resumeStep = explicitStep ?? findResumeStep(state);
    if (!resumeStep) {
      process.stderr.write(
        `Run "${runId}" failed but no failed step could be located. Pass --step <stepId> to pick one.\n`,
      );
      return 2;
    }
    heading(`Restarting failed run ${runId}`);
    process.stdout.write(`Re-entering the workflow at step "${resumeStep}".\n`);
    try {
      const result = await run.timeTravel({ step: resumeStep });
      return reportResumeResult(runId, result);
    } catch (error) {
      heading(`Run ${runId} FAILED`);
      process.stderr.write(`${(error as Error)?.message ?? String(error)}\n`);
      return 1;
    }
  }

  if (state.status !== 'suspended') {
    process.stderr.write(
      `Run "${runId}" cannot be resumed (status: ${state.status}). Only suspended or failed runs can be resumed.\n`,
    );
    return 2;
  }

  const clarifications = asString(flags.clarifications);
  const decision = asString(flags.decision)?.toUpperCase();
  const guidance = asString(flags.guidance);
  const approvePush = asString(flags['approve-push']);
  const approvePullRequest = asString(flags['approve-pr']);

  // Three distinct human-in-the-loop gates, each with its own resume payload.
  let resumeData: Record<string, unknown>;
  if (approvePush !== undefined || approvePullRequest !== undefined) {
    resumeData = {
      approvePush: approvePush !== 'false',
      approvePullRequest: approvePullRequest !== 'false',
    };
  } else if (clarifications) {
    resumeData = { clarifications };
  } else {
    resumeData = {
      decision: decision === 'ABORT' ? 'ABORT' : 'ACKNOWLEDGE',
      ...(guidance ? { guidance } : {}),
    };
  }

  heading(`Resuming run ${runId}`);
  printJson('Resume data', resumeData);
  // The gate has been answered: drop the request so the UI stops showing the input form.
  const { clearPendingInput } = await import('../tools/logger-tools.ts');
  clearPendingInput(runId);

  const result = await run.resume({
    resumeData: resumeData as never,
    ...(explicitStep ? { step: explicitStep } : {}),
  });

  return reportResumeResult(runId, result);
}

async function commandList(flags: Record<string, FlagValue>): Promise<number> {
  const { listRuns, traceDirFor } = await import('../tools/logger-tools.ts');
  const limit = asInteger(flags.limit) ?? 15;
  const runs = listRuns().slice(0, limit);

  if (runs.length === 0) {
    process.stdout.write('No runs found yet.\n');
    return 0;
  }

  heading(`Last ${runs.length} runs`);
  for (const runId of runs) {
    const summaryPath = path.join(traceDirFor(runId), 'summary.json');
    const runPath = path.join(traceDirFor(runId), 'run.json');
    let status = 'IN_PROGRESS / INCOMPLETE';
    let extra = '';
    try {
      if (fs.existsSync(summaryPath)) {
        const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
        status = summary.status;
        extra = `attempts=${summary.attempts} tokens=${summary.tokens?.total ?? 0} ${
          summary.pullRequestUrl ?? ''
        }`;
      } else if (fs.existsSync(runPath)) {
        const meta = JSON.parse(fs.readFileSync(runPath, 'utf8'));
        extra = `repo=${meta.repoName ?? '?'}`;
      }
    } catch {
      status = 'UNREADABLE';
    }
    process.stdout.write(`${runId}  ${status.padEnd(22)} ${extra}\n`);
  }
  return 0;
}

async function commandShow(flags: Record<string, FlagValue>): Promise<number> {
  const runId = asString(flags['run-id']);
  if (!runId) {
    process.stderr.write('--run-id is required.\n');
    return 2;
  }
  const { traceDirFor } = await import('../tools/logger-tools.ts');
  const traceDir = traceDirFor(runId);
  const summaryPath = path.join(traceDir, 'summary.json');

  if (!fs.existsSync(summaryPath)) {
    process.stderr.write(`No summary.json for run "${runId}". Trace directory: ${traceDir}\n`);
    if (fs.existsSync(traceDir)) {
      process.stdout.write(`Artifacts present:\n${fs.readdirSync(traceDir).join('\n')}\n`);
    }
    return 2;
  }
  heading(`Run ${runId}`);
  process.stdout.write(`${fs.readFileSync(summaryPath, 'utf8')}\n`);
  return 0;
}

async function commandDoctor(flags: Record<string, FlagValue>): Promise<number> {
  const { getFactoryConfig } = await import('../utils/factory-config.ts');
  const { AGENT_ROLES, checkProviderCredentials, describeModelChain } = await import(
    '../utils/model-router.ts'
  );
  const { hasExecutable } = await import('../utils/shell.ts');

  const config = getFactoryConfig();
  heading('Configuration');
  printJson('Factory config', {
    provider: config.provider,
    workspaceRoot: config.workspaceRoot,
    logDir: config.logDir,
    maxAttempts: config.maxAttempts,
    commandTimeoutMs: config.commandTimeoutMs,
    allowPush: config.allowPush,
    allowPullRequest: config.allowPullRequest,
    dryRun: config.dryRun,
    nonInteractive: config.nonInteractive,
    storageUrl: config.storageUrl,
    otlpEndpoint: config.otlpEndpoint ?? null,
  });

  heading('Model routing (primary -> fallbacks)');
  for (const role of AGENT_ROLES) {
    process.stdout.write(`  ${role.padEnd(16)} ${describeModelChain(role)}\n`);
  }

  heading('Provider credentials');
  const credentials = checkProviderCredentials();
  for (const provider of credentials.ready) process.stdout.write(`  [ok]      ${provider}\n`);
  for (const entry of credentials.missing) {
    process.stdout.write(`  [missing] ${entry.provider} (set ${entry.envKey})\n`);
  }

  let cliHealthy = true;
  if (config.provider === 'claude-cli') {
    const { checkClaudeCli, probeClaudeCliAuth } = await import('../utils/claude-cli.ts');
    heading('Claude Code CLI backend');
    const health = await checkClaudeCli(process.cwd());
    process.stdout.write(
      `  ${health.installed ? '[ok]     ' : '[missing]'} claude ${health.version ?? ''}\n`,
    );
    process.stdout.write(`  proxy (ANTHROPIC_BASE_URL): ${health.baseUrl ?? '(direct)'}\n`);
    if (health.error) process.stdout.write(`  error: ${health.error}\n`);
    cliHealthy = health.installed;

    if (health.installed && asBoolean(flags.probe) === true) {
      // Opt-in: costs a few tokens of the subscription window.
      const probe = await probeClaudeCliAuth(process.cwd());
      process.stdout.write(
        probe.ok
          ? `  [ok]      authenticated (served by ${probe.model})\n`
          : `  [fail]    ${probe.errorKind}: ${probe.error}\n`,
      );
      if (!probe.ok) cliHealthy = false;
    } else if (health.installed) {
      process.stdout.write('  (re-run with --probe to verify the OAuth session)\n');
    }
  }

  heading('External tooling');
  for (const executable of ['git', 'gh', 'node', 'npm', 'mvn', 'gradle', 'python3', 'go']) {
    const available = await hasExecutable(executable, process.cwd());
    process.stdout.write(`  ${available ? '[ok]     ' : '[absent] '} ${executable}\n`);
  }

  heading('Workspace');
  const workspaceExists = fs.existsSync(config.workspaceRoot);
  process.stdout.write(
    `  ${workspaceExists ? '[ok]     ' : '[missing]'} ${config.workspaceRoot}\n`,
  );
  if (workspaceExists) {
    const repositories = fs
      .readdirSync(config.workspaceRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(config.workspaceRoot, entry.name, '.git')))
      .map((entry) => entry.name);
    process.stdout.write(`  git repositories: ${repositories.join(', ') || '(none)'}\n`);
  }

  return (credentials.ready.length > 0 && cliHealthy) || config.dryRun ? 0 : 1;
}

/* -------------------------------------------------------------------------- */
/* pr-feedback                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Triages human review comments on a pull request the factory opened.
 *
 * Prints the routing decision and, when the feedback requires code changes, the requirement
 * for the follow-up run. Pass `--auto-rerun` to start that run immediately; otherwise the task
 * text is printed so a human (or a CI job) can decide.
 */
async function commandPrFeedback(flags: Record<string, FlagValue>): Promise<number> {
  const repo = asString(flags.repo);
  const prFlag = asString(flags.pr) ?? asString(flags['pull-request']);

  if (!repo || !prFlag) {
    process.stderr.write('Both --repo and --pr are required.\n\n');
    process.stdout.write(HELP);
    return 2;
  }

  const pullRequest = Number.parseInt(prFlag, 10);
  if (!Number.isInteger(pullRequest) || pullRequest <= 0) {
    process.stderr.write(`--pr must be a positive integer (got "${prFlag}").\n`);
    return 2;
  }

  const { mastra } = await import('../mastra/index.ts');
  const inputData = {
    repo,
    pullRequest,
    postReplies: flags['post-replies'] === true || asString(flags['post-replies']) === 'true',
    includeResolved: flags['include-resolved'] === true,
  };

  heading(`Pull-request feedback triage #${pullRequest}`);
  printJson('Input', inputData);

  const workflow = mastra.getWorkflow('prFeedbackWorkflow');
  const run = await workflow.createRun();
  const result = await run.start({ inputData });

  if (result.status !== 'success') {
    heading(`Feedback triage FAILED`);
    printJson('Result', result);
    return 1;
  }

  const output = result.result;
  heading(`Feedback triage: ${output.action}`);
  printJson('Result', output);

  if (output.blockers.length > 0) {
    process.stdout.write('\nBlockers requiring a human decision:\n');
    for (const blocker of output.blockers) process.stdout.write(`  - ${blocker}\n`);
  }

  if (output.followUpTask === '') {
    process.stdout.write('\nNo follow-up run needed.\n');
    return 0;
  }

  process.stdout.write(`\nFollow-up task:\n${output.followUpTask}\n`);

  if (flags['auto-rerun'] !== true) {
    process.stdout.write(
      `\nStart it with:\n  npm run factory -- run --repo ${repo} --task "<the task above>"\n`,
    );
    return 0;
  }

  // Chain straight into a normal factory run so CI can close the loop unattended.
  process.stdout.write('\n--auto-rerun: starting the follow-up factory run.\n');
  return await commandRun({ ...flags, task: output.followUpTask });
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  applyEnvironmentFlags(flags);

  switch (command) {
    case 'run':
      return await commandRun(flags);
    case 'resume':
      return await commandResume(flags);
    case 'pr-feedback':
      return await commandPrFeedback(flags);
    case 'list':
      return await commandList(flags);
    case 'show':
      return await commandShow(flags);
    case 'doctor':
      return await commandDoctor(flags);
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      process.stdout.write(HELP);
      return 2;
  }
}

const exitCode = await main().catch((error: unknown) => {
  process.stderr.write(`\n[factory] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  return 1;
});

process.exit(exitCode);
