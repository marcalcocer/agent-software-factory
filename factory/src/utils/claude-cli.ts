/**
 * Claude Code CLI execution backend.
 *
 * Lets the factory run on a **Claude Pro/Max subscription** instead of a metered API key, by
 * delegating every LLM call to the official `claude` binary in headless (`--print`) mode.
 *
 * This is deliberately *not* a hand-rolled Anthropic client: the request is executed by
 * Anthropic's own first-party CLI, with its own OAuth session and its own client identity.
 * The factory never touches the subscription token.
 *
 * Capabilities relied upon (all native CLI flags, verified against claude 2.1.x):
 *   --json-schema      native structured output, returned pre-parsed in `structured_output`
 *   --system-prompt    replaces the CLI's own system prompt with the agent's instructions
 *   --model            per-role routing (haiku for cheap roles, sonnet/opus for reasoning)
 *   --fallback-model   comma-separated failover when a model is overloaded
 *   --allowed-tools    tool scoping (the developer role gets file tools, nobody gets Bash)
 *   --add-dir          restricts those file tools to the target repository
 *   --max-budget-usd   hard spend ceiling per call
 *
 * Token discipline matters here because the subscription has a rolling usage window: replacing
 * the system prompt and excluding the CLI's dynamic sections cuts per-call context from
 * ~162k tokens to ~14k (measured), i.e. ~11x more factory runs per window.
 */
import { getFactoryConfig } from './factory-config.ts';
import { runProcess, type CommandResult } from './shell.ts';

/** Claude Code's built-in tools. Denied wholesale for pure-reasoning roles. */
const ALL_BUILTIN_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'TodoWrite',
  'SlashCommand',
  'ExitPlanMode',
] as const;

/**
 * Tool grants per policy.
 *
 * `Bash` is absent from every policy: the factory's shell-free invariant says agents never get
 * arbitrary command execution. Build and test commands run through the factory's own
 * allow-listed test-runner, not through the model.
 *
 * Inspection roles (QA, reviewer, security, architect, triage) genuinely need to read the
 * working tree - a reviewer that cannot open a file can only ever report BLOCKED.
 */
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;
const READ_WRITE_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep'] as const;

/** Mutating tools. Must be denied explicitly - see `MUTATION_TOOLS` note in `buildArgs`. */
const MUTATION_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;

/** Never granted to any role: no arbitrary execution, no network, no sub-agents. */
const ALWAYS_DENIED_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'WebFetch',
  'WebSearch',
  'Task',
] as const;

/** How much filesystem access a role gets from Claude Code's built-in tools. */
export type ClaudeCliToolPolicy = 'none' | 'read-only' | 'read-write';

export type ClaudeCliErrorKind =
  | 'not-installed'
  | 'auth'
  | 'rate-limit'
  | 'budget'
  | 'timeout'
  | 'api'
  | 'parse'
  | 'schema'
  | 'unknown';

export interface ClaudeCliRequest {
  /** Replaces the CLI's system prompt entirely (the agent's resolved instructions). */
  systemPrompt: string;
  /** User message, piped via stdin so large repo context cannot overflow argv. */
  prompt: string;
  /** JSON Schema enforced natively by the CLI. */
  jsonSchema?: Record<string, unknown>;
  /** Model alias (`haiku`, `sonnet`, `opus`) or full model id. */
  model: string;
  /** Tried in order when the primary model is overloaded/unavailable. */
  fallbackModels?: string[];
  /** Working directory for the call. */
  cwd: string;
  /** Filesystem access granted for this call, scoped to `cwd`. Defaults to `none`. */
  toolPolicy?: ClaudeCliToolPolicy;
  /**
   * Further directories the call may read, besides `cwd`. Honoured for `read-only` calls only: a
   * reviewer reads the complete patch of the change from the run's trace directory, which lies outside
   * the repository. Nothing here can be written - the mutating tools are denied for that policy.
   */
  readDirs?: string[];
  timeoutMs?: number;
  maxBudgetUsd?: number;
  /** Receives stdout as it arrives: the `stream-json` events of the call, for live activity. */
  onStdout?: (chunk: string) => void;
}

export interface ClaudeCliUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

export interface ClaudeCliResponse {
  ok: boolean;
  /** Pre-parsed object when `jsonSchema` was supplied. */
  structuredOutput: unknown;
  text: string;
  servedByModel: string;
  usage: ClaudeCliUsage;
  /** Derived from turn count: >1 turn means the model used tools. */
  toolCalls: number;
  durationMs: number;
  sessionId: string;
  /** Notional cost reported by the CLI. Subscription calls are not billed. */
  costUsd: number;
  error?: string;
  errorKind?: ClaudeCliErrorKind;
}

/** Shape of the `--output-format json` envelope (only the fields the factory consumes). */
interface ClaudeCliEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  api_error_status?: number | string | null;
  terminal_reason?: string;
  permission_denials?: unknown[];
  modelUsage?: Record<string, unknown>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens_details?: { thinking_tokens?: number };
  };
}

const EMPTY_USAGE: ClaudeCliUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 0,
};

/**
 * Extracts the JSON envelope from stdout.
 *
 * The CLI occasionally prefixes diagnostics or ANSI noise, so the payload is located by the
 * first `{` rather than assuming stdout is pure JSON.
 */
function parseEnvelope(stdout: string): ClaudeCliEnvelope | null {
  // Try parsing as stream-json format (newline-delimited JSON events)
  const lines = stdout.trim().split('\n');
  if (lines.length > 1) {
    // Stream format: find the final "result" event which contains all metadata
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === 'result') {
          return event as ClaudeCliEnvelope;
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  // Fall back to single JSON envelope format (legacy --output-format=json)
  const start = stdout.indexOf('{');
  if (start === -1) return null;
  const candidate = stdout.slice(start);
  try {
    return JSON.parse(candidate) as ClaudeCliEnvelope;
  } catch {
    // Trailing output after the envelope: retry up to the last closing brace.
    const end = candidate.lastIndexOf('}');
    if (end <= 0) return null;
    try {
      return JSON.parse(candidate.slice(0, end + 1)) as ClaudeCliEnvelope;
    } catch {
      return null;
    }
  }
}

function normalizeUsage(envelope: ClaudeCliEnvelope): ClaudeCliUsage {
  const usage = envelope.usage ?? {};
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: usage.output_tokens_details?.thinking_tokens ?? 0,
    cachedTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    // Everything that counts against the subscription's rolling window.
    totalTokens: input + output + cacheRead + cacheCreation,
  };
}

/** Model that actually served the request, for fallback visibility in `summary.json`. */
function detectServingModel(envelope: ClaudeCliEnvelope): string {
  const models = Object.keys(envelope.modelUsage ?? {});
  return models.length > 0 ? models.join('+') : 'unknown';
}

/** Maps a failed call onto an actionable error kind + message. */
function classifyFailure(
  result: CommandResult,
  envelope: ClaudeCliEnvelope | null,
): { kind: ClaudeCliErrorKind; message: string } {
  if (result.exitCode === 127) {
    return {
      kind: 'not-installed',
      message:
        'The `claude` CLI was not found on PATH. Install Claude Code ' +
        '(https://docs.claude.com/en/docs/claude-code) or switch to FACTORY_PROVIDER=api.',
    };
  }
  if (result.timedOut) {
    return {
      kind: 'timeout',
      message: `Claude Code did not answer within the timeout. Raise FACTORY_CLAUDE_CLI_TIMEOUT_MS if the step is legitimately long.`,
    };
  }

  const text = `${envelope?.result ?? ''}\n${result.stderr}`.toLowerCase();
  const status = String(envelope?.api_error_status ?? '');

  if (text.includes('oauth') || text.includes('authenticate') || text.includes('unauthorized')) {
    return {
      kind: 'auth',
      message:
        'Claude Code is not authenticated (OAuth session expired). Run `claude login` and retry. ' +
        `CLI said: ${(envelope?.result ?? result.stderr).trim().slice(0, 300)}`,
    };
  }
  if (
    status === '429' ||
    text.includes('rate limit') ||
    text.includes('usage limit') ||
    text.includes('quota')
  ) {
    return {
      kind: 'rate-limit',
      message:
        'Claude subscription usage limit reached. The run can be resumed once the window resets: ' +
        `npm run factory -- resume --run-id <runId>. CLI said: ${(envelope?.result ?? '').trim().slice(0, 200)}`,
    };
  }
  if (text.includes('budget')) {
    return {
      kind: 'budget',
      message: `Per-call budget ceiling hit (FACTORY_CLAUDE_CLI_MAX_BUDGET_USD). CLI said: ${(envelope?.result ?? '').trim().slice(0, 200)}`,
    };
  }
  if (envelope === null) {
    return {
      kind: 'parse',
      message:
        `Could not parse the Claude Code JSON envelope (exit ${result.exitCode}). ` +
        `stdout head: ${result.stdout.slice(0, 300)} | stderr: ${result.stderr.slice(0, 300)}`,
    };
  }
  return {
    kind: 'api',
    message:
      `Claude Code returned an error (status ${status || 'n/a'}, reason ${envelope.terminal_reason ?? 'n/a'}): ` +
      `${(envelope.result ?? result.stderr).trim().slice(0, 400)}`,
  };
}

/** Builds the argv for a headless Claude Code invocation. Exported so the tool grants can be checked. */
export function buildClaudeCliArgs(request: ClaudeCliRequest): string[] {
  const args = [
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    // Each factory call is stateless; never pollute the user's resumable session history.
    '--no-session-persistence',
    // Drops the CLI's dynamic system-prompt sections (env/git/CLAUDE.md preamble): the single
    // biggest token saving, and it stops the CLI's own persona from biasing the agent.
    '--exclude-dynamic-system-prompt-sections',
    '--disable-slash-commands',
    '--system-prompt',
    request.systemPrompt,
    '--model',
    request.model,
  ];

  const fallbacks = (request.fallbackModels ?? []).filter(Boolean);
  if (fallbacks.length > 0) args.push('--fallback-model', fallbacks.join(','));

  if (request.jsonSchema) args.push('--json-schema', JSON.stringify(request.jsonSchema));

  const policy = request.toolPolicy ?? 'none';
  if (policy === 'none') {
    args.push('--disallowed-tools', ...ALL_BUILTIN_TOOLS);
  } else {
    // Scope the file tools to the target repository and pre-approve them so the headless call
    // never blocks on an interactive permission prompt.
    args.push('--add-dir', request.cwd, ...(policy === 'read-only' ? (request.readDirs ?? []) : []));
    args.push('--permission-mode', 'acceptEdits');
    args.push(
      '--allowed-tools',
      ...(policy === 'read-write' ? READ_WRITE_TOOLS : READ_ONLY_TOOLS),
    );
    // `--allowed-tools` only *pre-approves* tools; it does not restrict the set. Omitting a
    // tool therefore leaves it usable, and `--permission-mode acceptEdits` would silently
    // auto-approve it. Read-only roles must deny the mutating tools explicitly - verified by
    // a read-only role otherwise managing to create a file in the target repository.
    args.push(
      '--disallowed-tools',
      ...ALWAYS_DENIED_TOOLS,
      ...(policy === 'read-write' ? [] : MUTATION_TOOLS),
    );
  }

  const budget = request.maxBudgetUsd ?? getFactoryConfig().claudeCliMaxBudgetUsd;
  if (budget !== undefined && budget > 0) args.push('--max-budget-usd', String(budget));

  return args;
}

/**
 * Runs one headless Claude Code call.
 *
 * Never throws for model/CLI failures: the outcome is reported through `ok` / `errorKind` so
 * the caller can distinguish a retryable rate limit from a hard auth failure.
 */
export async function runClaudeCli(request: ClaudeCliRequest): Promise<ClaudeCliResponse> {
  const config = getFactoryConfig();
  const startedAt = Date.now();

  const env: Record<string, string | undefined> = {};
  // Optional caching/compression proxy (e.g. Headroom) in front of the Anthropic API.
  if (config.claudeCliBaseUrl) env.ANTHROPIC_BASE_URL = config.claudeCliBaseUrl;

  let result: CommandResult;
  try {
    result = await runProcess('claude', buildClaudeCliArgs(request), {
      cwd: request.cwd,
      stdin: request.prompt,
      // `claude` is an internal factory backend, like `git`: invoked with shell:false and a
      // fixed argv, so it bypasses the test-runner allow-list by design.
      trusted: true,
      timeoutMs: request.timeoutMs ?? config.claudeCliTimeoutMs,
      // The JSON envelope must never be truncated by the shared output cap.
      maxOutputChars: 32_000_000,
      env,
      // The live stream (`stream-json`): the caller turns it into activity (see `agent-activity.ts`).
      ...(request.onStdout ? { onStdout: request.onStdout } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      structuredOutput: undefined,
      text: '',
      servedByModel: 'unknown',
      usage: EMPTY_USAGE,
      toolCalls: 0,
      durationMs: Date.now() - startedAt,
      sessionId: '',
      costUsd: 0,
      error: error instanceof Error ? error.message : String(error),
      errorKind: 'unknown',
    };
  }

  const envelope = parseEnvelope(result.stdout);
  const durationMs = Date.now() - startedAt;

  if (!result.ok || envelope === null || envelope.is_error === true) {
    const { kind, message } = classifyFailure(result, envelope);
    return {
      ok: false,
      structuredOutput: undefined,
      text: envelope?.result ?? '',
      servedByModel: envelope ? detectServingModel(envelope) : 'unknown',
      usage: envelope ? normalizeUsage(envelope) : EMPTY_USAGE,
      toolCalls: Math.max(0, (envelope?.num_turns ?? 1) - 1),
      durationMs,
      sessionId: envelope?.session_id ?? '',
      costUsd: envelope?.total_cost_usd ?? 0,
      error: message,
      errorKind: kind,
    };
  }

  // With --json-schema the CLI returns the validated object in `structured_output`; `result`
  // holds the same payload as a string. Fall back to parsing it if the field is absent.
  let structuredOutput = envelope.structured_output;
  if (structuredOutput === undefined && request.jsonSchema && typeof envelope.result === 'string') {
    try {
      structuredOutput = JSON.parse(envelope.result);
    } catch {
      structuredOutput = undefined;
    }
  }

  return {
    ok: true,
    structuredOutput,
    text: envelope.result ?? '',
    servedByModel: detectServingModel(envelope),
    usage: normalizeUsage(envelope),
    toolCalls: Math.max(0, (envelope.num_turns ?? 1) - 1),
    durationMs,
    sessionId: envelope.session_id ?? '',
    costUsd: envelope.total_cost_usd ?? 0,
  };
}

export interface ClaudeCliHealth {
  installed: boolean;
  version: string | null;
  baseUrl: string | null;
  error?: string;
}

/** Cheap, LLM-free probe used by `factory doctor`. */
export async function checkClaudeCli(cwd: string): Promise<ClaudeCliHealth> {
  const config = getFactoryConfig();
  try {
    const result = await runProcess('claude', ['--version'], {
      cwd,
      trusted: true,
      timeoutMs: 30_000,
    });
    if (!result.ok) {
      return {
        installed: false,
        version: null,
        baseUrl: config.claudeCliBaseUrl ?? null,
        error: result.exitCode === 127 ? 'claude not found on PATH' : result.stderr.trim(),
      };
    }
    return {
      installed: true,
      version: result.stdout.trim().split('\n')[0] ?? null,
      baseUrl: config.claudeCliBaseUrl ?? null,
    };
  } catch (error) {
    return {
      installed: false,
      version: null,
      baseUrl: config.claudeCliBaseUrl ?? null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Minimal authenticated round-trip. Costs a handful of tokens; opt-in via `doctor --probe`. */
export async function probeClaudeCliAuth(cwd: string): Promise<{
  ok: boolean;
  model: string;
  error?: string;
  errorKind?: ClaudeCliErrorKind;
}> {
  const response = await runClaudeCli({
    systemPrompt: 'Reply with the single word OK. Nothing else.',
    prompt: 'ping',
    model: 'haiku',
    cwd,
    timeoutMs: 120_000,
  });
  return response.ok
    ? { ok: true, model: response.servedByModel }
    : {
        ok: false,
        model: response.servedByModel,
        ...(response.error === undefined ? {} : { error: response.error }),
        ...(response.errorKind === undefined ? {} : { errorKind: response.errorKind }),
      };
}
