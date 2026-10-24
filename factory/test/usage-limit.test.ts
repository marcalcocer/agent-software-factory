import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { isUsageLimitText, limitFromStream, resetFromText, usageLimitOfFailure, windowLabel } from '../src/utils/usage-limit.ts';

/** A `rate_limit_event` exactly as the Claude Code CLI writes it (recorded 2026-10-24). */
const event = (status: string, resetsAt = 1792862400, rateLimitType = 'five_hour') =>
  JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      status,
      resetsAt,
      rateLimitType,
      overageStatus: 'rejected',
      isUsingOverage: false,
      unifiedWindows: { five_hour: { utilization: 1, resetsAt, status }, seven_day: { utilization: 0, resetsAt: 1793451600, status: 'allowed' } },
    },
    session_id: 's',
  });

describe('the reset time, from the CLI stream', () => {
  it('reads when the window resets and which window it is', () => {
    const stdout = ['{"type":"system","subtype":"init"}', event('rejected'), '{"type":"result","is_error":true}'].join('\n');
    expect(limitFromStream(stdout)).toEqual({ resetsAt: '2026-10-24T17:20:00.000Z', window: 'five_hour', rejected: true });
  });

  it('prefers the event that refused the call over a later one that did not', () => {
    const stdout = [event('rejected', 1792862400), event('allowed_warning', 1793451600, 'seven_day')].join('\n');
    expect(limitFromStream(stdout)).toMatchObject({ window: 'five_hour', rejected: true });
  });

  it('is null when the stream says nothing about limits', () => {
    expect(limitFromStream('{"type":"result"}\nnot json')).toBeNull();
  });

  it('the transcripts recorded for the live activity carry no limit event (they were sanitised)', () => {
    const dir = path.join(import.meta.dirname, '..', '..', 'fixtures', 'claude-stream');
    expect(limitFromStream(fs.readFileSync(path.join(dir, 'read-and-report.ndjson'), 'utf8'))).toBeNull();
  });
});

describe('the reset time, from an error text', () => {
  const now = new Date(2026, 9, 24, 15, 30); // local time, 15:30

  it('reads an epoch suffix, an ISO date, "resets in", and a clock time', () => {
    expect(resetFromText('Claude AI usage limit reached|1792862400', now)).toBe('2026-10-24T17:20:00.000Z');
    expect(resetFromText('limit reached, resets at 2026-10-25T03:00:00Z', now)).toBe('2026-10-25T03:00:00.000Z');
    expect(resetFromText('resets in 2 hours 5 minutes', now)).toBe(new Date(now.getTime() + 125 * 60_000).toISOString());
    expect(resetFromText("You've hit your limit · resets 10pm", now)).toBe(new Date(2026, 9, 24, 22, 0).toISOString());
    expect(resetFromText('5-hour limit reached ∙ resets at 9:15 am', now)).toBe(new Date(2026, 9, 25, 9, 15).toISOString());
    expect(resetFromText('something else entirely', now)).toBeNull();
  });
});

describe('the usage limit behind a failure', () => {
  const limitError = 'Agent "developer" failed during step "developer" [claude-cli/rate-limit]: Claude subscription usage limit reached.';

  it('takes the reset time from the attempt that just failed', () => {
    const events = [
      { type: 'usage_limit', resetsAt: '2026-10-24T12:00:00.000Z', window: 'five_hour' },
      { type: 'run_failed' },
      { type: 'agent_call' },
      { type: 'usage_limit', resetsAt: '2026-10-24T17:20:00.000Z', window: 'five_hour' },
    ];
    expect(usageLimitOfFailure(events, limitError)).toEqual({ resetsAt: '2026-10-24T17:20:00.000Z', window: 'five_hour' });
  });

  it('is null for a failure that is not a usage limit, whatever happened before', () => {
    const events = [{ type: 'usage_limit', resetsAt: '2026-10-24T17:20:00.000Z' }];
    expect(usageLimitOfFailure(events, 'Target repository has uncommitted changes')).toBeNull();
  });

  it('falls back to the error text, and to an unknown reset time', () => {
    expect(usageLimitOfFailure([], `${limitError} resets in 1 hour`)!.resetsAt).not.toBeNull();
    expect(usageLimitOfFailure([], limitError)).toEqual({ resetsAt: null });
  });

  it('names the windows', () => {
    expect(windowLabel('five_hour')).toBe('5-hour');
    expect(windowLabel('seven_day')).toBe('weekly');
    expect(windowLabel(undefined)).toBe('usage');
    expect(isUsageLimitText('Claude subscription usage limit reached')).toBe(true);
    expect(isUsageLimitText('Authentication required')).toBe(false);
  });
});
