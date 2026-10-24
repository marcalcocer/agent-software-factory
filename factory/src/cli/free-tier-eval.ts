/**
 * `npm run eval:free` - can a free-tier model do the factory's small jobs?
 *
 * Sends sample requests for the run namer, the merge summary and the PR writer - with the real
 * instructions and the real output schemas - to each candidate model, and prints how often the answer
 * is accepted and how fast it comes. It changes nothing: no repository is touched and no run is made.
 *
 *   npm run eval:free                                  (default candidates, 2 rounds)
 *   npm run eval:free -- --models google/gemini-3.5-flash-lite,groq/llama-3.3-70b-versatile --rounds 3
 *
 * A model whose provider key is missing from `.env` is skipped. Requests are spaced (`--delay-ms`,
 * 4500 by default: 13 a minute, under the strictest free limit) so the check does not use up the quota.
 */
import 'dotenv/config';

import fs from 'node:fs';
import path from 'node:path';

import { Agent } from '@mastra/core/agent';

import { getFactoryConfig } from '../utils/factory-config.ts';
import {
  buildEvalCases,
  classifyError,
  qualityIssues,
  renderTable,
  summarize,
  type EvalResult,
} from '../utils/free-tier-eval.ts';
import { composeInstructions } from '../utils/context-loader.ts';
import { PROVIDER_ENV_KEYS } from '../utils/model-router.ts';

const DEFAULT_MODELS = [
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.1-flash-lite',
  'groq/llama-3.3-70b-versatile',
  'mistral/mistral-small-latest',
];
const CALL_TIMEOUT_MS = 60_000;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${CALL_TIMEOUT_MS / 1000}s`)), CALL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const models = (option('models') ?? DEFAULT_MODELS.join(',')).split(',').map((m) => m.trim()).filter(Boolean);
  const rounds = Math.max(1, Number.parseInt(option('rounds') ?? '2', 10) || 2);
  const delayMs = Math.max(0, Number.parseInt(option('delay-ms') ?? '4500', 10) || 0);
  const cases = buildEvalCases();

  const usable = models.filter((model) => {
    const provider = model.split('/')[0] ?? '';
    const envKey = PROVIDER_ENV_KEYS[provider];
    const hasKey = envKey !== undefined && (process.env[envKey]?.trim() ?? '') !== '';
    if (!hasKey) console.log(`skipping ${model}: ${envKey ?? `no known key for "${provider}"`} is not set`);
    return hasKey;
  });
  if (usable.length === 0) {
    console.error('No candidate has its API key set. Fill in factory/.env (see .env.example) and run again.');
    process.exitCode = 1;
    return;
  }

  const total = usable.length * cases.length * rounds;
  console.log(`\n${total} requests: ${usable.length} models x ${cases.length} samples x ${rounds} rounds, ${delayMs} ms apart.\n`);

  const results: EvalResult[] = [];
  let done = 0;
  for (const model of usable) {
    for (let round = 0; round < rounds; round += 1) {
      for (const sample of cases) {
        const agent = new Agent({
          id: `eval-${sample.role}`,
          name: `Free-tier eval: ${sample.role}`,
          instructions: composeInstructions(sample.role, null),
          model: model as never,
        });
        const started = Date.now();
        const result: EvalResult = { model, role: sample.role, caseId: sample.id, outcome: 'ok', issues: [], durationMs: 0 };
        try {
          const response = await withTimeout(
            agent.generate(sample.prompt, { structuredOutput: { schema: sample.schema as never } }),
          );
          const parsed = sample.schema.safeParse(response.object);
          if (!parsed.success) {
            result.outcome = 'invalid';
            result.error = parsed.error.message.slice(0, 200);
          } else {
            result.issues = qualityIssues(sample.role, parsed.data);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.outcome = classifyError(message);
          result.error = message.slice(0, 200);
        }
        result.durationMs = Date.now() - started;
        results.push(result);
        done += 1;
        const note = result.error ?? result.issues.join('; ');
        console.log(`[${done}/${total}] ${model} ${sample.id}: ${result.outcome}${note ? ` (${note})` : ''}`);
        if (done < total) await sleep(delayMs);
      }
    }
  }

  console.log(`\n${renderTable(summarize(results))}\n`);
  console.log('valid = the answer met the output contract; clean = it also kept the house rules (short subject, no full stop, ...).');

  const outDir = getFactoryConfig().logDir;
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `free-tier-eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`Details of every request: ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
