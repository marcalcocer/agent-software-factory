/**
 * Which model answered a call, and why not the one that was asked.
 *
 * The free tier (`FACTORY_FREE_ROLES` / `FACTORY_FREE_CHAIN`) puts free-quota models in front of Claude for
 * the small roles. A call can therefore pass through several models before one answers: one over its
 * quota, one signed out, one whose answer broke the output contract. Every one of them is recorded here,
 * with the reason, so the run's step report and the Studio can say it plainly instead of showing only the
 * model that happened to answer.
 *
 * This file also keeps the memory that stops the factory from asking again a model that just said it is
 * out of quota: a cooldown per model, shared by every run through a small file in the log directory.
 */
import fs from 'node:fs';
import path from 'node:path';

import { getFactoryConfig } from './factory-config.ts';

export type RoutingBackend = 'free-tier' | 'claude-cli' | 'api' | 'dry-run';

/**
 * What happened to one model on the way to the answer.
 *
 * - `served`        : it answered and the answer was accepted.
 * - `rate-limit`    : out of quota or too many requests (the detail says which, when the provider does).
 * - `cooling-down`  : not asked, because it said it was out of quota a moment ago.
 * - `not-configured`: not asked, because its API key is not set.
 * - `auth`          : the key was refused.
 * - `not-found`     : the provider has no such model (or the key has no access to it).
 * - `invalid`       : it answered, but not in the shape the step needs.
 * - `timeout`       : no answer in time.
 * - `error`         : anything else.
 */
export type AttemptOutcome =
  | 'served'
  | 'rate-limit'
  | 'cooling-down'
  | 'not-configured'
  | 'auth'
  | 'not-found'
  | 'invalid'
  | 'timeout'
  | 'error';

export interface ModelAttempt {
  model: string;
  backend: RoutingBackend;
  outcome: AttemptOutcome;
  detail?: string;
}

export interface ModelRouting {
  /** The model the step asked for first. */
  requested: string;
  /** The model that gave the answer. */
  served: string;
  backend: RoutingBackend;
  /** A model other than the first choice answered. */
  failedOver: boolean;
  /** One line saying why, when `failedOver`. */
  fallbackReason?: string;
  /** Every model tried, in order, the one that answered last. */
  attempts: ModelAttempt[];
}

/** Sorts a provider's failure into what to do next: wait, fix a key, fix a model name, look at the answer. */
export function classifyFailure(message: string): Exclude<AttemptOutcome, 'served' | 'cooling-down' | 'not-configured'> {
  if (/\b429\b|rate.?limit|quota|resource_exhausted|too many requests|exceeded/i.test(message)) return 'rate-limit';
  if (/\b404\b|model_not_found|does not exist|not found|no access to it/i.test(message)) return 'not-found';
  if (/\b40[13]\b|api key|unauthori[sz]ed|permission|forbidden|invalid.*key/i.test(message)) return 'auth';
  if (/timed? ?out|no answer in|etimedout|deadline/i.test(message)) return 'timeout';
  if (/structured|schema|validation|no structured output|json|zod/i.test(message)) return 'invalid';
  return 'error';
}

/** The first line of a provider's message, short enough to read in a badge. */
export function shortDetail(message: string, max = 160): string {
  const line = message.split('\n').find((entry) => entry.trim() !== '')?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "gemini-3.1-flash-lite: rate-limit (...); claude-cli/haiku: ..." - the reason a first choice did not answer. */
export function describeFallback(attempts: ModelAttempt[]): string | undefined {
  const failed = attempts.filter((attempt) => attempt.outcome !== 'served');
  if (failed.length === 0) return undefined;
  return failed
    .map((attempt) => `${attempt.model}: ${attempt.outcome}${attempt.detail ? ` (${attempt.detail})` : ''}`)
    .join('; ');
}

/**
 * Builds the record of a call from the models tried. The last accepted attempt is the one that answered.
 * `failedOver` and `served` are given when the ids of the request and of the answer are not written the same
 * way (a Claude alias asked for, a full model id answered), so comparing them would always differ.
 */
export function buildRouting(
  requested: string,
  backend: RoutingBackend,
  attempts: ModelAttempt[],
  override: { failedOver?: boolean; served?: string } = {},
): ModelRouting {
  const served = [...attempts].reverse().find((attempt) => attempt.outcome === 'served');
  const servedModel = override.served ?? served?.model ?? requested;
  const failedOver =
    override.failedOver ?? (servedModel !== requested || attempts.some((attempt) => attempt.outcome !== 'served'));
  const reason = failedOver ? (describeFallback(attempts) ?? 'a different model answered than the one asked first') : undefined;
  return {
    requested,
    served: servedModel,
    backend: served?.backend ?? backend,
    failedOver,
    ...(reason ? { fallbackReason: reason } : {}),
    attempts,
  };
}

/* -------------------------------------------------------------------------- */
/* Hand-over to the step report                                                */
/* -------------------------------------------------------------------------- */

const pending = new Map<string, ModelRouting>();
const routingKey = (runId: string, step: string, attempt: number) => `${runId}|${step}|${attempt}`;

/** Remembers how a call was routed until the step's report is written. */
export function recordRouting(runId: string, step: string, attempt: number, routing: ModelRouting): void {
  pending.set(routingKey(runId, step, attempt), routing);
}

/** The routing of the last call of a step, once: the report that is written next carries it. */
export function takeRouting(runId: string, step: string, attempt: number): ModelRouting | undefined {
  const key = routingKey(runId, step, attempt);
  const routing = pending.get(key);
  pending.delete(key);
  return routing;
}

/* -------------------------------------------------------------------------- */
/* Cooldowns                                                                   */
/* -------------------------------------------------------------------------- */

interface CooldownEntry {
  until: string;
  outcome: AttemptOutcome;
  detail?: string;
}

const COOLDOWN_FILE = 'free-tier-state.json';

function cooldownPath(): string {
  return path.join(getFactoryConfig().logDir, COOLDOWN_FILE);
}

function readCooldowns(): Record<string, CooldownEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(cooldownPath(), 'utf8')) as Record<string, CooldownEntry>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * How long to leave a model alone after a failure. A daily quota will not come back in minutes, a
 * per-minute one will; a refused key or a model that does not exist will not fix itself.
 */
export function cooldownMs(outcome: AttemptOutcome, detail = ''): number {
  const minute = 60_000;
  if (outcome === 'auth' || outcome === 'not-found') return 24 * 60 * minute;
  if (outcome === 'rate-limit') {
    if (/per.?day|daily|requests per day|RPD/i.test(detail)) return 6 * 60 * minute;
    const configured = Number.parseInt(process.env.FACTORY_FREE_COOLDOWN_MINUTES ?? '', 10);
    return (Number.isFinite(configured) && configured > 0 ? configured : 15) * minute;
  }
  return 0;
}

/** When the model may be asked again, or null if it may be asked now. */
export function activeCooldown(model: string, now = Date.now()): CooldownEntry | null {
  const entry = readCooldowns()[model];
  if (!entry) return null;
  return Date.parse(entry.until) > now ? entry : null;
}

/** Notes that a model failed in a way that makes asking it again pointless for a while. */
export function markCooldown(model: string, outcome: AttemptOutcome, detail: string, now = Date.now()): void {
  const ms = cooldownMs(outcome, detail);
  if (ms <= 0) return;
  try {
    const entries = readCooldowns();
    entries[model] = { until: new Date(now + ms).toISOString(), outcome, ...(detail ? { detail } : {}) };
    for (const [key, entry] of Object.entries(entries)) {
      if (Date.parse(entry.until) <= now) delete entries[key];
    }
    fs.mkdirSync(path.dirname(cooldownPath()), { recursive: true });
    fs.writeFileSync(cooldownPath(), `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
  } catch {
    // The memory is a courtesy to the provider and to the clock; a run never fails for lack of it.
  }
}

/** "until 18:30" for a cooldown, in the reader's own time. */
export function formatUntil(iso: string): string {
  const date = new Date(iso);
  return `until ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
