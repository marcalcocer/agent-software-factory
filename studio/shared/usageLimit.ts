/**
 * Claude's usage limit, in words, for the views: which window ran out, when it resets, when the run is
 * retried and how long until then.
 */
import type { AutoRetryState, UsageLimitInfo } from './types';

/** "5-hour", "weekly", ... */
export function windowLabel(window: string | undefined): string {
  if (!window) return 'usage';
  if (window === 'five_hour') return '5-hour';
  if (window === 'seven_day') return 'weekly';
  if (window.startsWith('seven_day_')) return `weekly ${window.slice('seven_day_'.length)}`;
  return window.replace(/_/g, ' ');
}

/** "1h 12m 05s", "4m 09s", "38s"; "now" once it has passed. */
export function countdown(untilIso: string, now: number): string {
  const ms = Date.parse(untilIso) - now;
  if (Number.isNaN(ms) || ms <= 0) return 'now';
  const total = Math.ceil(ms / 1000);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (days > 0) return `${days}d ${hours}h ${pad(minutes)}m`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

/** "17:21", or "Mon 17:21" when it is not today. */
export function clockTime(iso: string, now: number): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay = new Date(now).toDateString() === at.toDateString();
  return sameDay ? time : `${at.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

export type RetryView =
  | { kind: 'scheduled'; retryAt: string; resetsAt: string | null; window?: string; tries: number }
  | { kind: 'retrying' }
  | { kind: 'off'; resetsAt: string | null; window?: string; reason: 'cancelled' | 'setting' | 'gave-up'; tries: number };

/** What the run's usage-limit panel should say and offer. */
export function retryView(limit: UsageLimitInfo, plan: AutoRetryState | undefined): RetryView {
  if (plan?.status === 'scheduled') {
    return { kind: 'scheduled', retryAt: plan.retryAt, resetsAt: plan.resetsAt, ...(plan.window ? { window: plan.window } : {}), tries: plan.tries };
  }
  if (plan?.status === 'retrying') return { kind: 'retrying' };
  const reason = plan?.status === 'cancelled' ? 'cancelled' : plan?.status === 'gave-up' ? 'gave-up' : 'setting';
  return { kind: 'off', resetsAt: limit.resetsAt, ...(limit.window ? { window: limit.window } : {}), reason, tries: plan?.tries ?? 0 };
}
