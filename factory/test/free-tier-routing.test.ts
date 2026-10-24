import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// The free models are scripted per model id: a function that answers, or throws what the provider threw.
const behaviour = vi.hoisted(() => new Map<string, () => unknown>());
const asked = vi.hoisted(() => [] as string[]);

vi.mock('@mastra/core/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mastra/core/agent')>()),
  Agent: class {
    private readonly id: string;
    constructor(config: { model: { model: string }[] }) {
      this.id = config.model[0]!.model;
    }
    async generate() {
      asked.push(this.id);
      const answer = behaviour.get(this.id);
      if (!answer) throw new Error(`unscripted model ${this.id}`);
      return { object: answer(), text: '', usage: { inputTokens: 10, outputTokens: 5 } };
    }
  },
}));

vi.mock('../src/utils/claude-cli.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/claude-cli.ts')>()),
  runClaudeCli: vi.fn(),
}));

import { invokeAgent } from '../src/utils/agent-runner.ts';
import { runClaudeCli } from '../src/utils/claude-cli.ts';
import { getFreeTierChain, getModelChainIds } from '../src/utils/model-router.ts';
import { readEvents, traceDirFor, writeArtifact } from '../src/tools/logger-tools.ts';
import { activeCooldown, classifyFailure, cooldownMs, takeRouting } from '../src/utils/model-routing.ts';

const FLASH_A = 'google/gemini-3.1-flash-lite';
const FLASH_B = 'google/gemini-3.5-flash-lite';
const schema = z.object({ title: z.string().min(1) });
const agent = { getInstructions: async () => 'Name the task.' } as never;

let dir: string;
let runCount = 0;

function ask(role: 'run-namer' = 'run-namer') {
  runCount += 1;
  return invokeAgent({
    agent,
    role,
    step: 'run-namer',
    runId: `free-tier-test-${process.pid}-${runCount}`,
    repoPath: dir,
    prompt: 'Name this.',
    schema,
    dryRunResult: { title: 'dry' },
  });
}

const claudeAnswers = () =>
  vi.mocked(runClaudeCli).mockResolvedValue({
    ok: true,
    structuredOutput: { title: 'From Claude' },
    text: '',
    servedByModel: 'claude-haiku-4-5',
    usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, totalTokens: 2 },
    toolCalls: 0,
    durationMs: 1,
    sessionId: 's',
    costUsd: 0,
  });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-tier-'));
  behaviour.clear();
  asked.length = 0;
  vi.stubEnv('FACTORY_LOG_DIR', path.join(dir, 'logs'));
  vi.stubEnv('FACTORY_PROVIDER', 'claude-cli');
  vi.stubEnv('FACTORY_FREE_ROLES', 'run-namer');
  vi.stubEnv('FACTORY_FREE_CHAIN', `${FLASH_A},${FLASH_B}`);
  vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', 'test-key');
  vi.mocked(runClaudeCli).mockReset();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('free tier routing', () => {
  it('answers from the first free model and leaves Claude alone', async () => {
    behaviour.set(FLASH_A, () => ({ title: 'From Gemini' }));
    const result = await ask();

    expect(result.object).toEqual({ title: 'From Gemini' });
    expect(result.servedByModel).toBe(FLASH_A);
    expect(result.failedOver).toBe(false);
    expect(result.routing).toMatchObject({ backend: 'free-tier', requested: FLASH_A, served: FLASH_A, failedOver: false });
    expect(runClaudeCli).not.toHaveBeenCalled();
  });

  it('moves to the next free model when one is over its quota, says why, and does not ask it again', async () => {
    behaviour.set(FLASH_A, () => {
      throw new Error('Quota exceeded for metric generate_content_free_tier_requests, limit: 500 per day');
    });
    behaviour.set(FLASH_B, () => ({ title: 'From the second' }));

    const first = await ask();
    expect(first.servedByModel).toBe(FLASH_B);
    expect(first.failedOver).toBe(true);
    expect(first.routing.attempts.map((a) => [a.model, a.outcome])).toEqual([
      [FLASH_A, 'rate-limit'],
      [FLASH_B, 'served'],
    ]);
    expect(first.routing.fallbackReason).toContain('rate-limit');
    expect(activeCooldown(FLASH_A)).not.toBeNull();

    const second = await ask();
    expect(second.routing.attempts[0]).toMatchObject({ model: FLASH_A, outcome: 'cooling-down' });
    expect(asked.filter((id) => id === FLASH_A)).toHaveLength(1);
  });

  it('writes the fallback into the events and hands the routing to the step report', async () => {
    behaviour.set(FLASH_A, () => {
      throw new Error('429 Too Many Requests');
    });
    behaviour.set(FLASH_B, () => ({ title: 'x' }));
    const result = await ask();
    const runId = `free-tier-test-${process.pid}-${runCount}`;

    const event = readEvents(runId).find((entry) => entry.type === 'model_fallback') as Record<string, unknown>;
    expect(event).toMatchObject({ role: 'run-namer', from: FLASH_A, to: FLASH_B });
    expect(String(event.reason)).toContain('rate-limit');

    writeArtifact({ runId, step: 'run-namer', status: 'COMPLETED', model: result.servedByModel, data: {} });
    const artifact = JSON.parse(fs.readFileSync(path.join(traceDirFor(runId), '00-run-namer.json'), 'utf8'));
    expect(artifact.routing).toMatchObject({ served: FLASH_B, failedOver: true });
    expect(takeRouting(runId, 'run-namer', 1)).toBeUndefined();
    fs.rmSync(traceDirFor(runId), { recursive: true, force: true });
  });

  it('falls back to Claude when no free model can answer, and keeps the whole path', async () => {
    behaviour.set(FLASH_A, () => {
      throw new Error('Rate limit exceeded');
    });
    behaviour.set(FLASH_B, () => ({ title: '' }));
    claudeAnswers();

    const result = await ask();
    expect(result.object).toEqual({ title: 'From Claude' });
    expect(result.routing).toMatchObject({ backend: 'claude-cli', served: 'claude-haiku-4-5', failedOver: true });
    expect(result.routing.attempts.map((a) => a.outcome)).toEqual(['rate-limit', 'invalid', 'served']);
    expect(result.routing.fallbackReason).toContain(FLASH_A);
  });

  it('skips a model whose key is not set, and says so', async () => {
    vi.stubEnv('GOOGLE_GENERATIVE_AI_API_KEY', '');
    claudeAnswers();
    const result = await ask();
    expect(asked).toEqual([]);
    expect(result.routing.attempts.slice(0, 2).map((a) => a.outcome)).toEqual(['not-configured', 'not-configured']);
    expect(result.routing.attempts[0]!.detail).toContain('GOOGLE_GENERATIVE_AI_API_KEY');
  });

  it('keeps a role that is not listed, or not eligible, on Claude', async () => {
    claudeAnswers();
    vi.stubEnv('FACTORY_FREE_ROLES', '');
    const plain = await ask();
    expect(plain.routing.attempts.map((a) => a.backend)).toEqual(['claude-cli']);
    expect(plain.failedOver).toBe(false);
    expect(asked).toEqual([]);

    vi.stubEnv('FACTORY_FREE_ROLES', 'developer,run-namer');
    expect(getFreeTierChain('developer')).toEqual([]);
    expect(getFreeTierChain('run-namer')).toEqual([FLASH_A, FLASH_B]);
  });

  it('is off under the api backend and when nothing is configured', () => {
    vi.stubEnv('FACTORY_PROVIDER', 'api');
    expect(getFreeTierChain('run-namer')).toEqual([]);
    vi.stubEnv('FACTORY_PROVIDER', 'claude-cli');
    vi.stubEnv('FACTORY_FREE_CHAIN', '');
    expect(getFreeTierChain('run-namer')).toEqual([]);
    expect(getModelChainIds('run-namer')).toEqual(['claude-cli/haiku', 'claude-cli/sonnet']);
  });

  it('lists the free models first in the chain a role is reported with', () => {
    expect(getModelChainIds('run-namer')).toEqual([FLASH_A, FLASH_B, 'claude-cli/haiku', 'claude-cli/sonnet']);
  });
});

describe('failure classification', () => {
  it('tells quota from a wrong model name, a refused key and a bad answer', () => {
    expect(classifyFailure('Quota exceeded for metric ... per day')).toBe('rate-limit');
    expect(classifyFailure('The model `x` does not exist or you do not have access to it.')).toBe('not-found');
    expect(classifyFailure('403 API key not valid')).toBe('auth');
    expect(classifyFailure('no answer in 60s')).toBe('timeout');
    expect(classifyFailure('Agent returned no structured output')).toBe('invalid');
  });

  it('waits longer for a daily quota than for a per-minute one, and for good on a bad key', () => {
    expect(cooldownMs('rate-limit', 'limit: 500 per day')).toBeGreaterThan(cooldownMs('rate-limit', '429'));
    expect(cooldownMs('not-found')).toBeGreaterThan(cooldownMs('rate-limit', 'limit: 500 per day'));
    expect(cooldownMs('invalid')).toBe(0);
  });
});
