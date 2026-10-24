import type { ModelRouting, RunArtifact } from '../../shared/types';
import {
  hasRoutingStory,
  isQuotaFailure,
  outcomeText,
  shortModelName,
  stepModelBadge,
  summarizeModels,
  type ModelKind,
} from '../../shared/modelRouting';

const KIND_STYLE: Record<ModelKind, string> = {
  free: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/40',
  claude: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/40',
  other: 'bg-slate-500/15 text-slate-600 dark:text-slate-300 border-slate-500/30',
};

const KIND_NAME: Record<ModelKind, string> = { free: 'free tier', claude: 'Claude', other: '' };

/** The model that did a step, with a mark when it was free and a warning when a different model had to take over. */
export function ModelChip({ artifact, compact = false }: { artifact: RunArtifact | undefined; compact?: boolean }) {
  const badge = stepModelBadge(artifact);
  if (!badge) return null;
  const warn = badge.fellBack;
  return (
    <span
      data-testid="model-chip"
      title={badge.title}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] leading-tight whitespace-nowrap ${
        warn ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/50' : KIND_STYLE[badge.kind]
      }`}
    >
      {warn && <span aria-label="fell back">⚠</span>}
      <span className="font-medium">{badge.label}</span>
      {!compact && badge.kind !== 'other' && <span className="opacity-70">· {KIND_NAME[badge.kind]}</span>}
      {warn && badge.outOfQuota && <span className="opacity-80">· out of quota</span>}
    </span>
  );
}

/** One line over the pipeline: how many steps each kind of model answered, and how many had to fall back. */
export function ModelsSummary({ artifacts }: { artifacts: RunArtifact[] }) {
  const summary = summarizeModels(artifacts);
  if (summary.free + summary.claude === 0) return null;
  return (
    <div
      data-testid="models-summary"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-white dark:bg-slate-800 px-4 py-2 text-xs text-slate-600 dark:text-slate-300"
    >
      <span className="font-semibold text-slate-500">Models</span>
      <span>
        <b className="text-emerald-600 dark:text-emerald-400">{summary.free}</b> free tier
      </span>
      <span>
        <b className="text-indigo-600 dark:text-indigo-400">{summary.claude}</b> Claude
      </span>
      {summary.fellBack > 0 && (
        <span className="text-amber-600 dark:text-amber-400">
          ⚠ <b>{summary.fellBack}</b> fell back to another model
          {summary.outOfQuota > 0 && ` (${summary.outOfQuota} because a model was out of quota)`}
        </span>
      )}
    </div>
  );
}

/** The path of one call: every model tried, in order, and why each one that did not answer did not. */
export function RoutingPanel({ routing }: { routing: ModelRouting | undefined }) {
  if (!hasRoutingStory(routing)) return null;
  const quota = routing.attempts.some(isQuotaFailure);
  return (
    <div data-testid="routing-panel" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
      <div className="text-sm font-semibold text-amber-700 dark:text-amber-300">
        ⚠ {shortModelName(routing.served)} answered instead of {shortModelName(routing.requested)}
      </div>
      {quota && (
        <p className="text-xs text-amber-800 dark:text-amber-200">
          A free model was out of quota, so the call moved on. It is left alone for a while before it is asked again.
        </p>
      )}
      <ol className="space-y-1 text-xs">
        {routing.attempts.map((attempt, index) => (
          <li key={`${attempt.model}-${index}`} className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-slate-400">{index + 1}.</span>
            <span className="font-mono text-slate-700 dark:text-slate-200">{shortModelName(attempt.model)}</span>
            <span className="text-slate-500">{attempt.backend === 'free-tier' ? 'free tier' : attempt.backend === 'claude-cli' ? 'Claude' : attempt.backend}</span>
            <span className={attempt.outcome === 'served' ? 'text-green-600 dark:text-green-400' : 'text-amber-700 dark:text-amber-300'}>
              {outcomeText(attempt.outcome)}
            </span>
            {attempt.detail && <span className="text-slate-500 break-all">{attempt.detail}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
