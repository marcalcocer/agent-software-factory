/**
 * The free tier: free-quota models tried before Claude, for the roles that need no tools.
 *
 * `tryFreeChain` asks each model of the chain once, in order, and returns the first answer that meets
 * the step's output contract. Everything that goes wrong on the way is recorded as an attempt - never
 * thrown - because a free model failing is an expected event with a ready answer (the next model, then
 * Claude), and the reason is exactly what the person watching the run wants to read.
 */
import { Agent } from '@mastra/core/agent';
import type { RequestContext } from '@mastra/core/request-context';
import type { z } from 'zod';

import { PROVIDER_ENV_KEYS } from './model-router.ts';
import {
  activeCooldown,
  classifyFailure,
  formatUntil,
  markCooldown,
  shortDetail,
  type ModelAttempt,
} from './model-routing.ts';

export interface FreeChainCall {
  role: string;
  /** Model ids, `provider/model`, in the order to ask them. */
  models: string[];
  systemPrompt: string;
  prompt: string;
  schema: z.ZodType;
  requestContext: RequestContext;
  timeoutMs?: number;
  /** Told when a model is about to be asked, and how each attempt ended: the live activity of the call. */
  onProgress?: (progress: { phase: 'asking'; model: string } | { phase: 'done'; attempt: ModelAttempt }) => void;
}

export interface FreeChainAnswer {
  object: unknown;
  text: string;
  servedByModel: string;
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number; cachedTokens: number; totalTokens: number };
}

const DEFAULT_TIMEOUT_MS = 60_000;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Does this provider have the key it needs? An unknown provider is left to fail on its own. */
export function missingKey(model: string): string | null {
  const provider = model.split('/')[0] ?? '';
  const envKey = PROVIDER_ENV_KEYS[provider];
  if (!envKey) return null;
  return (process.env[envKey]?.trim() ?? '') === '' ? envKey : null;
}

/**
 * Asks the chain. Returns the first accepted answer, or null when none was; `attempts` is filled either
 * way, the model that answered last.
 */
export async function tryFreeChain(call: FreeChainCall, attemptLog: ModelAttempt[]): Promise<FreeChainAnswer | null> {
  const attempts = {
    push(attempt: ModelAttempt): void {
      attemptLog.push(attempt);
      call.onProgress?.({ phase: 'done', attempt });
    },
  };
  for (const model of call.models) {
    const key = missingKey(model);
    if (key) {
      attempts.push({ model, backend: 'free-tier', outcome: 'not-configured', detail: `${key} is not set` });
      continue;
    }
    const cooling = activeCooldown(model);
    if (cooling) {
      attempts.push({
        model,
        backend: 'free-tier',
        outcome: 'cooling-down',
        detail: `${cooling.outcome} ${formatUntil(cooling.until)}${cooling.detail ? `: ${cooling.detail}` : ''}`,
      });
      continue;
    }

    call.onProgress?.({ phase: 'asking', model });
    try {
      // One try, no retries: the next model of the chain is the retry, and a provider that is over its
      // quota only makes a second try slower.
      const agent = new Agent({
        id: `free-${call.role}`,
        name: `Free tier: ${call.role}`,
        instructions: call.systemPrompt,
        model: [{ id: `free-${call.role}`, model: model as never, maxRetries: 0 }],
      });
      const response = await withTimeout(
        agent.generate(call.prompt, {
          structuredOutput: { schema: call.schema as never },
          requestContext: call.requestContext,
        }),
        call.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );

      const parsed = call.schema.safeParse(response.object);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ');
        attempts.push({ model, backend: 'free-tier', outcome: 'invalid', detail: shortDetail(detail) });
        continue;
      }

      attempts.push({ model, backend: 'free-tier', outcome: 'served' });
      const usage = (response.usage ?? {}) as Record<string, number | undefined>;
      const input = usage.inputTokens ?? usage.promptTokens ?? 0;
      const output = usage.outputTokens ?? usage.completionTokens ?? 0;
      return {
        object: parsed.data,
        text: response.text ?? '',
        servedByModel: model,
        usage: {
          inputTokens: input,
          outputTokens: output,
          reasoningTokens: usage.reasoningTokens ?? 0,
          cachedTokens: usage.cachedInputTokens ?? 0,
          totalTokens: usage.totalTokens ?? input + output,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outcome = classifyFailure(message);
      const detail = shortDetail(message);
      attempts.push({ model, backend: 'free-tier', outcome, detail });
      markCooldown(model, outcome, message);
    }
  }
  return null;
}
