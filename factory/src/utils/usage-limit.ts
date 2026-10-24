/**
 * Claude's usage limit: when it was hit, and when it resets.
 *
 * A Claude subscription has rolling windows (five hours, a week). When one is used up, the Claude Code
 * CLI refuses the call. It also says, in its `stream-json` output, exactly when the window resets: a
 * `rate_limit_event` with `rate_limit_info.resetsAt` (epoch seconds) and `rateLimitType` (`five_hour`,
 * `seven_day`, ...). Failing that, its error text usually names the time ("resets 10pm").
 *
 * The factory records the reset time with the failure (`summary.json` → `usageLimit`) so the Studio can
 * retry the run by itself once the limit is back.
 */

export interface UsageLimit {
  /** When the window resets (ISO), or null when the CLI did not say. */
  resetsAt: string | null;
  /** `five_hour`, `seven_day`, ... as the CLI names it, when known. */
  window?: string;
}

/** "5-hour", "weekly", ... - the window, in words. */
export function windowLabel(window: string | undefined): string {
  if (!window) return 'usage';
  if (window === 'five_hour') return '5-hour';
  if (window.startsWith('seven_day')) return window === 'seven_day' ? 'weekly' : `weekly (${window.replace('seven_day_', '')})`;
  return window.replace(/_/g, ' ');
}

/** Does this text say the subscription's usage limit was reached? */
export function isUsageLimitText(text: string): boolean {
  return /usage limit|session limit|hit your limit|limit reached|rate.?limit|\b429\b/i.test(text);
}

/**
 * The CLI's own report of the limit, from its `stream-json` stdout: the last `rate_limit_event`, preferring
 * one that says the call was refused.
 */
export function limitFromStream(stdout: string): (UsageLimit & { rejected: boolean }) | null {
  let found: (UsageLimit & { rejected: boolean }) | null = null;
  for (const line of stdout.split('\n')) {
    if (!line.includes('"rate_limit_event"')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; rate_limit_info?: { status?: string; resetsAt?: number; rateLimitType?: string } };
      if (event.type !== 'rate_limit_event' || !event.rate_limit_info) continue;
      const info = event.rate_limit_info;
      const rejected = info.status === 'rejected';
      if (found?.rejected && !rejected) continue;
      found = {
        resetsAt: typeof info.resetsAt === 'number' && info.resetsAt > 0 ? new Date(info.resetsAt * 1000).toISOString() : null,
        ...(info.rateLimitType ? { window: info.rateLimitType } : {}),
        rejected,
      };
    } catch {
      // not an event this reads
    }
  }
  return found;
}

/**
 * The reset time written in an error text: "…|1792862400" (epoch seconds), "resets 10pm", "resets at
 * 10:10 pm", "resets in 2 hours 5 minutes", or an ISO date. Clock times are the machine's local time, the
 * next one to come. Null when none is found.
 */
export function resetFromText(text: string, now: Date = new Date()): string | null {
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();

  const iso = text.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/);
  if (iso && !Number.isNaN(Date.parse(iso[1]!))) return new Date(iso[1]!).toISOString();

  const inMatch = text.match(/resets?\s+in\s+(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i);
  if (inMatch && (inMatch[1] || inMatch[2])) {
    const ms = (Number(inMatch[1] ?? 0) * 60 + Number(inMatch[2] ?? 0)) * 60_000;
    return new Date(now.getTime() + ms).toISOString();
  }

  const clock = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (clock) {
    let hour = Number(clock[1]) % 12;
    if (clock[3]!.toLowerCase() === 'pm') hour += 12;
    const at = new Date(now);
    at.setHours(hour, Number(clock[2] ?? 0), 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at.toISOString();
  }
  return null;
}

/**
 * The usage limit behind a run's failure: null unless the failure reads like a usage limit. Then the last
 * `usage_limit` event written since the last `run_failed` (in the attempt that just failed) says when it
 * resets; failing that, the error text itself.
 */
export function usageLimitOfFailure(
  events: ReadonlyArray<{ type?: string; resetsAt?: string | null; window?: string }>,
  errorMessage: string,
): UsageLimit | null {
  if (!isUsageLimitText(errorMessage)) return null;
  let latest: UsageLimit | null = null;
  for (const event of events) {
    if (event.type === 'run_failed') latest = null;
    else if (event.type === 'usage_limit') {
      latest = { resetsAt: event.resetsAt ?? null, ...(event.window ? { window: event.window } : {}) };
    }
  }
  return latest ?? { resetsAt: resetFromText(errorMessage) };
}
