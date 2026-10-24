/**
 * Structured agent invocation.
 *
 * Every agent call in the factory goes through `invokeAgent`, which guarantees:
 *   - schema-validated structured output (no prompt-level JSON parsing),
 *   - per-run request context (repository, run id, attempt) for dynamic instructions,
 *   - token / tool-call / model telemetry appended to `logs/<runId>/events.ndjson`,
 *   - detection of which model actually served the request (fallback visibility),
 *   - a dry-run mode that replays canned results so the whole graph can be exercised
 *     without API keys or LLM cost.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import type { TracingContext } from '@mastra/core/observability';
import type { z } from 'zod';

import { z as zod } from 'zod';

import { appendEvent, traceDirFor, type ArtifactStep } from '../tools/logger-tools.ts';
import { getFactoryConfig } from './factory-config.ts';
import { REQUEST_CONTEXT_KEYS } from './context-loader.ts';
import {
  getClaudeCliChain,
  getClaudeCliEscalationModel,
  getFreeTierChain,
  getPrimaryModelId,
  type AgentRole,
} from './model-router.ts';
import { tryFreeChain } from './free-tier.ts';
import {
  buildRouting,
  classifyFailure,
  recordRouting,
  shortDetail,
  type ModelAttempt,
  type ModelRouting,
} from './model-routing.ts';
import { runClaudeCli, type ClaudeCliToolPolicy } from './claude-cli.ts';
import { ActivityRecorder, ClaudeStreamParser, describeToolUse, formatDuration } from './agent-activity.ts';
import { windowLabel } from './usage-limit.ts';

export interface InvokeAgentOptions<TSchema extends z.ZodType> {
  agent: Agent<any, any, any>;
  role: AgentRole;
  /** Trace step this call belongs to (drives artifact naming and metrics grouping). */
  step: ArtifactStep;
  runId: string;
  attempt?: number;
  repoPath: string;
  repoName?: string;
  /** The user message: task context + instructions for this specific call. */
  prompt: string;
  /** Output contract. The runtime validates the model response against it. */
  schema: TSchema;
  /** Tool-calling budget for agentic steps (developer/QA need many, reviewers few). */
  maxSteps?: number;
  /** Parent tracing span, propagated so agent spans nest under the workflow step. */
  tracingContext?: TracingContext;
  /** Result returned verbatim when `FACTORY_DRY_RUN=true`. */
  dryRunResult: z.infer<TSchema>;
  /** Gives up on one call after this long (CLI backend). Default: `FACTORY_CLAUDE_CLI_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * How many of the steps of the schema-repair ladder may be used (see `invokeViaClaudeCli`).
   * A call that must stay cheap uses 2: the role's own model, then the same model told what it broke -
   * never the pricier model the ladder ends with.
   */
  maxRungs?: number;
}

export interface InvokeAgentResult<TOutput> {
  object: TOutput;
  text: string;
  requestedModel: string;
  servedByModel: string;
  failedOver: boolean;
  /** Every model the call went through and why, so the step report can say what happened. */
  routing: ModelRouting;
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cachedTokens: number;
    totalTokens: number;
  };
  toolCalls: number;
  durationMs: number;
  dryRun: boolean;
}

interface RawUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
}

function normalizeUsage(usage: RawUsage | undefined): InvokeAgentResult<unknown>['usage'] {
  const input = usage?.inputTokens ?? usage?.promptTokens ?? 0;
  const output = usage?.outputTokens ?? usage?.completionTokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: usage?.reasoningTokens ?? 0,
    cachedTokens: usage?.cachedInputTokens ?? 0,
    totalTokens: usage?.totalTokens ?? input + output,
  };
}

/** `true` when the serving model is not the configured primary (a fallback answered). */
function detectFailover(requestedModel: string, servedByModel: string): boolean {
  if (servedByModel === 'unknown' || servedByModel === '') return false;
  const requestedName = requestedModel.split('/').pop() ?? requestedModel;
  return !servedByModel.includes(requestedName) && !requestedName.includes(servedByModel);
}

/** Builds the request context consumed by the agents' dynamic instructions. */
export function buildRequestContext(options: {
  repoPath: string;
  repoName?: string;
  runId: string;
  attempt?: number;
  role?: string;
}): RequestContext {
  const context = new RequestContext();
  context.setRaw(REQUEST_CONTEXT_KEYS.repoPath, options.repoPath);
  context.setRaw(REQUEST_CONTEXT_KEYS.repoName, options.repoName ?? '');
  context.setRaw(REQUEST_CONTEXT_KEYS.runId, options.runId);
  context.setRaw(REQUEST_CONTEXT_KEYS.attempt, options.attempt ?? 1);
  if (options.role) context.setRaw(REQUEST_CONTEXT_KEYS.role, options.role);
  return context;
}

/** Flattens Mastra's `AgentInstructions` (string | parts | messages) into a system prompt. */
function instructionsToText(instructions: unknown): string {
  if (typeof instructions === 'string') return instructions;
  if (Array.isArray(instructions)) {
    return instructions
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        const record = entry as { content?: unknown; text?: unknown };
        if (typeof record.text === 'string') return record.text;
        if (typeof record.content === 'string') return record.content;
        if (Array.isArray(record.content)) {
          return record.content
            .map((part) => (typeof part === 'string' ? part : ((part as { text?: string }).text ?? '')))
            .join('\n');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  if (instructions && typeof instructions === 'object') {
    const record = instructions as { content?: unknown; text?: unknown };
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }
  return String(instructions ?? '');
}

/**
 * The run's trace directory, when it exists: the complete patch and the raw suite logs under
 * `context/`, and the reports of every earlier step and attempt next to it. Read-only roles may read
 * it. The diff they are shown can be a condensed one and this is where the rest is, and the triage
 * agent compares attempts through the earlier reports - which its prompt says to do with a tool
 * (`read-run-artifacts`) that does not exist under this backend.
 */
function traceReadDirs(runId: string): string[] {
  const dir = traceDirFor(runId);
  return fs.existsSync(dir) ? [dir] : [];
}

/**
 * Hands the routing of a call to the step's report and, when a model other than the first choice answered,
 * writes the event that says why (`model_fallback`): the audit trail and the Studio read it.
 */
function publishRouting(
  options: { runId: string; role: AgentRole; step: ArtifactStep; attempt?: number },
  routing: ModelRouting,
): void {
  const attempt = options.attempt ?? 1;
  recordRouting(options.runId, options.step, attempt, routing);
  if (!routing.failedOver) return;
  appendEvent(options.runId, {
    type: 'model_fallback',
    role: options.role,
    step: options.step,
    attempt,
    from: routing.requested,
    to: routing.served,
    reason: routing.fallbackReason ?? '',
    attempts: routing.attempts,
  });
}

/** Converts a Zod schema to the JSON Schema consumed by `claude --json-schema`. */
function toJsonSchema(schema: z.ZodType): Record<string, unknown> | undefined {
  try {
    const jsonSchema = zod.toJSONSchema(schema, {
      target: 'draft-7',
      io: 'output',
      // Never throw on a construct JSON Schema cannot express; widen it instead.
      unrepresentable: 'any',
      cycles: 'ref',
      // Inline reused subschemas: a flat schema is more reliably honoured than $defs/$ref.
      reused: 'inline',
    }) as Record<string, unknown>;
    delete jsonSchema.$schema;
    return jsonSchema;
  } catch {
    // Fall back to prompt-level JSON (the agent prompts already state their output contract).
    return undefined;
  }
}

/**
 * Filesystem access granted to each role under the CLI backend.
 *
 * Inspection roles get read access because a verifier that cannot open a file has no evidence
 * and can only return BLOCKED. Only the two roles that are supposed to change the working tree
 * get write access.
 */
export const ROLE_TOOL_POLICY: Record<AgentRole, ClaudeCliToolPolicy> = {
  'pm-architect': 'read-only',
  developer: 'read-write',
  'qa-tester': 'read-only',
  triage: 'read-only',
  security: 'read-only',
  reviewer: 'read-only',
  // Claude Code's own tools cannot be narrowed to docs-only the way the factory's
  // documentation tool is; the gated delivery step and the reviewed diff remain the control.
  documentation: 'read-write',
  // Reads the PR diff and the repository to classify reviewer feedback; it routes work to
  // other agents rather than editing anything itself.
  'feedback-triage': 'read-only',
  // Judges only from the diff and descriptions in its prompt: nothing to look up, nothing to touch.
  'merge-summary': 'none',
  // Everything it needs (reports, the diff) is in its prompt; it writes text and touches nothing.
  'pr-writer': 'none',
  // Names a task from the words of the request alone.
  'run-namer': 'none',
  // Everything it needs (the roadmap, what each run delivered) is in its prompt.
  'phase-reconciler': 'none',
};

/**
 * Tells the agent exactly what it can and cannot do under this backend.
 *
 * Without this, agents draw the wrong conclusion from a missing capability: the developer
 * reported PARTIAL purely because it could not run the suite itself, and the QA agent returned
 * BLOCKED rather than judging the evidence it already had. Neither is a real failure - command
 * execution is deliberately withheld, and the factory runs the suite itself.
 */
export function executionEnvironmentNote(
  policy: ClaudeCliToolPolicy,
  role: AgentRole,
  repoPath: string,
  options: { traceDir?: string } = {},
): string {
  const lines = ['', '## Execution environment', ''];

  if (policy === 'read-write') {
    lines.push(`- You can read and modify files under \`${repoPath}\` (Read, Write, Edit, Glob, Grep).`);
  } else if (policy === 'read-only') {
    lines.push(`- You can read files under \`${repoPath}\` (Read, Glob, Grep). You cannot modify them.`);
  } else {
    lines.push('- You have no tools. Judge solely from the context provided in this prompt.');
  }

  lines.push(
    '- You have NO command execution: you cannot run builds, tests, linters or git.',
    '- The factory executes the test suite itself and supplies the real exit code and output.',
  );

  // The prompts are written for both backends and name the factory's own tools. This list is the truth
  // for this run: without it an agent looks for `run-test-suite` or `git-diff`, finds neither, and
  // reports itself blocked or unable to verify.
  lines.push(
    '- This list is authoritative. Your instructions may name tools that do not exist in this run: ' +
      '`read-file` is Read, `list-directory` and `repository-tree` are Glob, `search-repository` is Grep' +
      (policy === 'read-write' ? ', `write-file` and `edit-file` are Write and Edit' : '') +
      '. `git-diff`, `git-status`, `git-log`, `run-command`, `run-test-suite`, `http-probe`, ' +
      '`pack-repository` and `detect-project-stack` are not available: what they would have told you is in ' +
      'this request (the diff, the test and build results, the reports of the earlier steps).',
  );
  if (policy === 'read-only' && options.traceDir) {
    lines.push(
      `- The reports of every earlier step and attempt of this run are files you can read in \`${options.traceDir}\` ` +
        '(for example `03-qa-tester.attempt-2.json`); that replaces `read-run-artifacts`.',
    );
  }

  if (role === 'developer') {
    lines.push(
      '- Therefore: report COMPLETED once the code and its tests are written. Being unable to ' +
        'run the suite yourself is expected and is NOT a reason to report PARTIAL.',
    );
  } else if (role === 'qa-tester') {
    lines.push(
      '- Therefore: treat the supplied suite output and diff as primary evidence and reach a ' +
        'verdict from them. Reserve BLOCKED for genuinely missing evidence, not for the absence ' +
        'of a command-execution tool.',
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Executes a call through the Claude Code CLI backend.
 *
 * Structured output is enforced natively by the CLI, then re-validated with Zod so the rest of
 * the factory keeps its exact compile-time types. A single repair retry is attempted when the
 * payload is schema-valid JSON but violates a Zod refinement.
 */
async function invokeViaClaudeCli<TSchema extends z.ZodType>(
  options: InvokeAgentOptions<TSchema>,
  requestContext: RequestContext,
  requestedModel: string,
  startedAt: number,
  activity: ActivityRecorder,
): Promise<InvokeAgentResult<z.infer<TSchema>>> {
  const config = getFactoryConfig();
  const attempt = options.attempt ?? 1;
  const { model, fallbackModels } = getClaudeCliChain(options.role);
  const systemPrompt = instructionsToText(
    await options.agent.getInstructions({ requestContext }),
  );
  const jsonSchema = toJsonSchema(options.schema);

  // Tool access is per-role and always confined to the target repository.
  const toolPolicy: ClaudeCliToolPolicy = config.claudeCliFileTools
    ? ROLE_TOOL_POLICY[options.role]
    : 'none';

  const traceDir = traceReadDirs(options.runId)[0];
  const basePrompt =
    options.prompt +
    executionEnvironmentNote(toolPolicy, options.role, options.repoPath, traceDir ? { traceDir } : {});

  /*
   * Escalation ladder for a cheap-tier role:
   *   1. the role's own model
   *   2. the same model, told exactly which contract it broke
   *   3. the reasoning model, so one flaky small-model response cannot escalate the run
   *
   * A role already on the reasoning tier simply gets passes 1 and 2.
   */
  const escalationModel = getClaudeCliEscalationModel();
  const ladder: { model: string; repair: boolean }[] = [
    { model, repair: false },
    { model, repair: true },
    ...(model === escalationModel ? [] : [{ model: escalationModel, repair: true }]),
  ].slice(0, options.maxRungs ?? Number.POSITIVE_INFINITY);

  let lastError = '';

  // The free tier goes first, for the roles it is switched on for. Whatever it cannot answer falls through
  // to Claude below, and the attempts made here ride along so the step report shows the whole path.
  const attempts: ModelAttempt[] = [];
  const freeModels = getFreeTierChain(options.role);
  if (freeModels.length > 0) {
    const asked = new Map<string, number>();
    const free = await tryFreeChain(
      {
        role: options.role,
        models: freeModels,
        systemPrompt,
        prompt: basePrompt,
        schema: options.schema,
        requestContext,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        onProgress: (progress) => {
          if (progress.phase === 'asking') {
            asked.set(progress.model, Date.now());
            activity.emit('call-start', `Asking ${progress.model} (free tier)`, { model: progress.model, backend: 'free-tier' });
            return;
          }
          const { attempt: tried } = progress;
          const took = asked.has(tried.model) ? ` after ${formatDuration(Date.now() - asked.get(tried.model)!)}` : '';
          if (tried.outcome === 'served') return; // the answer itself is reported below, with its tokens
          activity.emit(
            'notice',
            `${tried.model}: ${tried.outcome}${took}${tried.detail ? ` (${tried.detail})` : ''}`,
            { model: tried.model, backend: 'free-tier' },
          );
        },
      },
      attempts,
    );
    if (free) {
      const durationMs = Date.now() - startedAt;
      activity.emit('call-end', `Answered by ${free.servedByModel} (free tier) in ${formatDuration(durationMs)}`, {
        model: free.servedByModel,
        backend: 'free-tier',
        durationMs,
        tokens: free.usage.totalTokens,
      });
      const routing = buildRouting(requestedModel, 'free-tier', attempts, { served: free.servedByModel });
      publishRouting(options, routing);
      appendEvent(options.runId, {
        type: 'agent_call',
        role: options.role,
        step: options.step,
        attempt,
        requestedModel,
        servedByModel: free.servedByModel,
        backend: 'free-tier',
        ...(routing.fallbackReason ? { fallbackReason: routing.fallbackReason } : {}),
        attempts,
        inputTokens: free.usage.inputTokens,
        outputTokens: free.usage.outputTokens,
        reasoningTokens: free.usage.reasoningTokens,
        cachedTokens: free.usage.cachedTokens,
        totalTokens: free.usage.totalTokens,
        toolCalls: 0,
        durationMs,
        failedOver: routing.failedOver,
        dryRun: false,
      });
      return {
        object: free.object as z.infer<TSchema>,
        text: free.text,
        requestedModel,
        servedByModel: free.servedByModel,
        failedOver: routing.failedOver,
        routing,
        usage: free.usage,
        toolCalls: 0,
        durationMs,
        dryRun: false,
      };
    }
    activity.emit('notice', 'No free-tier model could answer: handing the call to Claude');
  }

  for (const [index, rung] of ladder.entries()) {
    const isLast = index === ladder.length - 1;
    const prompt = rung.repair
      ? `${basePrompt}\n\n## Output correction required\n\n` +
        `Your previous response violated the output contract:\n${lastError}\n\n` +
        'Return the corrected JSON only.'
      : basePrompt;

    if (rung.repair) {
      activity.emit('notice', `The answer did not match the expected format (${shortDetail(lastError, 120)}): asking ${rung.model} again`);
    }
    activity.emit('call-start', `Asking Claude (${rung.model})`, { model: `claude-cli/${rung.model}`, backend: 'claude-cli' });
    const stream = new ClaudeStreamParser(activity);
    const rungStartedAt = Date.now();
    const response = await runClaudeCli({
      systemPrompt,
      prompt,
      ...(jsonSchema === undefined ? {} : { jsonSchema }),
      model: rung.model,
      fallbackModels,
      cwd: options.repoPath,
      toolPolicy,
      readDirs: traceReadDirs(options.runId),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      onStdout: (chunk) => stream.push(chunk),
    });
    stream.end();

    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      if (response.errorKind === 'rate-limit') {
        // The run will fail here; this is what lets the Studio retry it once the limit is back.
        const limit = response.usageLimit ?? { resetsAt: null };
        appendEvent(options.runId, {
          type: 'usage_limit',
          role: options.role,
          step: options.step,
          attempt,
          model: rung.model,
          resetsAt: limit.resetsAt,
          ...(limit.window ? { window: limit.window } : {}),
        });
      }
      activity.emit(
        'call-failed',
        response.errorKind === 'rate-limit'
          ? `Claude's ${windowLabel(response.usageLimit?.window)} limit is used up` +
              (response.usageLimit?.resetsAt ? `: it resets at ${new Date(response.usageLimit.resetsAt).toLocaleString()}` : '')
          : `Claude (${rung.model}) failed: ${shortDetail(response.error ?? response.errorKind ?? 'unknown error', 200)}`,
        {
          model: `claude-cli/${rung.model}`,
          backend: 'claude-cli',
          durationMs: Date.now() - rungStartedAt,
        },
      );
      appendEvent(options.runId, {
        type: 'agent_error',
        role: options.role,
        step: options.step,
        attempt,
        requestedModel,
        durationMs,
        error: `${response.errorKind}: ${response.error}`,
        ...(attempts.length > 0
          ? {
              attempts: [
                ...attempts,
                { model: `claude-cli/${rung.model}`, backend: 'claude-cli', outcome: classifyFailure(`${response.errorKind} ${response.error}`), detail: shortDetail(response.error ?? '') },
              ],
            }
          : {}),
      });
      throw new Error(
        `Agent "${options.role}" failed during step "${options.step}" ` +
          `[claude-cli/${response.errorKind}]: ${response.error}`,
      );
    }

    // The CLI validated against JSON Schema; Zod adds the refinements and exact types.
    const candidate =
      response.structuredOutput ?? (response.text === '' ? undefined : safeJson(response.text));
    const parsed = options.schema.safeParse(candidate);

    if (parsed.success) {
      activity.emit(
        'call-end',
        `Answered by ${response.servedByModel} in ${formatDuration(Date.now() - rungStartedAt)}` +
          (response.toolCalls > 0 ? ` · ${response.toolCalls} tool turns` : ''),
        {
          model: response.servedByModel,
          backend: 'claude-cli',
          durationMs: Date.now() - rungStartedAt,
          tokens: response.usage.totalTokens,
        },
      );
      // Either the schema ladder escalated to another model, or the CLI's own
      // `--fallback-model` answered: both are reported as a failover.
      const switchedModel = rung.model !== model || !response.servedByModel.includes(rung.model);
      attempts.push({ model: response.servedByModel, backend: 'claude-cli', outcome: 'served' });
      const failedOver = switchedModel || attempts.some((entry) => entry.backend === 'free-tier');
      const routing = buildRouting(requestedModel, 'claude-cli', attempts, {
        failedOver,
        served: response.servedByModel,
      });
      if (failedOver && !routing.fallbackReason) {
        routing.fallbackReason = `Claude Code switched from ${rung.model} to ${response.servedByModel} (usage limit or overload)`;
      }
      publishRouting(options, routing);

      appendEvent(options.runId, {
        type: 'agent_call',
        role: options.role,
        step: options.step,
        attempt,
        requestedModel,
        servedByModel: response.servedByModel,
        backend: 'claude-cli',
        ...(routing.fallbackReason ? { fallbackReason: routing.fallbackReason } : {}),
        ...(attempts.length > 1 ? { attempts } : {}),
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        reasoningTokens: response.usage.reasoningTokens,
        cachedTokens: response.usage.cachedTokens,
        totalTokens: response.usage.totalTokens,
        toolCalls: response.toolCalls,
        durationMs,
        failedOver,
        dryRun: false,
      });
      return {
        object: parsed.data as z.infer<TSchema>,
        text: response.text,
        requestedModel,
        servedByModel: response.servedByModel,
        failedOver,
        routing,
        usage: {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          reasoningTokens: response.usage.reasoningTokens,
          cachedTokens: response.usage.cachedTokens,
          totalTokens: response.usage.totalTokens,
        },
        toolCalls: response.toolCalls,
        durationMs,
        dryRun: false,
      };
    }

    lastError = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');

    attempts.push({ model: `claude-cli/${rung.model}`, backend: 'claude-cli', outcome: 'invalid', detail: shortDetail(lastError) });
    appendEvent(options.runId, {
      type: 'agent_schema_retry',
      role: options.role,
      step: options.step,
      attempt,
      rung: index + 1,
      model: rung.model,
      escalatesTo: isLast ? null : (ladder[index + 1]?.model ?? null),
      error: lastError,
    });
  }

  const durationMs = Date.now() - startedAt;
  activity.emit('call-failed', `No answer matched the expected format after ${ladder.length} tries: ${shortDetail(lastError, 200)}`, { durationMs });
  appendEvent(options.runId, {
    type: 'agent_error',
    role: options.role,
    step: options.step,
    attempt,
    requestedModel,
    durationMs,
    error: `schema validation failed on every model in the ladder: ${lastError}`,
  });
  throw new Error(
    `Agent "${options.role}" returned output violating its schema on all ` +
      `${ladder.length} attempts (${ladder.map((rung) => rung.model).join(' -> ')}) ` +
      `during step "${options.step}": ${lastError}`,
  );
}

function safeJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
}

/** Invokes an agent and returns its validated structured output plus call telemetry. */
export async function invokeAgent<TSchema extends z.ZodType>(
  options: InvokeAgentOptions<TSchema>,
): Promise<InvokeAgentResult<z.infer<TSchema>>> {
  const { dryRun } = getFactoryConfig();
  const attempt = options.attempt ?? 1;
  const requestedModel = getPrimaryModelId(options.role);
  const startedAt = Date.now();

  if (dryRun) {
    const durationMs = Date.now() - startedAt;
    appendEvent(options.runId, {
      type: 'agent_call',
      role: options.role,
      step: options.step,
      attempt,
      requestedModel,
      servedByModel: 'dry-run-stub',
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      toolCalls: 0,
      durationMs,
      failedOver: false,
      dryRun: true,
    });
    return {
      object: options.dryRunResult,
      text: '[dry-run]',
      requestedModel,
      servedByModel: 'dry-run-stub',
      failedOver: false,
      routing: { requested: requestedModel, served: 'dry-run-stub', backend: 'dry-run', failedOver: false, attempts: [] },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
      },
      toolCalls: 0,
      durationMs,
      dryRun: true,
    };
  }

  const requestContext = buildRequestContext({
    repoPath: options.repoPath,
    repoName: options.repoName,
    runId: options.runId,
    attempt,
    role: options.role,
  });

  process.stdout.write(`Agent "${options.role}" started on step "${options.step}"...\n`);
  // What the call does, live: `logs/<runId>/activity.ndjson`, read by the Studio (see `agent-activity.ts`).
  const activity = new ActivityRecorder({
    runId: options.runId,
    role: options.role,
    step: options.step,
    attempt,
    cwd: options.repoPath,
  });

  // Subscription-backed backend: delegate to the official Claude Code binary.
  if (getFactoryConfig().provider === 'claude-cli') {
    try {
      return await invokeViaClaudeCli(options, requestContext, requestedModel, startedAt, activity);
    } finally {
      activity.close();
    }
  }

  activity.emit('call-start', `Asking ${requestedModel}`, { model: requestedModel, backend: 'api' });
  try {
    // Mastra reports each finished step of the tool loop: the tool calls and any text in between.
    const onStepFinish = (step: { text?: string; toolCalls?: Array<{ toolName?: string; args?: unknown; input?: unknown; payload?: { toolName?: string; args?: unknown } }> }) => {
      try {
        for (const call of step.toolCalls ?? []) {
          const name = call.toolName ?? call.payload?.toolName ?? 'tool';
          activity.emit('tool', describeToolUse(name, call.args ?? call.input ?? call.payload?.args, options.repoPath), { tool: name });
        }
        if (typeof step.text === 'string' && step.text.trim()) activity.emit('text', step.text.trim());
      } catch {
        // Activity is a view; it never breaks the call.
      }
    };
    const response = await options.agent.generate(options.prompt, {
      structuredOutput: { schema: options.schema as never },
      requestContext,
      onStepFinish,
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      ...(options.tracingContext === undefined ? {} : { tracingContext: options.tracingContext }),
    } as never);

    const durationMs = Date.now() - startedAt;
    const usage = normalizeUsage(response.usage as RawUsage | undefined);
    const servedByModel =
      (response.response as { modelId?: string } | undefined)?.modelId ?? 'unknown';
    const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls.length : 0;
    const failedOver = detectFailover(requestedModel, servedByModel);
    activity.emit('call-end', `Answered by ${servedByModel} in ${formatDuration(durationMs)}`, {
      model: servedByModel,
      backend: 'api',
      durationMs,
      tokens: usage.totalTokens,
    });
    const routing = buildRouting(requestedModel, 'api', [{ model: servedByModel, backend: 'api', outcome: 'served' }], {
      failedOver,
      served: servedByModel,
    });
    publishRouting(options, routing);

    appendEvent(options.runId, {
      type: 'agent_call',
      role: options.role,
      step: options.step,
      attempt,
      requestedModel,
      servedByModel,
      backend: 'api',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      cachedTokens: usage.cachedTokens,
      totalTokens: usage.totalTokens,
      toolCalls,
      durationMs,
      failedOver,
      dryRun: false,
    });

    const object = response.object as z.infer<TSchema> | undefined;
    if (object === undefined || object === null) {
      throw new Error(
        `Agent "${options.role}" returned no structured output. Text response: ` +
          `${String(response.text).slice(0, 500)}`,
      );
    }

    return {
      object,
      text: response.text ?? '',
      requestedModel,
      servedByModel,
      failedOver,
      routing,
      usage,
      toolCalls,
      durationMs,
      dryRun: false,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    activity.emit('call-failed', `Failed: ${shortDetail(message, 200)}`, { durationMs });
    appendEvent(options.runId, {
      type: 'agent_error',
      role: options.role,
      step: options.step,
      attempt,
      requestedModel,
      durationMs,
      error: message,
    });
    throw new Error(`Agent "${options.role}" failed during step "${options.step}": ${message}`, {
      cause: error,
    });
  } finally {
    activity.close();
  }
}

/** Renders a labelled block for an agent prompt, skipping empty payloads. */
export function promptSection(title: string, body: unknown): string {
  if (body === undefined || body === null) return '';
  const rendered =
    typeof body === 'string' ? body.trim() : JSON.stringify(body, null, 2);
  if (rendered === '' || rendered === '{}' || rendered === '[]' || rendered === 'null') return '';
  return `\n## ${title}\n\n${rendered}\n`;
}

/** Joins prompt sections, dropping the empty ones. */
export function composePrompt(...sections: string[]): string {
  return sections.filter((section) => section.trim() !== '').join('\n');
}
