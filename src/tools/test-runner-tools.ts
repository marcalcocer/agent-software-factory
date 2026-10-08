/**
 * Build / test execution tools.
 *
 * Wraps repository commands (`mvn test`, `npm test`, `pytest`, ...) with:
 *   - stack auto-detection (so agents do not guess the build system),
 *   - an executable allow-list and no shell interpolation,
 *   - timeouts and bounded output capture,
 *   - best-effort parsing of totals and failure blocks for structured bug reports,
 *   - a local-only HTTP probe for API / E2E acceptance checks.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { getFactoryConfig, resolveRepoPath } from '../utils/factory-config.ts';
import { runCommandLine, summarizeResult, type CommandResult } from '../utils/shell.ts';
import type { ProjectStack } from '../utils/schemas.ts';

function repo(repoPath: string): string {
  return resolveRepoPath(repoPath, { requireGit: false });
}

/* -------------------------------------------------------------------------- */
/* Stack detection                                                             */
/* -------------------------------------------------------------------------- */

interface StackDefinition {
  type: string;
  language: string;
  markers: string[];
  build: (repoPath: string) => string | null;
  test: (repoPath: string) => string | null;
  lint: (repoPath: string) => string | null;
}

const exists = (repoPath: string, relative: string): boolean =>
  fs.existsSync(path.join(repoPath, relative));

function readJson(repoPath: string, relative: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoPath, relative), 'utf8'));
  } catch {
    return null;
  }
}

function npmScripts(repoPath: string): Record<string, string> {
  const manifest = readJson(repoPath, 'package.json');
  const scripts = manifest?.scripts;
  return scripts && typeof scripts === 'object' ? (scripts as Record<string, string>) : {};
}

function nodeRunner(repoPath: string): 'pnpm' | 'yarn' | 'npm' {
  if (exists(repoPath, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(repoPath, 'yarn.lock')) return 'yarn';
  return 'npm';
}

const STACKS: StackDefinition[] = [
  {
    type: 'maven',
    language: 'java',
    markers: ['pom.xml'],
    build: (repoPath) => (exists(repoPath, 'mvnw') ? './mvnw -B -q compile' : 'mvn -B -q compile'),
    test: (repoPath) => (exists(repoPath, 'mvnw') ? './mvnw -B test' : 'mvn -B test'),
    lint: () => null,
  },
  {
    type: 'gradle',
    language: 'java',
    markers: ['build.gradle', 'build.gradle.kts'],
    build: (repoPath) =>
      exists(repoPath, 'gradlew') ? './gradlew assemble' : 'gradle assemble',
    test: (repoPath) => (exists(repoPath, 'gradlew') ? './gradlew test' : 'gradle test'),
    lint: () => null,
  },
  {
    type: 'node',
    language: 'typescript/javascript',
    markers: ['package.json'],
    build: (repoPath) => {
      const scripts = npmScripts(repoPath);
      const runner = nodeRunner(repoPath);
      if (scripts.build) return `${runner} run build`;
      if (scripts.typecheck) return `${runner} run typecheck`;
      return null;
    },
    test: (repoPath) => {
      const scripts = npmScripts(repoPath);
      if (!scripts.test) return null;
      return `${nodeRunner(repoPath)} test`;
    },
    lint: (repoPath) => {
      const scripts = npmScripts(repoPath);
      return scripts.lint ? `${nodeRunner(repoPath)} run lint` : null;
    },
  },
  {
    type: 'python',
    language: 'python',
    markers: ['pyproject.toml', 'setup.py', 'requirements.txt', 'pytest.ini', 'tox.ini'],
    build: () => null,
    test: () => 'pytest -q',
    lint: (repoPath) =>
      exists(repoPath, 'ruff.toml') || exists(repoPath, 'pyproject.toml') ? 'ruff check .' : null,
  },
  {
    type: 'go',
    language: 'go',
    markers: ['go.mod'],
    build: () => 'go build ./...',
    test: () => 'go test ./...',
    lint: () => null,
  },
  {
    type: 'rust',
    language: 'rust',
    markers: ['Cargo.toml'],
    build: () => 'cargo build',
    test: () => 'cargo test',
    lint: () => 'cargo clippy',
  },
];

/** Detects build system, test command and lint command of a repository. */
export function detectProjectStack(repoPath: string): ProjectStack {
  for (const stack of STACKS) {
    const found = stack.markers.filter((marker) => exists(repoPath, marker));
    if (found.length === 0) continue;
    return {
      type: stack.type,
      language: stack.language,
      buildCommand: stack.build(repoPath),
      testCommand: stack.test(repoPath),
      lintCommand: stack.lint(repoPath),
      markers: found,
    };
  }
  return {
    type: 'unknown',
    language: 'unknown',
    buildCommand: null,
    testCommand: null,
    lintCommand: null,
    markers: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Output parsing                                                              */
/* -------------------------------------------------------------------------- */

export interface ParsedTestOutcome {
  tests: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  failureExcerpts: string[];
}

const FAILURE_LINE_PATTERN =
  /(FAILED|FAIL\b|ERROR\b|\[ERROR\]|AssertionError|Expected .* but|Tests run:.*Failures: [1-9]|✕|✗|panic:|FAILURES)/i;

/** Best-effort extraction of test totals and failure lines across common runners. */
export function parseTestOutput(output: string): ParsedTestOutcome {
  const result: ParsedTestOutcome = {
    tests: null,
    passed: null,
    failed: null,
    skipped: null,
    failureExcerpts: [],
  };

  // Maven Surefire: "Tests run: 12, Failures: 1, Errors: 0, Skipped: 2"
  const surefire = [...output.matchAll(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/g)].at(-1);
  if (surefire) {
    const [, total, failures, errors, skipped] = surefire.map(Number) as unknown as number[];
    result.tests = total ?? null;
    result.failed = (failures ?? 0) + (errors ?? 0);
    result.skipped = skipped ?? null;
    result.passed = (total ?? 0) - (result.failed ?? 0) - (skipped ?? 0);
  }

  // Jest / Vitest: "Tests  3 failed | 10 passed (13)"
  const vitest = output.match(/Tests\s+(?:(\d+)\s+failed\D+)?(\d+)\s+passed[^\d]*(?:\((\d+)\))?/);
  if (!surefire && vitest) {
    result.failed = vitest[1] ? Number(vitest[1]) : 0;
    result.passed = vitest[2] ? Number(vitest[2]) : null;
    result.tests = vitest[3] ? Number(vitest[3]) : (result.passed ?? 0) + (result.failed ?? 0);
  }

  // pytest: "5 failed, 12 passed, 1 skipped in 3.2s"
  const pytest = output.match(
    /(?:(\d+) failed)?(?:, )?(?:(\d+) passed)?(?:, )?(?:(\d+) skipped)?[^\n]* in \d+\.\d+s/,
  );
  if (!surefire && !vitest && pytest && (pytest[1] || pytest[2])) {
    result.failed = pytest[1] ? Number(pytest[1]) : 0;
    result.passed = pytest[2] ? Number(pytest[2]) : 0;
    result.skipped = pytest[3] ? Number(pytest[3]) : 0;
    result.tests = (result.failed ?? 0) + (result.passed ?? 0) + (result.skipped ?? 0);
  }

  // Go: count "--- FAIL" markers.
  if (result.tests === null) {
    const goFailures = [...output.matchAll(/^--- FAIL: (\S+)/gm)];
    if (goFailures.length > 0) result.failed = goFailures.length;
  }

  const lines = output.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!FAILURE_LINE_PATTERN.test(line)) continue;
    const excerpt = lines
      .slice(Math.max(0, index - 1), Math.min(lines.length, index + 6))
      .join('\n')
      .trim();
    if (excerpt !== '' && !result.failureExcerpts.includes(excerpt)) {
      result.failureExcerpts.push(excerpt);
    }
    if (result.failureExcerpts.length >= 12) break;
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Plain helpers (used by workflow steps)                                      */
/* -------------------------------------------------------------------------- */

export interface SuiteExecution {
  command: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  passed: boolean;
  stdoutTail: string;
  stderrTail: string;
  parsed: ParsedTestOutcome;
  summary: string;
}

function toSuiteExecution(commandLine: string, result: CommandResult): SuiteExecution {
  const combined = `${result.stdout}\n${result.stderr}`;
  return {
    command: commandLine,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    passed: result.ok,
    stdoutTail: result.stdout,
    stderrTail: result.stderr,
    parsed: parseTestOutput(combined),
    summary: summarizeResult(result),
  };
}

/** Runs a test/build command and returns a structured execution report. */
export async function runSuite(
  repoPath: string,
  commandLine: string,
  timeoutMs?: number,
): Promise<SuiteExecution> {
  const result = await runCommandLine(commandLine, {
    cwd: repoPath,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return toSuiteExecution(commandLine, result);
}

/* -------------------------------------------------------------------------- */
/* Agent-facing tools                                                          */
/* -------------------------------------------------------------------------- */

export const detectProjectStackTool = createTool({
  id: 'detect-project-stack',
  description:
    'Detect the build system of the target repository and the canonical build / test / lint ' +
    'commands (Maven, Gradle, npm/pnpm/yarn, Python, Go, Rust).',
  inputSchema: z.object({ repoPath: z.string() }),
  outputSchema: z.object({
    type: z.string(),
    language: z.string(),
    buildCommand: z.string().nullable(),
    testCommand: z.string().nullable(),
    lintCommand: z.string().nullable(),
    markers: z.array(z.string()),
    availableNpmScripts: z.array(z.string()),
  }),
  execute: async ({ repoPath }) => {
    const cwd = repo(repoPath);
    const stack = detectProjectStack(cwd);
    return { ...stack, availableNpmScripts: Object.keys(npmScripts(cwd)) };
  },
});

export const runCommandTool = createTool({
  id: 'run-command',
  description:
    'Execute one allow-listed command inside the target repository (build, test, lint, ' +
    'type-check) and capture stdout, stderr, exit code and duration. One command per call: ' +
    'shell operators (&&, ||, ;, |, >) are rejected.',
  inputSchema: z.object({
    repoPath: z.string(),
    command: z
      .string()
      .describe('Full command line, e.g. "./mvnw -B test -Dtest=InvoiceServiceTest".'),
    timeoutMs: z.number().int().positive().optional(),
  }),
  outputSchema: z.object({
    command: z.string(),
    exitCode: z.number().int(),
    ok: z.boolean(),
    timedOut: z.boolean(),
    durationMs: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  execute: async ({ repoPath, command, timeoutMs }) => {
    const result = await runCommandLine(command, {
      cwd: repo(repoPath),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return {
      command,
      exitCode: result.exitCode,
      ok: result.ok,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  },
});

export const runTestSuiteTool = createTool({
  id: 'run-test-suite',
  description:
    'Run the repository test suite (auto-detected when `command` is omitted) and return the ' +
    'exit code, parsed totals and the extracted failure excerpts.',
  inputSchema: z.object({
    repoPath: z.string(),
    command: z.string().optional().describe('Override the auto-detected test command.'),
    timeoutMs: z.number().int().positive().optional(),
  }),
  outputSchema: z.object({
    command: z.string(),
    passed: z.boolean(),
    exitCode: z.number().int(),
    durationMs: z.number().int(),
    timedOut: z.boolean(),
    totals: z.object({
      tests: z.number().int().nullable(),
      passed: z.number().int().nullable(),
      failed: z.number().int().nullable(),
      skipped: z.number().int().nullable(),
    }),
    failureExcerpts: z.array(z.string()),
    stdout: z.string(),
    stderr: z.string(),
  }),
  execute: async ({ repoPath, command, timeoutMs }) => {
    const cwd = repo(repoPath);
    const effectiveCommand = command ?? detectProjectStack(cwd).testCommand;
    if (!effectiveCommand) {
      throw new Error(
        'No test command could be detected for this repository. Pass `command` explicitly.',
      );
    }
    const execution = await runSuite(cwd, effectiveCommand, timeoutMs);
    return {
      command: execution.command,
      passed: execution.passed,
      exitCode: execution.exitCode,
      durationMs: execution.durationMs,
      timedOut: execution.timedOut,
      totals: {
        tests: execution.parsed.tests,
        passed: execution.parsed.passed,
        failed: execution.parsed.failed,
        skipped: execution.parsed.skipped,
      },
      failureExcerpts: execution.parsed.failureExcerpts,
      stdout: execution.stdoutTail,
      stderr: execution.stderrTail,
    };
  },
});

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

export const httpProbeTool = createTool({
  id: 'http-probe',
  description:
    'Perform an API / E2E validation request against a LOCAL endpoint (localhost only) and ' +
    'compare the response with the expected status. Use it for the acceptance checks declared ' +
    'in the execution plan.',
  inputSchema: z.object({
    url: z.string().describe('Full local URL, e.g. "http://localhost:8080/api/invoices/42".'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).default('GET'),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional().describe('Raw request body (JSON string when applicable).'),
    expectedStatus: z.number().int().optional(),
    timeoutMs: z.number().int().positive().max(120_000).default(15_000),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    status: z.number().int().nullable(),
    matchedExpectation: z.boolean().nullable(),
    durationMs: z.number().int(),
    responseBody: z.string(),
    error: z.string().nullable(),
  }),
  execute: async ({ url, method, headers, body, expectedStatus, timeoutMs }) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
    if (!LOCAL_HOSTS.has(parsed.hostname)) {
      throw new Error(
        `Only local endpoints are allowed for E2E probes (got "${parsed.hostname}"). ` +
          'The factory never calls external services.',
      );
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        ...(headers === undefined ? {} : { headers }),
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      });
      const text = (await response.text()).slice(0, getFactoryConfig().maxOutputChars);
      return {
        ok: response.ok,
        status: response.status,
        matchedExpectation: expectedStatus === undefined ? null : response.status === expectedStatus,
        durationMs: Date.now() - startedAt,
        responseBody: text,
        error: null,
      };
    } catch (error) {
      return {
        ok: false,
        status: null,
        matchedExpectation: expectedStatus === undefined ? null : false,
        durationMs: Date.now() - startedAt,
        responseBody: '',
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  },
});

export const testRunnerTools = {
  detectProjectStackTool,
  runCommandTool,
  runTestSuiteTool,
  httpProbeTool,
};
