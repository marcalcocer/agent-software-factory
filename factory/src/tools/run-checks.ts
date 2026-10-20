/**
 * Runs the repository's own tests and build, and records what happened.
 *
 * The factory runs these itself and hands the real exit codes and totals to the agents: cheaper and
 * more reliable than asking a model to remember to run them. QA does it before it judges, and the
 * polish pass does it again after its fixes - the same code, so "the checks passed" means one thing.
 */
import path from 'node:path';

import type { RunContext } from '../utils/schemas.ts';
import { appendEvent, writeContextBlock } from './logger-tools.ts';
import type { CheckResult } from './polish.ts';
import { runSuite, type SuiteExecution } from './test-runner-tools.ts';

export interface ChecksOutcome {
  test: SuiteExecution | null;
  build: SuiteExecution | null;
}

/** Names the log files and the events: `qa-suite-attempt-2.log` for QA, `polish-suite.log` for the polish. */
export interface ChecksLabel {
  /** `qa-<kind>-attempt-2.log` | `polish-<kind>.log` */
  file: (kind: 'suite' | 'build') => string;
  /** Extra fields on the `suite_executed` / `build_executed` events. */
  event: Record<string, unknown>;
}

export const qaChecksLabel = (attempt: number): ChecksLabel => ({
  file: (kind) => `qa-${kind}-attempt-${attempt}.log`,
  event: { attempt },
});

export const polishChecksLabel: ChecksLabel = {
  file: (kind) => `polish-${kind}.log`,
  event: { phase: 'polish' },
};

function record(run: RunContext, label: ChecksLabel, kind: 'suite' | 'build', execution: SuiteExecution): void {
  const logPath = writeContextBlock(
    run.runId,
    label.file(kind),
    `$ ${execution.command}\nexit=${execution.exitCode} duration=${execution.durationMs}ms\n\n` +
      `--- stdout ---\n${execution.stdoutTail}\n--- stderr ---\n${execution.stderrTail}\n`,
  );
  appendEvent(run.runId, {
    type: kind === 'suite' ? 'suite_executed' : 'build_executed',
    ...label.event,
    command: execution.command,
    exitCode: execution.exitCode,
    durationMs: execution.durationMs,
    log: path.basename(logPath),
  });
}

/**
 * Runs the test command and the build command of the run, if it has them. A dry run runs nothing.
 * The tests run first and the build after them, as QA always did.
 */
export async function runChecks(run: RunContext, label: ChecksLabel): Promise<ChecksOutcome> {
  const outcome: ChecksOutcome = { test: null, build: null };
  if (run.dryRun) return outcome;

  if (run.testCommand) {
    outcome.test = await runSuite(run.repoPath, run.testCommand, { cwd: run.stack.cwd });
    record(run, label, 'suite', outcome.test);
  }
  if (run.stack.buildCommand) {
    outcome.build = await runSuite(run.repoPath, run.stack.buildCommand, { cwd: run.stack.cwd });
    record(run, label, 'build', outcome.build);
  }
  return outcome;
}

/** What QA is handed for the test run: the real result, as JSON. */
export function testPayload(execution: SuiteExecution): string {
  return JSON.stringify(
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

/** What QA is handed for the build. */
export function buildPayload(execution: SuiteExecution): string {
  return JSON.stringify(
    {
      command: execution.command,
      exitCode: execution.exitCode,
      durationMs: execution.durationMs,
      timedOut: execution.timedOut,
      stdoutTail: execution.stdoutTail.slice(-8_000),
      stderrTail: execution.stderrTail.slice(-8_000),
    },
    null,
    2,
  );
}

/** The outcome as the polish judge reads it: exit codes and totals, `null` for what did not run. */
export function toCheckResult(outcome: ChecksOutcome): CheckResult {
  return {
    testExit: outcome.test ? outcome.test.exitCode : null,
    buildExit: outcome.build ? outcome.build.exitCode : null,
    totals: outcome.test
      ? {
          tests: outcome.test.parsed.tests,
          passed: outcome.test.parsed.passed,
          failed: outcome.test.parsed.failed,
          skipped: outcome.test.parsed.skipped,
        }
      : null,
  };
}
