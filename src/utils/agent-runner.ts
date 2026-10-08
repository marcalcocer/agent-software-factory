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
import type { Agent } from '@mastra/core/agent';
import { RequestContext } from '@mastra/core/request-context';
import type { TracingContext } from '@mastra/core/observability';
import type { z } from 'zod';

import { appendEvent, type ArtifactStep } from '../tools/logger-tools.ts';
import { getFactoryConfig } from './factory-config.ts';
import { REQUEST_CONTEXT_KEYS } from './context-loader.ts';
import { getPrimaryModelId, type AgentRole } from './model-router.ts';

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
}

export interface InvokeAgentResult<TOutput> {
  object: TOutput;
  text: string;
  requestedModel: string;
  servedByModel: string;
  failedOver: boolean;
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

  try {
    const response = await options.agent.generate(options.prompt, {
      structuredOutput: { schema: options.schema as never },
      requestContext,
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
      ...(options.tracingContext === undefined ? {} : { tracingContext: options.tracingContext }),
    });

    const durationMs = Date.now() - startedAt;
    const usage = normalizeUsage(response.usage as RawUsage | undefined);
    const servedByModel =
      (response.response as { modelId?: string } | undefined)?.modelId ?? 'unknown';
    const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls.length : 0;
    const failedOver = detectFailover(requestedModel, servedByModel);

    appendEvent(options.runId, {
      type: 'agent_call',
      role: options.role,
      step: options.step,
      attempt,
      requestedModel,
      servedByModel,
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
      usage,
      toolCalls,
      durationMs,
      dryRun: false,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
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
