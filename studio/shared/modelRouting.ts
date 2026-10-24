/**
 * Which model did each step, and did a different one have to take over.
 *
 * The factory records, in every step's report, the models a call went through (see
 * `factory/src/utils/model-routing.ts`). This turns that record into what the views show: a short model
 * name, whether it was a free-tier model or Claude, and the plain words for why a model did not answer.
 */
import type { ModelAttempt, ModelRouting, RunArtifact } from './types';

/** `google/gemini-3.1-flash-lite` -> `gemini-3.1-flash-lite`; `claude-haiku-4-5-20251001` -> `claude-haiku-4-5`. */
export function shortModelName(id: string | null | undefined): string {
  if (!id) return '';
  return id
    .replace(/^claude-cli\//, '')
    .replace(/^[a-z0-9-]+\//, '')
    .replace(/-\d{8}$/, '');
}

export type ModelKind = 'free' | 'claude' | 'other';

/** Free-tier models are the ones the factory asked on a provider's free quota instead of the subscription. */
export function modelKind(artifact: Pick<RunArtifact, 'model' | 'routing'>): ModelKind {
  const backend = artifact.routing?.backend;
  if (backend === 'free-tier') return 'free';
  if (backend === 'claude-cli') return 'claude';
  const model = artifact.model ?? '';
  if (!model || model === 'dry-run-stub') return 'other';
  return /claude|haiku|sonnet|opus/i.test(model) ? 'claude' : 'other';
}

const OUTCOME_TEXT: Record<ModelAttempt['outcome'], string> = {
  served: 'answered',
  'rate-limit': 'out of quota or rate limited',
  'cooling-down': 'skipped: it ran out of quota a moment ago',
  'not-configured': 'skipped: no API key',
  auth: 'API key refused',
  'not-found': 'model not found for this key',
  invalid: 'answered in the wrong shape',
  timeout: 'did not answer in time',
  error: 'failed',
};

export function outcomeText(outcome: ModelAttempt['outcome']): string {
  return OUTCOME_TEXT[outcome] ?? outcome;
}

/** Did the model fail because it was out of quota? The thing the person most wants to see flagged. */
export function isQuotaFailure(attempt: ModelAttempt): boolean {
  return attempt.outcome === 'rate-limit' || attempt.outcome === 'cooling-down';
}

export interface StepModelBadge {
  /** What to print: the short name of the model that answered. */
  label: string;
  kind: ModelKind;
  /** A model other than the first choice answered. */
  fellBack: boolean;
  /** Some model on the way was out of quota. */
  outOfQuota: boolean;
  /** Hover text: the whole story in a few lines. */
  title: string;
}

/** The badge of a step, or null when the step made no model call (or ran before models were recorded). */
export function stepModelBadge(artifact: RunArtifact | undefined): StepModelBadge | null {
  if (!artifact?.model && !artifact?.routing) return null;
  const served = artifact.routing?.served ?? artifact.model ?? '';
  if (!served || served === 'dry-run-stub') return null;
  const routing = artifact.routing;
  const outOfQuota = routing?.attempts.some(isQuotaFailure) ?? false;
  const lines = [`Answered by ${shortModelName(served)}`];
  if (routing?.failedOver) {
    lines.push(`Asked first: ${shortModelName(routing.requested)}`);
    for (const attempt of routing.attempts.filter((entry) => entry.outcome !== 'served')) {
      lines.push(`${shortModelName(attempt.model)}: ${outcomeText(attempt.outcome)}${attempt.detail ? ` (${attempt.detail})` : ''}`);
    }
  }
  return {
    label: shortModelName(served),
    kind: modelKind(artifact),
    fellBack: routing?.failedOver ?? false,
    outOfQuota,
    title: lines.join('\n'),
  };
}

export interface ModelUsageSummary {
  free: number;
  claude: number;
  fellBack: number;
  outOfQuota: number;
}

/** How many steps each kind of model answered in a run, and how many had to fall back. */
export function summarizeModels(artifacts: RunArtifact[]): ModelUsageSummary {
  const summary: ModelUsageSummary = { free: 0, claude: 0, fellBack: 0, outOfQuota: 0 };
  for (const artifact of artifacts) {
    const badge = stepModelBadge(artifact);
    if (!badge) continue;
    if (badge.kind === 'free') summary.free += 1;
    else if (badge.kind === 'claude') summary.claude += 1;
    if (badge.fellBack) summary.fellBack += 1;
    if (badge.outOfQuota) summary.outOfQuota += 1;
  }
  return summary;
}

/** Is there anything to explain about how a step's call was routed? */
export function hasRoutingStory(routing: ModelRouting | undefined): routing is ModelRouting {
  return !!routing && (routing.failedOver || routing.attempts.length > 1);
}
