/**
 * Model routing and LLM resiliency.
 *
 * Every agent receives a **fallback chain** instead of a single model. Mastra's model router
 * tries the primary model first and automatically fails over to the next entry on rate limits
 * (429), server errors (5xx) and timeouts, preserving the error context along the chain.
 *
 * Two generations are supported:
 *   - `current`  (default): the current Claude / GPT generation.
 *   - `legacy`            : the exact models of the original specification
 *                           (Claude 3.7 / 3.5 Sonnet / 3.5 Haiku with GPT-4o fallbacks).
 *
 * Select with `FACTORY_MODEL_GENERATION=current|legacy`, or override a single role with
 * `FACTORY_MODEL_<ROLE>="primary,fallback1,fallback2"`.
 */
import type { ModelWithRetries } from '@mastra/core/agent';

import { getFactoryConfig } from './factory-config.ts';

export type AgentRole =
  | 'pm-architect'
  | 'developer'
  | 'qa-tester'
  | 'triage'
  | 'security'
  | 'reviewer'
  | 'documentation';

export const AGENT_ROLES: AgentRole[] = [
  'pm-architect',
  'developer',
  'qa-tester',
  'triage',
  'security',
  'reviewer',
  'documentation',
];

/** Capability tier requested by a role, independent of the concrete model id. */
type ModelTier = 'reasoning' | 'fast';

const ROLE_TIERS: Record<AgentRole, ModelTier> = {
  'pm-architect': 'reasoning',
  developer: 'reasoning',
  'qa-tester': 'fast',
  triage: 'reasoning',
  security: 'reasoning',
  reviewer: 'reasoning',
  documentation: 'fast',
};

/** Roles whose OpenAI fallback is intentionally the cheaper "mini" model. */
const MINI_FALLBACK_ROLES: ReadonlySet<AgentRole> = new Set([
  'qa-tester',
  'reviewer',
  'documentation',
]);

interface GenerationModels {
  reasoningPrimary: string;
  fastPrimary: string;
  flagshipFallback: string;
  miniFallback: string;
  googleFallback: string;
}

const GENERATIONS: Record<'current' | 'legacy', GenerationModels> = {
  current: {
    reasoningPrimary: 'anthropic/claude-sonnet-4-6',
    fastPrimary: 'anthropic/claude-haiku-4-5',
    flagshipFallback: 'openai/gpt-4o',
    miniFallback: 'openai/gpt-4o-mini',
    googleFallback: 'google/gemini-2.5-pro',
  },
  legacy: {
    // Exact models of the original architecture specification.
    reasoningPrimary: 'anthropic/claude-3.7-sonnet',
    fastPrimary: 'anthropic/claude-3.5-haiku',
    flagshipFallback: 'openai/gpt-4o',
    miniFallback: 'openai/gpt-4o-mini',
    googleFallback: 'google/gemini-2.5-pro',
  },
};

const ROLE_ENV_KEYS: Record<AgentRole, string> = {
  'pm-architect': 'FACTORY_MODEL_PM_ARCHITECT',
  developer: 'FACTORY_MODEL_DEVELOPER',
  'qa-tester': 'FACTORY_MODEL_QA_TESTER',
  triage: 'FACTORY_MODEL_TRIAGE',
  security: 'FACTORY_MODEL_SECURITY',
  reviewer: 'FACTORY_MODEL_REVIEWER',
  documentation: 'FACTORY_MODEL_DOCUMENTATION',
};

/** Retry budget per position in the chain: primary gets the most, last resort the least. */
const RETRIES_BY_POSITION = [3, 2, 1];

function activeGeneration(): GenerationModels {
  const requested = (process.env.FACTORY_MODEL_GENERATION ?? 'current').trim().toLowerCase();
  return requested === 'legacy' ? GENERATIONS.legacy : GENERATIONS.current;
}

/** Ordered list of model ids for a role, honouring env overrides. */
export function getModelChainIds(role: AgentRole): string[] {
  const override = process.env[ROLE_ENV_KEYS[role]];
  if (override && override.trim() !== '') {
    const ids = override
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (ids.length > 0) return ids;
  }

  const generation = activeGeneration();
  const primary =
    ROLE_TIERS[role] === 'reasoning' ? generation.reasoningPrimary : generation.fastPrimary;
  const fallback = MINI_FALLBACK_ROLES.has(role)
    ? generation.miniFallback
    : generation.flagshipFallback;

  const chain = [primary, fallback];
  if (getFactoryConfig().enableGoogleFallback) chain.push(generation.googleFallback);
  return chain;
}

/**
 * Builds the Mastra fallback chain for a role.
 *
 * Returned as `ModelWithRetries[]`, which Mastra consumes natively: each entry keeps its own
 * retry budget before the router moves to the next provider.
 */
export function buildModelChain(role: AgentRole): ModelWithRetries[] {
  return getModelChainIds(role).map((id, index) => ({
    id: `${role}-${index === 0 ? 'primary' : `fallback-${index}`}`,
    // Model-router ids are validated at runtime; env overrides are intentionally widened.
    model: id as ModelWithRetries['model'],
    maxRetries: RETRIES_BY_POSITION[index] ?? 1,
  }));
}

/** Human-readable chain description, used in logs and in `summary.json`. */
export function describeModelChain(role: AgentRole): string {
  const [primary, ...fallbacks] = getModelChainIds(role);
  return fallbacks.length === 0
    ? `${primary} (no fallback)`
    : `${primary} -> ${fallbacks.join(' -> ')}`;
}

/** Primary model id of a role (reported as `requestedModel` in the run summary). */
export function getPrimaryModelId(role: AgentRole): string {
  return getModelChainIds(role)[0] ?? 'unknown';
}

/** Provider prefixes referenced by the active configuration. */
export function getRequiredProviders(): string[] {
  const providers = new Set<string>();
  for (const role of AGENT_ROLES) {
    for (const id of getModelChainIds(role)) {
      const [provider] = id.split('/');
      if (provider) providers.add(provider);
    }
  }
  return [...providers];
}

const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

/**
 * Reports which configured providers are missing their API key.
 * The factory can still run as long as one provider in each chain is usable.
 */
export function checkProviderCredentials(): {
  ready: string[];
  missing: { provider: string; envKey: string }[];
} {
  const ready: string[] = [];
  const missing: { provider: string; envKey: string }[] = [];

  for (const provider of getRequiredProviders()) {
    const envKey = PROVIDER_ENV_KEYS[provider];
    if (!envKey) continue;
    if (process.env[envKey] && process.env[envKey]!.trim() !== '') ready.push(provider);
    else missing.push({ provider, envKey });
  }
  return { ready, missing };
}
