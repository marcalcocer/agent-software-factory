import { useEffect, useState } from 'react';

import { clockTime, countdown, retryView, windowLabel } from '../../shared/usageLimit';
import type { AutoRetryState, FactoryRun } from '../../shared/types';

/**
 * A run that stopped because Claude's usage limit was reached: which limit, when it resets, and the
 * automatic retry - its countdown, "Retry now" and "Cancel automatic retry"; or, when it is off, a
 * button to retry by itself once the limit resets.
 */
export function UsageLimitRetry({
  run,
  onRetryNow,
  onChanged,
}: {
  run: Pick<FactoryRun, 'runId' | 'usageLimit' | 'autoRetry'>;
  onRetryNow?: () => void;
  /** The plan changed (cancelled, armed): read the run again. */
  onChanged?: (plan: AutoRetryState | null) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<AutoRetryState | undefined>(run.autoRetry);

  useEffect(() => setPlan(run.autoRetry), [run.autoRetry]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!run.usageLimit) return null;
  const view = retryView(run.usageLimit, plan);
  const limitName = windowLabel(view.kind === 'retrying' ? run.usageLimit.window : view.window);

  const change = async (channel: 'factory:auto-retry-cancel' | 'factory:auto-retry-arm') => {
    setBusy(true);
    try {
      const next = await window.api.invoke(channel, run.runId);
      setPlan(next ?? undefined);
      onChanged?.(next);
    } finally {
      setBusy(false);
    }
  };

  const resets = view.kind !== 'retrying' && view.resetsAt
    ? `It resets at ${clockTime(view.resetsAt, now)} (in ${countdown(view.resetsAt, now)}).`
    : 'Claude did not say when it resets.';

  return (
    <div data-testid="usage-limit" className="space-y-3">
      <p className="text-sm text-red-900 dark:text-red-100 leading-relaxed">
        Claude&apos;s <b>{limitName} usage limit</b> was reached, so the run stopped. {view.kind !== 'retrying' && resets} Everything
        already done is kept: the run continues from the step that stopped.
      </p>

      {view.kind === 'scheduled' && (
        <div data-testid="auto-retry-scheduled" className="flex flex-wrap items-center gap-3 rounded-md bg-blue-50 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700 px-3 py-2">
          <span className="text-2xl">⏳</span>
          <div className="flex-1 min-w-[12rem]">
            <div className="text-sm font-semibold text-blue-900 dark:text-blue-100">
              Retrying automatically at {clockTime(view.retryAt, now)}
            </div>
            <div data-testid="auto-retry-countdown" className="font-mono text-lg text-blue-700 dark:text-blue-300 tabular-nums">
              in {countdown(view.retryAt, now)}
            </div>
            {view.tries > 0 && (
              <div className="text-xs text-blue-700/80 dark:text-blue-300/80">Automatic retry {view.tries + 1}: the limit was still reached last time.</div>
            )}
          </div>
          <div className="flex gap-2">
            {onRetryNow && (
              <button onClick={onRetryNow} className="px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium">
                ▶ Retry now
              </button>
            )}
            <button
              disabled={busy}
              onClick={() => void change('factory:auto-retry-cancel')}
              className="px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              Cancel automatic retry
            </button>
          </div>
        </div>
      )}

      {view.kind === 'retrying' && (
        <div className="rounded-md bg-blue-50 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700 px-3 py-2 text-sm text-blue-900 dark:text-blue-100">
          ⏳ The limit should be back: the run is being retried.
        </div>
      )}

      {view.kind === 'off' && (
        <div data-testid="auto-retry-off" className="space-y-2">
          <p className="text-xs text-slate-600 dark:text-slate-300">
            {view.reason === 'cancelled'
              ? 'Automatic retry was cancelled for this run.'
              : view.reason === 'gave-up'
                ? `Retried automatically ${view.tries} times and the limit was still reached each time, so it stopped trying.`
                : 'Automatic retry is off (Settings).'}
          </p>
          <div className="flex flex-wrap gap-2">
            {onRetryNow && (
              <button onClick={onRetryNow} className="px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium">
                ▶ Retry now
              </button>
            )}
            <button
              disabled={busy}
              onClick={() => void change('factory:auto-retry-arm')}
              className="px-4 py-2 rounded-md border border-blue-400 text-blue-700 dark:text-blue-300 text-sm font-medium hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-50"
            >
              ⏳ Retry automatically when the limit resets
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
