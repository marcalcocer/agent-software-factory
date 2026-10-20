import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildPayload, polishChecksLabel, qaChecksLabel, runChecks, testPayload, toCheckResult } from '../src/tools/run-checks.ts';
import { readEvents } from '../src/tools/logger-tools.ts';
import type { RunContext } from '../src/utils/schemas.ts';

/** A real, tiny npm project: `npm test` and `npm run build` are real commands, run through the real allow-list. */
let dir: string;
let logs: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-checks-project-'));
  logs = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-checks-logs-'));
  vi.stubEnv('FACTORY_LOG_DIR', logs);
  vi.stubEnv('FACTORY_WORKSPACE_ROOT', os.tmpdir());
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(logs, { recursive: true, force: true });
});

const project = (scripts: Record<string, string>) =>
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tiny', version: '1.0.0', scripts }));

const runOf = (over: Partial<RunContext> = {}): RunContext =>
  ({
    runId: 'r1',
    repoPath: dir,
    dryRun: false,
    testCommand: 'npm test',
    stack: { cwd: '.', buildCommand: 'npm run build' },
    ...over,
  }) as RunContext;

describe('runChecks', () => {
  it('runs the tests and then the build, and writes what happened where QA always looked for it', async () => {
    project({ test: "node -e \"console.log('# tests 4'); console.log('# pass 4'); console.log('# fail 0')\"", build: "node -e \"console.log('built')\"" });

    const outcome = await runChecks(runOf(), qaChecksLabel(2));

    expect(outcome.test).toMatchObject({ exitCode: 0, command: 'npm test' });
    expect(outcome.build).toMatchObject({ exitCode: 0, command: 'npm run build' });
    expect(fs.readFileSync(path.join(logs, 'r1', 'context', 'qa-suite-attempt-2.log'), 'utf8')).toContain('# tests 4');
    expect(fs.existsSync(path.join(logs, 'r1', 'context', 'qa-build-attempt-2.log'))).toBe(true);
    expect(readEvents('r1').map((e) => [e.type, e.attempt])).toEqual([
      ['suite_executed', 2],
      ['build_executed', 2],
    ]);
  });

  it('names its files and events differently for the polish pass, so it never overwrites QA\'s', async () => {
    project({ test: "node -e \"process.exit(0)\"", build: "node -e \"process.exit(0)\"" });

    await runChecks(runOf(), polishChecksLabel);

    expect(fs.readdirSync(path.join(logs, 'r1', 'context')).sort()).toEqual(['polish-build.log', 'polish-suite.log']);
    expect(readEvents('r1')[0]).toMatchObject({ type: 'suite_executed', phase: 'polish' });
  });

  it('reports a failing test run with its real exit code, and still runs the build', async () => {
    project({ test: "node -e \"process.exit(3)\"", build: "node -e \"process.exit(0)\"" });

    const outcome = await runChecks(runOf(), polishChecksLabel);
    expect(outcome.test!.exitCode).toBe(3);
    expect(outcome.build!.exitCode).toBe(0);
    expect(toCheckResult(outcome)).toMatchObject({ testExit: 3, buildExit: 0 });
  });

  it('runs only what the repository has', async () => {
    project({ test: "node -e \"process.exit(0)\"" });

    const outcome = await runChecks(runOf({ stack: { cwd: '.', buildCommand: null } as RunContext['stack'] }), polishChecksLabel);
    expect(outcome.build).toBeNull();
    expect(toCheckResult(outcome).buildExit).toBeNull();
  });

  it('runs nothing in a dry run', async () => {
    expect(await runChecks(runOf({ dryRun: true }), polishChecksLabel)).toEqual({ test: null, build: null });
    expect(toCheckResult({ test: null, build: null })).toEqual({ testExit: null, buildExit: null, totals: null });
  });
});

describe('what QA is handed', () => {
  it('has the same shape it always had: totals with the tests, none with the build, tails kept to 8,000 characters', async () => {
    project({ test: "node -e \"console.log('x'.repeat(20000))\"", build: "node -e \"process.exit(0)\"" });
    const outcome = await runChecks(runOf(), qaChecksLabel(1));

    const test = JSON.parse(testPayload(outcome.test!));
    const build = JSON.parse(buildPayload(outcome.build!));
    expect(Object.keys(test)).toEqual(['command', 'exitCode', 'durationMs', 'timedOut', 'totals', 'stdoutTail', 'stderrTail']);
    expect(Object.keys(build)).toEqual(['command', 'exitCode', 'durationMs', 'timedOut', 'stdoutTail', 'stderrTail']);
    expect(test.stdoutTail.length).toBeLessThanOrEqual(8_000);
    expect(test.totals).toHaveProperty('failureExcerpts');
  });
});
