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

import { asBoolean, asInteger, asString, errorMessageOf, printMarker, type FlagValue } from './flags.ts';
import { commandInitiativeEdit, commandInitiativeList, commandPhaseReconcile } from './initiatives.ts';
import { parsePipelineFlags } from './pipeline-flags.ts';
import { parseDeliveryEditsJson } from '../utils/delivery-edits.ts';
import { followUpRunFlags } from './pr-feedback-followup.ts';
import {
  composeRevision,
  findLatestTriage,
  isRevisionAction,
  lookupPullRequest,
  readRunMeta,
  readTriageSummary,
} from './revision.ts';
import { pullRequestKey } from '../tools/pr-registry.ts';
import { revisionSchema } from '../utils/schemas.ts';
import {
  continueIfStuck,
  continuationStep,
  isStuckSuspended,
  type StepResults,
  type WorkflowResultLike,
} from './run-recovery.ts';

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


const HELP = `
agent-software-factory - multi-agent software factory powered by Mastra

Usage:
  npm run factory -- <command> [flags]

Commands:
  run         Execute the factory against a target repository
  resume      Resume a suspended run, or restart a failed one from its last step
  pr-feedback Triage human review comments on a pull request and route them back into the factory
  pr-check    List the pull requests the factory opened that have unhandled review comments
  revise      Address a pull request's review comments as a further round of the original run
  pr-dismiss  Set review comments aside so they are never acted on
  pr-reply    Post the replies a triage drafted for questions and notes
  pr-merge-draft  Write the commit message a squash merge of a pull request would have
  pr-merge    Squash-merge a pull request the human approved, then tidy up
  initiative-list  List the projects of a repository: phases, what can start, the backlog
  initiative-edit  Rename, reword, skip or add phases of a project; set backlog items aside
  phase-reconcile  After a phase is merged, compare what it delivered with the phases still to come
  list        List recent runs and their status
  show        Print the summary.json of a run
  doctor      Check configuration, credentials and external tooling
  help        Show this help

run flags:
  --repo <name|path>        Target repository (folder inside the workspace root, or absolute)
  --task "<requirement>"    The requirement to implement (English)
  --phase <phaseId>         Run one phase of a roadmap (see initiative-list) instead of a task: the
                            phase is the request, and --repo may be left out. A --task given with it
                            is added as the user's notes for this run. Refused while the phase it
                            builds on is not merged.
  --phasing <auto|on|off>   Whether the architect may split a big request into phases (default: auto -
                            only when it is too big for one reviewable pull request)
  --base-branch <branch>    Branch to start from (default: the checked-out branch - or the
                            repository's default branch when that one is a branch the factory
                            made for an earlier task, so tasks never stack on each other)
  --branch <branch>         Work branch name (default: factory/<slug>-<id>)
  --max-attempts <n>        Develop/QA/review iterations before escalation (default: 3)
  --test-command "<cmd>"    Override the auto-detected test command
  --criteria "<c1;c2>"      Extra acceptance criteria, separated by ';'
  --clarifications "<text>" Pre-answer the architect's questions / human guidance
  --no-commit               Do not commit the result
  --no-pr                   Do not open a pull request
  --no-qa                   Skip the QA stage (no build / test run; also disables triage retries)
  --no-review               Skip the code review stage
  --no-polish               Skip the polish pass (the minor findings of the gates are only reported)
  --no-security             Skip the security audit stage
  --no-docs                 Skip the documentation stage (README / CHANGELOG / docs updates).
                            The commit message and pull-request text are written by the PR writer,
                            which always runs.
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
  --approve-pr <true|false>       Delivery gate: open the pull request after pushing
  --edits '<json>'                Delivery gate: the human's final choices, e.g.
                                  '{"pullRequestTitle":"...","pullRequestBody":"...",
                                    "commitMessage":"...","branchName":"..."}'

pr-feedback flags:
  --repo <name|path>        Target repository (required)
  --pr <number>             Pull-request number to triage (required)
  --post-replies            Post the drafted replies back to the pull request
  --include-resolved        Also triage comments in already-resolved threads
  --auto-rerun              Immediately start the follow-up run when code changes are needed
  --step <stepId>           Explicit step to re-enter (optional; failed runs restart
                            from their failed step automatically)

pr-merge-draft flags:
  --repo <name|path>        Target repository (required)
  --pr <number>             Pull request to describe (required)
                            Prints PR_MERGE_DRAFT_JSON {subject, body, source, ...}. Changes nothing.

pr-merge flags:
  --repo <name|path>        Target repository (required)
  --pr <number>             Pull request to merge (required)
  --head-sha <sha>          The commit the human approved (required): if the branch has moved
                            since, nothing is merged
  --subject=<text>          Subject of the squash commit (required)
  --body=<text>             Body of the squash commit
  --delete-branch <bool>    Delete the branch afterwards (default: true)
  --return-to-base <bool>   Switch the working copy back to the base branch (default: true)
  --dry-run                 Check everything, merge nothing
                            Prints PR_MERGE_JSON {merged, reason, notes, ...}.

initiative-list flags:
  --repo <name|path>        Target repository (required)
  --include-quick           Also the single-phase projects every plain task creates
  --include-archived        Also the ones set aside
                            Prints INITIATIVE_LIST_JSON {repoPath, initiatives}.

initiative-edit flags:
  --initiative <id>         The project (required)
  --patch '<json>'          What to change (required), e.g.
                            '{"phases":[{"id":"i0001-p2","status":"SKIPPED"}],"addPhases":[{"title":"..."}]}'
                            Prints INITIATIVE_EDIT_JSON {initiative}, or {error} when nothing changed.

phase-reconcile flags:
  --phase <phaseId>         The merged phase (required)
  --force                   Compare again even if it was done already
                            Prints PHASE_RECONCILE_JSON {report}; report is null when there was nothing to do.

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
  let repo = asString(flags.repo);
  let task = asString(flags.task);
  const phaseFlag = asString(flags.phase);

  if (!phaseFlag && (!repo || !task)) {
    process.stderr.write('Both --repo and --task are required (or --phase <phaseId> to run a phase of a roadmap).\n');
    process.stdout.write(HELP);
    return 2;
  }

  const phasing = asString(flags.phasing);
  if (phasing !== undefined && !['auto', 'on', 'off'].includes(phasing)) {
    process.stderr.write('--phasing must be auto, on or off.\n');
    return 2;
  }

  // A run of one phase of a roadmap: the phase is the request, and the roadmap's repository the repo.
  let phase: { initiativeId: string; phaseId: string } | undefined;
  let phaseTitle: string | undefined;
  if (phaseFlag) {
    const { resolveRepoPath: resolveFlagRepo } = await import('../utils/factory-config.ts');
    const { resolvePhaseRequest } = await import('../initiatives/link.ts');
    const request = await resolvePhaseRequest({
      phaseId: phaseFlag,
      ...(repo ? { repoPath: resolveFlagRepo(repo, { requireGit: false }) } : {}),
      ...(task ? { extra: task } : {}),
    });
    if (!request.ok) {
      process.stderr.write(`${request.error}\n`);
      return 2;
    }
    repo = request.repoPath;
    task = request.task;
    phase = request.phase;
    phaseTitle = request.title;
  }
  if (!repo || !task) return 2;

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
  const explicitPipeline = parsePipelineFlags(flags);

  // A further round on an existing pull request (see `revise`). Validated here, at the edge:
  // a malformed revision must stop the run before it touches the repository.
  let revision: ReturnType<typeof revisionSchema.parse> | undefined;
  const revisionFlag = asString(flags.revision);
  if (revisionFlag) {
    const parsed = revisionSchema.safeParse(safeJson(revisionFlag));
    if (!parsed.success) {
      process.stderr.write(`--revision is not a valid revision: ${parsed.error.issues[0]?.message ?? 'unreadable JSON'}\n`);
      return 2;
    }
    revision = parsed.data;
  }
  // A round keeps the stage selection of the run it continues, unless one was given explicitly.
  const pipeline =
    explicitPipeline ?? (revision ? inheritedPipeline(revision.parentRunId) : undefined);

  const inputData = {
    task,
    repo: repoPath,
    ...(asString(flags['base-branch']) || revision
      ? { baseBranch: asString(flags['base-branch']) ?? revision!.pullRequest.baseBranch }
      : {}),
    // A round continues on the pull request's own branch, so the new commit updates that PR.
    ...(asString(flags.branch) || revision
      ? { branchName: asString(flags.branch) ?? revision!.pullRequest.headBranch }
      : {}),
    ...(asInteger(flags['max-attempts']) ? { maxAttempts: asInteger(flags['max-attempts'])! } : {}),
    ...(asString(flags['test-command']) ? { testCommand: asString(flags['test-command'])! } : {}),
    ...(criteria ? { acceptanceCriteria: criteria.split(';').map((entry) => entry.trim()).filter(Boolean) } : {}),
    ...(asString(flags.clarifications) ? { clarifications: asString(flags.clarifications)! } : {}),
    ...(phasing ? { phasing: phasing as 'auto' | 'on' | 'off' } : {}),
    ...(phase ? { phase } : {}),
    ...(asBoolean(flags.commit) === false ? { autoCommit: false } : {}),
    ...(asBoolean(flags.pr) === false ? { createPullRequest: false } : {}),
    ...(config.nonInteractive ? { interactive: false } : {}),
    // Only the stages the user switched off; the workflow keeps every other one enabled.
    ...(pipeline ? { pipeline } : {}),
    ...(revision ? { revision } : {}),
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

  const startedAt = new Date().toISOString();

  // Record the run NOW, before it is announced. Whoever is told its id - the Studio, or the watcher
  // that started a round by itself - must find the run. The first workflow step used to be the first
  // to write it, a second or two later: long enough for a round to be missing from the history until
  // the user switched repository and back. The workflow completes this record; it does not replace it.
  {
    const { createRunTrace } = await import('../tools/logger-tools.ts');
    const { fallbackRunName, roundTitle } = await import('../tools/run-naming.ts');
    const rootTitle = revision ? readRunMeta(revision.rootRunId)?.title : undefined;
    createRunTrace({
      runId,
      task,
      repoPath,
      repoName: path.basename(repoPath),
      kind: revision ? 'revision' : 'run',
      rootRunId: revision?.rootRunId ?? runId,
      round: revision?.round ?? 1,
      ...(revision
        ? {
            parentRunId: revision.parentRunId,
            pullRequest: {
              number: revision.pullRequest.number,
              url: revision.pullRequest.url,
              headBranch: revision.pullRequest.headBranch,
              baseBranch: revision.pullRequest.baseBranch,
            },
          }
        : {}),
      title: revision
        ? roundTitle(rootTitle ?? fallbackRunName(revision.originalTask).title, revision.round, revision.title)
        : (phaseTitle ?? fallbackRunName(task).title),
      titleSource: revision ? 'round' : phase ? 'phase' : 'fallback',
      ...(phase ? { initiativeId: phase.initiativeId, phaseId: phase.phaseId } : {}),
      dryRun: config.dryRun,
      startedAt,
    });
  }

  heading(`Factory run ${runId}`);
  printJson('Input', { ...inputData, dryRun: config.dryRun });

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
 * its finalize step (e.g. prepare-run rejects a dirty working tree, or the delivery step
 * fails after a human approved it). Without this the run has no record of *why* it failed.
 *
 * A real (non-failed) summary is never overwritten; a previous FAILED one is replaced so a
 * retry that fails again reports its own, current error.
 */
async function writeFailureSummary(
  runId: string,
  meta: {
    task: string;
    repository: string;
    startedAt: string;
    error: unknown;
    dryRun: boolean;
    branch?: string | null;
    failedStep?: string | null;
  },
): Promise<void> {
  const { traceDirFor, writeSummary } = await import('../tools/logger-tools.ts');
  const summaryPath = path.join(traceDirFor(runId), 'summary.json');
  if (fs.existsSync(summaryPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as { status?: string };
      if (existing.status !== 'FAILED') return;
    } catch {
      // Unreadable summary: replace it with an accurate one.
    }
  }

  const error = meta.error as { message?: string; stack?: string } | undefined;
  const finishedAt = new Date().toISOString();
  writeSummary(runId, {
    runId,
    status: 'FAILED',
    task: meta.task,
    repository: meta.repository,
    branch: meta.branch ?? null,
    failedStep: meta.failedStep ?? null,
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

/** Extracts the failure from a Mastra workflow result: the top-level error, else the failed step's. */
function describeFailure(result: { error?: unknown; steps?: StepResults }): {
  error: unknown;
  message: string;
  failedStep: string | null;
} {
  const steps = result.steps ?? {};
  const failedStep = findResumeStep({ steps }) ?? null;
  const stepError = failedStep ? steps[failedStep]?.error : undefined;
  const error = result.error ?? stepError ?? new Error('The run failed without reporting an error.');
  return { error, message: errorMessageOf(error), failedStep };
}

/**
 * Persists why a started / resumed run failed.
 *
 * `run` already did this for failures during the first execution, but the resume path only
 * dumped JSON to stdout: a step that failed *after* a human approved something (delivery, for
 * instance) left no summary, so the Studio could only say "interrupted or crashed".
 */
async function recordRunFailure(
  runId: string,
  error: unknown,
  failedStep: string | null,
): Promise<void> {
  const { traceDirFor, appendEvent } = await import('../tools/logger-tools.ts');

  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(traceDirFor(runId), 'run.json'), 'utf8'));
  } catch {
    // run.json is best effort: the failure itself is what matters.
  }

  await writeFailureSummary(runId, {
    task: String(meta.task ?? ''),
    repository: String(meta.repoPath ?? ''),
    startedAt: String(meta.startedAt ?? new Date().toISOString()),
    error,
    dryRun: Boolean(meta.dryRun),
    branch: typeof meta.branch === 'string' ? meta.branch : null,
    failedStep,
  });
  appendEvent(runId, { type: 'run_failed', step: failedStep, error: errorMessageOf(error) });
}

/** Drops a stale FAILED summary so a retry in progress is not shown as still failed. */
async function clearFailureSummary(runId: string): Promise<void> {
  const { traceDirFor } = await import('../tools/logger-tools.ts');
  const summaryPath = path.join(traceDirFor(runId), 'summary.json');
  try {
    const existing = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as { status?: string };
    if (existing.status === 'FAILED') fs.rmSync(summaryPath, { force: true });
  } catch {
    // No summary (or unreadable): nothing to clear.
  }
}

async function reportResumeResult(runId: string, result: WorkflowResultLike): Promise<number> {
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
  const failure = describeFailure(result);
  await recordRunFailure(runId, failure.error, failure.failedStep);
  if (failure.failedStep) process.stderr.write(`Failed step: ${failure.failedStep}\n`);
  process.stderr.write(`${failure.message}\n`);
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

  // A run an earlier retry left "suspended" with nothing suspended: its work is done but it was
  // never closed out. There is no gate to answer - just continue where it stopped.
  if (isStuckSuspended(state as Parameters<typeof isStuckSuspended>[0])) {
    const next = continuationStep(state as Parameters<typeof continuationStep>[0]);
    if (next) {
      heading(`Completing run ${runId}`);
      process.stdout.write(
        'Every step of this run finished, but it was never closed out.\n' +
          `Continuing at "${next}" - nothing that already ran is repeated.\n`,
      );
      await clearFailureSummary(runId);
      try {
        const result = await run.timeTravel({ step: next });
        return await reportResumeResult(runId, result as WorkflowResultLike);
      } catch (error) {
        heading(`Run ${runId} FAILED`);
        await recordRunFailure(runId, error, next);
        process.stderr.write(`${errorMessageOf(error)}\n`);
        return 1;
      }
    }
  }

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
    // The previous failure no longer describes the run while it is being retried.
    await clearFailureSummary(runId);
    try {
      const result = await run.timeTravel({ step: resumeStep });
      return await reportResumeResult(
        runId,
        await continueIfStuck(runId, workflow, result as WorkflowResultLike, (message) =>
          process.stdout.write(message),
        ),
      );
    } catch (error) {
      heading(`Run ${runId} FAILED`);
      await recordRunFailure(runId, error, resumeStep);
      process.stderr.write(`${errorMessageOf(error)}\n`);
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
      // Optional edits to the commit message / PR title and description / branch name.
      ...parseDeliveryEditsJson(asString(flags.edits)),
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

  try {
    const result = await run.resume({
      resumeData: resumeData as never,
      ...(explicitStep ? { step: explicitStep } : {}),
    });
    return await reportResumeResult(
      runId,
      await continueIfStuck(runId, workflow, result as WorkflowResultLike, (message) =>
          process.stdout.write(message),
        ),
    );
  } catch (error) {
    heading(`Run ${runId} FAILED`);
    await recordRunFailure(runId, error, null);
    process.stderr.write(`${errorMessageOf(error)}\n`);
    return 1;
  }
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
  const { resolveRepoPath } = await import('../utils/factory-config.ts');
  // What the factory already dealt with (answered, dismissed, fixed by a round) is not triaged again.
  const alreadyHandled = lookupPullRequest(resolveRepoPath(repo, { requireGit: false }), pullRequest)?.handledCommentIds ?? [];
  const requestedSkips = (asString(flags['skip-comments']) ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  const skipCommentIds = [...new Set([...alreadyHandled, ...requestedSkips])];

  const inputData = {
    repo,
    pullRequest,
    postReplies: flags['post-replies'] === true || asString(flags['post-replies']) === 'true',
    includeResolved: flags['include-resolved'] === true,
    ...(skipCommentIds.length > 0 ? { skipCommentIds } : {}),
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
      `\nStart it on the pull request's branch with:\n  npm run factory -- run --repo ${repo} --branch ${output.headBranch} --base-branch ${output.baseBranch} --task "<the task above>"\n`,
    );
    return 0;
  }

  // Chain straight into the follow-up so CI can close the loop unattended.
  if (lookupPullRequest(resolveRepoPath(repo, { requireGit: false }), pullRequest)) {
    // The factory opened this pull request: continue its task as a linked round.
    process.stdout.write(`\n--auto-rerun: starting the next round of pull request #${pullRequest}.\n`);
    return await commandRevise({ ...flags, pr: String(pullRequest), 'triage-run': output.runId });
  }
  // Not one of ours (no run to continue): still work on the PR's own branch so the PR updates.
  process.stdout.write(
    `\n--auto-rerun: starting the follow-up factory run on ${output.headBranch}.\n`,
  );
  return await commandRun(followUpRunFlags(flags, output));
}

/** JSON.parse that yields `undefined` instead of throwing. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The stages the previous round used, as the "only what is switched off" selection `run` expects. */
function inheritedPipeline(parentRunId: string): ReturnType<typeof parsePipelineFlags> {
  const stages = readRunMeta(parentRunId)?.pipeline;
  if (!stages) return undefined;
  const off = Object.fromEntries(Object.entries(stages).filter(([, enabled]) => enabled === false));
  return Object.keys(off).length > 0 ? (off as ReturnType<typeof parsePipelineFlags>) : undefined;
}

/* -------------------------------------------------------------------------- */
/* revise                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Starts a further round on a pull request the factory opened, from a triage of its review
 * comments: the same task, the same branch and (unless re-planning is called for) the same plan,
 * with the reviewer's words handed to the developer. It is linked to the run it continues.
 */
async function commandRevise(flags: Record<string, FlagValue>): Promise<number> {
  const repoFlag = asString(flags.repo);
  const prFlag = asString(flags.pr);
  if (!repoFlag || !prFlag) {
    process.stderr.write('Both --repo and --pr are required.\n');
    return 2;
  }
  const number = Number.parseInt(prFlag, 10);
  if (!Number.isInteger(number) || number <= 0) {
    process.stderr.write(`--pr must be a positive integer (got "${prFlag}").\n`);
    return 2;
  }

  const { resolveRepoPath } = await import('../utils/factory-config.ts');
  const repoPath = resolveRepoPath(repoFlag, { requireGit: false });

  const entry = lookupPullRequest(repoPath, number);
  if (!entry) {
    process.stderr.write(
      `Pull request #${number} is not one the factory opened (or is not registered yet). Run ` +
        '`pr-check` first, or use `run --branch ... --base-branch ...` for an arbitrary branch.\n',
    );
    return 2;
  }

  const triageRun = asString(flags['triage-run']);
  const triage = triageRun ? readTriageSummary(triageRun) : findLatestTriage(repoPath, number);
  if (!triage) {
    process.stderr.write(
      `No triage of pull request #${number} found. Triage the comments first: ` +
        `npm run factory -- pr-feedback --repo ${repoFlag} --pr ${number}\n`,
    );
    return 2;
  }

  const requested = asString(flags.action)?.toUpperCase();
  if (requested && !isRevisionAction(requested)) {
    process.stderr.write('--action must be RERUN_IMPLEMENTATION or RERUN_PLANNING.\n');
    return 2;
  }

  const composed = composeRevision({
    entry,
    triage,
    ...(requested && isRevisionAction(requested) ? { action: requested } : {}),
    replyOnGitHub: asBoolean(flags.reply) === true,
  });
  if (!composed.ok) {
    process.stderr.write(`${composed.reason}\n`);
    return 2;
  }

  // An edited task wins over the triage agent's draft.
  const task = asString(flags.task) ?? composed.task;
  heading(`Round ${composed.revision.round} of pull request #${number}`);
  process.stdout.write(
    `Continues run ${composed.revision.parentRunId} on ${entry.headBranch}; ` +
      `${composed.revision.comments.length} review comment(s) to address (${composed.revision.action}).\n`,
  );

  return await commandRun({
    ...flags,
    repo: repoPath,
    task,
    revision: JSON.stringify(composed.revision),
  });
}

/* -------------------------------------------------------------------------- */
/* pr-dismiss / pr-reply                                                       */
/* -------------------------------------------------------------------------- */

/** Sets review comments aside: they stop counting as pending and are never acted on. */
async function commandPrDismiss(flags: Record<string, FlagValue>): Promise<number> {
  const repoFlag = asString(flags.repo);
  const prFlag = asString(flags.pr);
  const ids = (asString(flags.comments) ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  if (!repoFlag || !prFlag || ids.length === 0) {
    process.stderr.write('--repo, --pr and --comments <id,id,...> are required.\n');
    return 2;
  }
  const { resolveRepoPath } = await import('../utils/factory-config.ts');
  const { markCommentsHandled } = await import('../tools/pr-registry.ts');
  const repoPath = resolveRepoPath(repoFlag, { requireGit: false });
  const number = Number.parseInt(prFlag, 10);
  if (!lookupPullRequest(repoPath, number)) {
    process.stderr.write(`Pull request #${number} is not registered; nothing to dismiss.\n`);
    return 2;
  }
  await markCommentsHandled(pullRequestKey(repoPath, number), ids);
  printMarker('PR_DISMISS_JSON', { dismissed: ids.length });
  return 0;
}

/** Posts the replies a triage drafted for questions and notes (never promises about unmade changes). */
async function commandPrReply(flags: Record<string, FlagValue>): Promise<number> {
  const repoFlag = asString(flags.repo);
  const prFlag = asString(flags.pr);
  if (!repoFlag || !prFlag) {
    process.stderr.write('Both --repo and --pr are required.\n');
    return 2;
  }
  const { resolveRepoPath } = await import('../utils/factory-config.ts');
  const { postTriageReplies } = await import('../tools/pr-reply.ts');
  const repoPath = resolveRepoPath(repoFlag, { requireGit: false });
  const number = Number.parseInt(prFlag, 10);

  const triageRun = asString(flags['triage-run']);
  const triage = triageRun ? readTriageSummary(triageRun) : findLatestTriage(repoPath, number);
  if (!triage) {
    process.stderr.write(`No triage of pull request #${number} found.\n`);
    return 2;
  }
  const handled = new Set(lookupPullRequest(repoPath, number)?.handledCommentIds ?? []);
  const result = await postTriageReplies(repoPath, number, triage.comments.filter((c) => !handled.has(c.id)));
  printMarker('PR_REPLY_JSON', result);
  if (result.failures.length > 0) process.stderr.write(`${result.failures.join('\n')}\n`);
  return result.failures.length > 0 && result.posted === 0 ? 1 : 0;
}

/* -------------------------------------------------------------------------- */
/* pr-check                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Reports the open factory pull requests that have review comments nobody has dealt with.
 *
 * Machine-readable by design: one `PR_CHECK_JSON {...}` line on stdout (the Studio runs this every
 * minute and looks for that marker, so stray log lines cannot break the parse).
 */
async function commandPrCheck(flags: Record<string, FlagValue>): Promise<number> {
  try {
    const { checkPullRequests } = await import('../tools/pr-watch.ts');
    const repo = asString(flags.repo);
    const result = await checkPullRequests(repo ? { repoPath: repo } : {});
    process.stdout.write(`PR_CHECK_JSON ${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`PR_CHECK_JSON ${JSON.stringify({ error: errorMessageOf(error) })}\n`);
    return 1;
  }
}

/* -------------------------------------------------------------------------- */
/* pr-merge-draft / pr-merge                                                   */
/* -------------------------------------------------------------------------- */

/** `--repo` and `--pr`, validated; prints the usage error itself. */
function repoAndPullRequest(flags: Record<string, FlagValue>): { repo: string; number: number } | null {
  const repo = asString(flags.repo);
  const number = Number.parseInt(asString(flags.pr) ?? '', 10);
  if (!repo || !Number.isInteger(number) || number <= 0) {
    process.stderr.write('Both --repo and --pr <positive number> are required.\n');
    return null;
  }
  return { repo, number };
}

/**
 * Writes the commit message a squash merge of the pull request would have. Changes nothing: it
 * reads the pull request and asks the merge-summary agent (or falls back to a plain message).
 * One `PR_MERGE_DRAFT_JSON {...}` line on stdout, for the Studio.
 */
async function commandPrMergeDraft(flags: Record<string, FlagValue>): Promise<number> {
  const target = repoAndPullRequest(flags);
  if (!target) return 2;
  try {
    const { resolveRepoPath } = await import('../utils/factory-config.ts');
    const { draftSquashMessage } = await import('../tools/pr-merge.ts');
    const draft = await draftSquashMessage({ repoPath: resolveRepoPath(target.repo, { requireGit: false }), number: target.number });
    printMarker('PR_MERGE_DRAFT_JSON', draft);
    return 0;
  } catch (error) {
    printMarker('PR_MERGE_DRAFT_JSON', { error: errorMessageOf(error) });
    return 1;
  }
}

/**
 * Squash-merges a pull request the human approved. `--head-sha` is the commit they approved: if the
 * branch has moved since, nothing is merged. One `PR_MERGE_JSON {...}` line on stdout.
 *
 * Exit codes: 0 merged (or a dry-run rehearsal), 1 not merged, 2 usage.
 */
async function commandPrMerge(flags: Record<string, FlagValue>): Promise<number> {
  const target = repoAndPullRequest(flags);
  if (!target) return 2;

  const headSha = asString(flags['head-sha']);
  const subject = asString(flags.subject);
  if (!headSha || !subject) {
    process.stderr.write('--head-sha (the approved commit) and --subject are required.\n');
    return 2;
  }

  try {
    const { resolveRepoPath } = await import('../utils/factory-config.ts');
    const { mergePullRequest } = await import('../tools/pr-merge.ts');
    const outcome = await mergePullRequest({
      repoPath: resolveRepoPath(target.repo, { requireGit: false }),
      number: target.number,
      expectedHeadSha: headSha,
      subject,
      body: typeof flags.body === 'string' ? flags.body : '',
      deleteBranch: asBoolean(flags['delete-branch']) ?? true,
      returnToBase: asBoolean(flags['return-to-base']) ?? true,
    });
    printMarker('PR_MERGE_JSON', outcome);
    return outcome.merged || outcome.dryRun ? 0 : 1;
  } catch (error) {
    printMarker('PR_MERGE_JSON', { merged: false, reason: errorMessageOf(error), notes: [] });
    return 1;
  }
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
    case 'pr-check':
      return await commandPrCheck(flags);
    case 'revise':
      return await commandRevise(flags);
    case 'pr-dismiss':
      return await commandPrDismiss(flags);
    case 'pr-reply':
      return await commandPrReply(flags);
    case 'pr-merge-draft':
      return await commandPrMergeDraft(flags);
    case 'pr-merge':
      return await commandPrMerge(flags);
    case 'initiative-list':
      return await commandInitiativeList(flags);
    case 'initiative-edit':
      return await commandInitiativeEdit(flags);
    case 'phase-reconcile':
      return await commandPhaseReconcile(flags);
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
