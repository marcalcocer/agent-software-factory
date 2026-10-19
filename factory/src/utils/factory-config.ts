/**
 * Central runtime configuration for the software factory.
 *
 * Every value is derived from environment variables so the same build can run locally,
 * in CI or inside a container without code changes. Configuration is resolved lazily on
 * each call, which keeps it correct after `dotenv` loads the `.env` file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Absolute path of the agent-software-factory project itself. */
export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Executables the test runner / command tools are allowed to invoke. */
const DEFAULT_ALLOWED_COMMANDS = [
  // JVM
  'mvn',
  'mvnw',
  './mvnw',
  'gradle',
  'gradlew',
  './gradlew',
  'java',
  // Node
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'node',
  'tsc',
  'vitest',
  'jest',
  'eslint',
  // Python
  'python',
  'python3',
  'pytest',
  'ruff',
  'mypy',
  'poetry',
  'uv',
  // Others
  'go',
  'cargo',
  'dotnet',
  'make',
  'bash',
  'sh',
] as const;

/**
 * Execution backend for LLM calls.
 *
 * - `api`        : metered provider SDKs via Mastra model routing (needs ANTHROPIC/OPENAI keys).
 * - `claude-cli` : the official `claude` binary in headless mode, backed by a Claude
 *                  Pro/Max subscription instead of per-token billing.
 */
export type FactoryProvider = 'api' | 'claude-cli';

export interface FactoryConfig {
  /** Which backend executes LLM calls. */
  provider: FactoryProvider;
  /** Optional proxy in front of the Anthropic API for the CLI backend (e.g. Headroom). */
  claudeCliBaseUrl?: string;
  /** Timeout for a single headless Claude Code call. */
  claudeCliTimeoutMs: number;
  /** Hard per-call spend ceiling passed to `--max-budget-usd` (0/unset = no ceiling). */
  claudeCliMaxBudgetUsd?: number;
  /** Let the implementing agent use Claude Code's own file tools, scoped to the repo. */
  claudeCliFileTools: boolean;
  /** Root folder containing the target repositories. Hard boundary for every file operation. */
  workspaceRoot: string;
  /** Allow target repositories outside `workspaceRoot` (disabled by default). */
  allowAnyPath: boolean;
  /** Directory where run traces are written (`<logDir>/<runId>/`). */
  logDir: string;
  /** Logger level for the Mastra logger. */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Maximum develop -> QA -> review iterations before escalating to a human. */
  maxAttempts: number;
  /** Timeout applied to every build/test command execution. */
  commandTimeoutMs: number;
  /** Maximum number of characters of stdout/stderr kept per command execution. */
  maxOutputChars: number;
  /** `true` => stub every LLM call and skip all mutating operations. */
  dryRun: boolean;
  /** `true` => never suspend the workflow waiting for a human (CI mode). */
  nonInteractive: boolean;
  /** Allow `git push` in the pull-request step. */
  allowPush: boolean;
  /** Allow pull-request creation through the GitHub CLI. */
  allowPullRequest: boolean;
  /** Use the `repomix` CLI when available. */
  enableRepomix: boolean;
  /** Add Google Gemini as a last-resort fallback in every model chain. */
  enableGoogleFallback: boolean;
  /** Allow-list of executables for command execution tools. */
  allowedCommands: string[];
  /** LibSQL URL used for workflow snapshots (suspend/resume) and observability storage. */
  storageUrl: string;
  /** OTLP endpoint for OpenTelemetry trace export (optional). */
  otlpEndpoint?: string;
  /** Service name reported to the tracing backend. */
  serviceName: string;
}

/** Expands a leading `~` and resolves the path against the project root. */
export function expandPath(input: string, base: string = PROJECT_ROOT): string {
  const trimmed = input.trim();
  const expanded =
    trimmed === '~' || trimmed.startsWith('~/')
      ? path.join(os.homedir(), trimmed.slice(1))
      : trimmed;
  return path.resolve(base, expanded);
}

function envString(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function envBoolean(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function envInteger(key: string, fallback: number): number {
  const value = Number.parseInt(envString(key, ''), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Resolves the effective factory configuration from the environment. */
export function getFactoryConfig(): FactoryConfig {
  const extraCommands = envString('FACTORY_EXTRA_ALLOWED_COMMANDS', '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const logLevel = envString('FACTORY_LOG_LEVEL', 'info') as FactoryConfig['logLevel'];

  const provider: FactoryProvider =
    envString('FACTORY_PROVIDER', 'api').toLowerCase() === 'claude-cli' ? 'claude-cli' : 'api';
  // ANTHROPIC_BASE_URL is honoured so an existing proxy setup needs no factory-specific config.
  const claudeCliBaseUrl =
    envString('FACTORY_CLAUDE_CLI_BASE_URL', '') || envString('ANTHROPIC_BASE_URL', '');
  const maxBudget = Number.parseFloat(envString('FACTORY_CLAUDE_CLI_MAX_BUDGET_USD', ''));

  return {
    provider,
    ...(claudeCliBaseUrl === '' ? {} : { claudeCliBaseUrl }),
    claudeCliTimeoutMs: envInteger('FACTORY_CLAUDE_CLI_TIMEOUT_MS', 10 * 60 * 1000),
    ...(Number.isFinite(maxBudget) && maxBudget > 0 ? { claudeCliMaxBudgetUsd: maxBudget } : {}),
    claudeCliFileTools: envBoolean('FACTORY_CLAUDE_CLI_FILE_TOOLS', true),
    workspaceRoot: expandPath(envString('FACTORY_WORKSPACE_ROOT', path.join(os.homedir(), 'workspace'))),
    allowAnyPath: envBoolean('FACTORY_ALLOW_ANY_PATH', false),
    logDir: expandPath(envString('FACTORY_LOG_DIR', './logs')),
    logLevel: ['debug', 'info', 'warn', 'error'].includes(logLevel) ? logLevel : 'info',
    maxAttempts: envInteger('FACTORY_MAX_ATTEMPTS', 3),
    commandTimeoutMs: envInteger('FACTORY_COMMAND_TIMEOUT_MS', 15 * 60 * 1000),
    maxOutputChars: envInteger('FACTORY_MAX_OUTPUT_CHARS', 24_000),
    dryRun: envBoolean('FACTORY_DRY_RUN', false),
    nonInteractive: envBoolean('FACTORY_NON_INTERACTIVE', false),
    allowPush: envBoolean('FACTORY_ALLOW_PUSH', true),
    allowPullRequest: envBoolean('FACTORY_ALLOW_PR', true),
    enableRepomix: envBoolean('FACTORY_ENABLE_REPOMIX', true),
    enableGoogleFallback: envBoolean('FACTORY_ENABLE_GOOGLE_FALLBACK', false),
    allowedCommands: [...DEFAULT_ALLOWED_COMMANDS, ...extraCommands],
    storageUrl: envString('FACTORY_STORAGE_URL', 'file:./logs/factory.db'),
    otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || undefined,
    serviceName: envString('OTEL_SERVICE_NAME', 'agent-software-factory'),
  };
}

/** Thrown when a path escapes the configured workspace boundary. */
export class WorkspaceBoundaryError extends Error {
  constructor(requested: string, workspaceRoot: string) {
    super(
      `Path "${requested}" is outside the factory workspace "${workspaceRoot}". ` +
        'Move the repository inside the workspace or set FACTORY_ALLOW_ANY_PATH=true.',
    );
    this.name = 'WorkspaceBoundaryError';
  }
}

/** `true` when `candidate` is `parent` itself or lives inside it. */
export function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export interface ResolveRepoOptions {
  /** Require the folder to be a git repository (default: `true`). */
  requireGit?: boolean;
}

/**
 * Resolves a user-supplied repository reference into a validated absolute path.
 *
 * Accepts a bare repository name (`invest-track`), a `~`-prefixed path or an absolute path,
 * and enforces the workspace boundary so no agent can operate outside `FACTORY_WORKSPACE_ROOT`.
 */
export function resolveRepoPath(repoRef: string, options: ResolveRepoOptions = {}): string {
  const { requireGit = true } = options;
  const config = getFactoryConfig();
  const reference = repoRef.trim();

  if (reference === '') {
    throw new Error('A target repository reference is required (name or absolute path).');
  }

  const looksLikePath =
    path.isAbsolute(reference) || reference.startsWith('~') || reference.startsWith('.');
  const resolved = looksLikePath
    ? expandPath(reference, process.cwd())
    : path.join(config.workspaceRoot, reference);

  if (!config.allowAnyPath && !isInside(config.workspaceRoot, resolved)) {
    throw new WorkspaceBoundaryError(resolved, config.workspaceRoot);
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Target repository not found: ${resolved}`);
  }
  if (requireGit && !fs.existsSync(path.join(resolved, '.git'))) {
    throw new Error(
      `Target repository "${resolved}" is not a git repository (no .git directory found).`,
    );
  }
  return resolved;
}

/**
 * Resolves a repository-relative path and guarantees it stays inside the repository.
 * Used by every file and command tool to contain agent actions.
 */
export function resolveInsideRepo(repoPath: string, relativePath: string): string {
  const repoRoot = path.resolve(repoPath);
  const target = path.resolve(repoRoot, relativePath);
  if (!isInside(repoRoot, target)) {
    throw new Error(
      `Path "${relativePath}" escapes the target repository "${repoRoot}" and was rejected.`,
    );
  }
  if (isInside(path.join(repoRoot, '.git'), target)) {
    throw new Error('Direct access to the .git directory is not allowed.');
  }
  return target;
}
