// @vitest-environment jsdom
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_TRIES,
  RETRY_MARGIN_MS,
  UNKNOWN_RESET_RETRY_MS,
  armRetry,
  decideAfterRun,
  isDue,
  postponed,
  readAutoRetry,
  retryTimeFor,
  runDueRetries,
  startedRetry,
  writeAutoRetry,
} from '../electron/services/auto-retry';
import { readRunState } from '../electron/services/run-state';
import { UsageLimitRetry } from '../src/components/UsageLimitRetry';
import { countdown, retryView, windowLabel } from '../shared/usageLimit';
import type { AutoRetryState, FactoryRun } from '../shared/types';
import { installFakeApi } from './support/fake-api';

const NOW = Date.parse('2026-10-24T16:00:00.000Z');
const RESET = '2026-10-24T17:20:00.000Z';
const limited = (over: Partial<FactoryRun> = {}) =>
  ({ status: 'FAILED', kind: 'run', usageLimit: { resetsAt: RESET, window: 'five_hour' }, ...over }) as FactoryRun;
const plan = (over: Partial<AutoRetryState> = {}): AutoRetryState => ({
  status: 'scheduled',
  retryAt: '2026-10-24T17:21:00.000Z',
  resetsAt: RESET,
  window: 'five_hour',
  tries: 0,
  updatedAt: new Date(NOW).toISOString(),
  ...over,
});

afterEach(() => vi.useRealTimers());

describe('when to retry', () => {
  it('a minute after the reset; never in the past; every half hour when the reset is unknown', () => {
    expect(retryTimeFor(RESET, NOW)).toBe(new Date(Date.parse(RESET) + RETRY_MARGIN_MS).toISOString());
    expect(retryTimeFor('2026-10-24T10:00:00.000Z', NOW)).toBe(new Date(NOW + 60_000).toISOString());
    expect(retryTimeFor(null, NOW)).toBe(new Date(NOW + UNKNOWN_RESET_RETRY_MS).toISOString());
  });

  it('even for a weekly limit days away', () => {
    expect(retryTimeFor('2026-10-30T09:00:00.000Z', NOW)).toBe('2026-10-30T09:01:00.000Z');
  });
});

describe('what to do when a run ends', () => {
  it('plans the retry of a run stopped by the limit, when the setting is on', () => {
    const decision = decideAfterRun(limited(), null, true, NOW);
    expect(decision).toEqual({ action: 'schedule', state: plan() });
  });

  it('leaves it to the user when the setting is off, or the user cancelled it', () => {
    expect(decideAfterRun(limited(), null, false, NOW)).toEqual({ action: 'keep' });
    expect(decideAfterRun(limited(), plan({ status: 'cancelled' }), true, NOW)).toEqual({ action: 'keep' });
  });

  it('keeps retrying a run the user armed by hand, even with the setting off', () => {
    const decision = decideAfterRun(limited(), plan({ status: 'retrying', tries: 1 }), false, NOW);
    expect(decision).toMatchObject({ action: 'schedule', state: { status: 'scheduled', tries: 1 } });
  });

  it('gives up after too many automatic retries that hit the limit again', () => {
    const decision = decideAfterRun(limited(), plan({ status: 'retrying', tries: MAX_TRIES }), true, NOW);
    expect(decision).toMatchObject({ action: 'schedule', state: { status: 'gave-up' } });
  });

  it('forgets the plan once the run got past the limit, or failed for another reason', () => {
    expect(decideAfterRun({ status: 'DELIVERED_WITHOUT_PR', kind: 'run' } as FactoryRun, plan({ status: 'retrying' }), true, NOW)).toEqual({ action: 'clear' });
    expect(decideAfterRun({ status: 'FAILED', kind: 'run' } as FactoryRun, plan({ status: 'retrying' }), true, NOW)).toEqual({ action: 'clear' });
    expect(decideAfterRun({ status: 'FAILED', kind: 'run' } as FactoryRun, null, true, NOW)).toEqual({ action: 'keep' });
  });

  it('never plans the retry of a pull-request triage', () => {
    expect(decideAfterRun(limited({ kind: 'pr-feedback' }), null, true, NOW)).toEqual({ action: 'keep' });
  });
});

describe('the plan over time', () => {
  it('is due at its time, counts its tries, and can be put off', () => {
    expect(isDue(plan(), NOW)).toBe(false);
    expect(isDue(plan(), Date.parse('2026-10-24T17:21:00.000Z'))).toBe(true);
    expect(isDue(plan({ status: 'cancelled', retryAt: '2026-10-24T00:00:00.000Z' }), NOW)).toBe(false);
    expect(startedRetry(plan(), NOW)).toMatchObject({ status: 'retrying', tries: 1 });
    expect(postponed(plan(), NOW).retryAt).toBe(new Date(NOW + 120_000).toISOString());
    expect(armRetry(limited(), NOW)).toMatchObject({ status: 'scheduled', tries: 0, resetsAt: RESET });
    expect(armRetry({ usageLimit: undefined }, NOW)).toBeNull();
  });
});

describe('a run that stopped on the limit, read from disk', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('carries the limit and the retry plan', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limited-run-'));
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ runId: 'R1', task: 'Dark mode', repoPath: '/home/dev/workspace/app' }));
    fs.writeFileSync(
      path.join(dir, 'summary.json'),
      JSON.stringify({ runId: 'R1', status: 'FAILED', task: 'Dark mode', repository: '/home/dev/workspace/app', error: 'Claude subscription usage limit reached.', usageLimit: { resetsAt: RESET, window: 'five_hour' } }),
    );
    writeAutoRetry(dir, plan());
    const state = readRunState(dir, 'R1', false)!;
    expect(state.run.status).toBe('FAILED');
    expect(state.run.usageLimit).toEqual({ resetsAt: RESET, window: 'five_hour' });
    expect(state.run.autoRetry).toEqual(plan());
    expect(readAutoRetry(dir)).toEqual(plan());

    // While it runs again, it is not "limited".
    expect(readRunState(dir, 'R1', true)!.run.usageLimit).toBeUndefined();
  });
});

describe('the words', () => {
  it('names the window and counts down', () => {
    expect(windowLabel('five_hour')).toBe('5-hour');
    expect(windowLabel('seven_day')).toBe('weekly');
    expect(countdown('2026-10-24T17:21:05.000Z', NOW)).toBe('1h 21m 05s');
    expect(countdown('2026-10-24T16:04:09.000Z', NOW)).toBe('4m 09s');
    expect(countdown('2026-10-27T16:00:00.000Z', NOW)).toBe('3d 0h 00m');
    expect(countdown('2026-10-24T15:00:00.000Z', NOW)).toBe('now');
    expect(retryView({ resetsAt: RESET }, undefined)).toMatchObject({ kind: 'off', reason: 'setting' });
    expect(retryView({ resetsAt: RESET }, plan({ status: 'gave-up', tries: 6 }))).toMatchObject({ kind: 'off', reason: 'gave-up', tries: 6 });
  });
});

describe('the panel of a run that stopped on the limit', () => {
  const run = (autoRetry?: AutoRetryState) => ({ runId: 'R1', usageLimit: { resetsAt: RESET, window: 'five_hour' }, ...(autoRetry ? { autoRetry } : {}) });

  it('counts down to the automatic retry, and can retry now or cancel', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
    const api = installFakeApi({ 'factory:auto-retry-cancel': () => plan({ status: 'cancelled' }) });
    const onRetryNow = vi.fn();
    render(<UsageLimitRetry run={run(plan())} onRetryNow={onRetryNow} />);

    expect(screen.getByTestId('usage-limit').textContent).toContain('5-hour usage limit');
    expect(screen.getByTestId('auto-retry-countdown').textContent).toBe('in 1h 21m 00s');
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId('auto-retry-countdown').textContent).toBe('in 1h 20m 55s');

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByText('▶ Retry now'));
    expect(onRetryNow).toHaveBeenCalled();

    await user.click(screen.getByText('Cancel automatic retry'));
    expect(api.callsTo('factory:auto-retry-cancel')).toEqual([['R1']]);
    expect(await screen.findByTestId('auto-retry-off')).toBeTruthy();
    expect(screen.getByText(/cancelled for this run/)).toBeTruthy();
  });

  it('offers to retry by itself when automatic retry is off', async () => {
    const api = installFakeApi({ 'factory:auto-retry-arm': () => plan() });
    render(<UsageLimitRetry run={run()} onRetryNow={() => {}} />);
    expect(screen.getByText(/Automatic retry is off/)).toBeTruthy();

    await userEvent.setup().click(screen.getByText('⏳ Retry automatically when the limit resets'));
    expect(api.callsTo('factory:auto-retry-arm')).toEqual([['R1']]);
    expect(await screen.findByTestId('auto-retry-scheduled')).toBeTruthy();
  });

  it('shows nothing for a run that did not stop on the limit', () => {
    installFakeApi();
    const { container } = render(<UsageLimitRetry run={{ runId: 'R1' }} />);
    expect(container.textContent).toBe('');
  });
});

describe('in the pipeline view', () => {
  it('a run stopped on the limit says so and shows the automatic retry', async () => {
    const { RUN, runDir } = await import('../../fixtures');
    const { PipelineView } = await import('../src/components/PipelineView');
    const { openingARun } = await import('./support/fake-api');
    const base = readRunState(runDir(RUN.round1), RUN.round1, false)!.run;
    installFakeApi({
      ...openingARun([RUN.round1]),
      'factory:get': () => ({ ...base, status: 'FAILED', error: 'Claude subscription usage limit reached.', failedStep: 'developer', usageLimit: { resetsAt: RESET, window: 'five_hour' }, autoRetry: plan() }),
    });
    render(<PipelineView runId={RUN.round1} isRunning={false} onRetry={() => {}} />);
    expect(await screen.findByText(/Claude Usage Limit Reached/)).toBeTruthy();
    // Not over: the header says it is waiting for the limit, and when it continues.
    expect(screen.getByText("Waiting for Claude's Usage Limit")).toBeTruthy();
    expect(screen.getByText(/it continues by itself at/)).toBeTruthy();
    expect(screen.getByTestId('auto-retry-scheduled').textContent).toContain('Retrying automatically at');
  });
});

describe('the retry loop of the main process', () => {
  const deps = (plans: Record<string, AutoRetryState>, over: Partial<import('../electron/services/auto-retry').RetryLoopDeps> = {}) => {
    const written: Record<string, AutoRetryState> = {};
    const cleared: string[] = [];
    const resumed: string[] = [];
    const announced: string[] = [];
    const d: import('../electron/services/auto-retry').RetryLoopDeps = {
      runIds: () => Object.keys(plans).concat('no-plan'),
      readPlan: (id) => plans[id] ?? null,
      writePlan: (id, state) => void (written[id] = state),
      clearPlan: (id) => void cleared.push(id),
      readRun: () => ({ run: { status: 'FAILED', isolation: 'worktree', rootRunId: 'ROOT' }, repoPath: '/home/dev/workspace/app' }),
      isActive: () => false,
      isBusy: () => false,
      resume: async (id) => void resumed.push(id),
      announce: (id) => void announced.push(id),
      ...over,
    };
    return { d, written, cleared, resumed, announced };
  };
  const due = plan({ retryAt: '2026-10-24T15:59:00.000Z' });

  it('resumes the runs that are due, counts the try, and tells the screen', async () => {
    const { d, written, resumed, announced } = deps({ A: due, B: plan() });
    expect(await runDueRetries(d, NOW)).toEqual(['A']);
    expect(resumed).toEqual(['A']);
    expect(announced).toEqual(['A']);
    expect(written.A).toMatchObject({ status: 'retrying', tries: 1 });
    expect(written.B).toBeUndefined();
  });

  it('puts a retry off while something else works in the same place', async () => {
    const { d, written, resumed } = deps({ A: due }, { isBusy: () => true });
    await runDueRetries(d, NOW);
    expect(resumed).toEqual([]);
    expect(written.A).toMatchObject({ status: 'scheduled', retryAt: new Date(NOW + 120_000).toISOString() });
  });

  it('drops the plan of a run retried by hand meanwhile, and skips one still running', async () => {
    const gone = deps({ A: due }, { readRun: () => ({ run: { status: 'DELIVERED_WITHOUT_PR' }, repoPath: '/x' }) });
    await runDueRetries(gone.d, NOW);
    expect(gone.cleared).toEqual(['A']);
    const running = deps({ A: due }, { isActive: () => true });
    expect(await runDueRetries(running.d, NOW)).toEqual([]);
    expect(running.written.A).toBeUndefined();
  });

  it('tries again in five minutes when the run could not be started', async () => {
    const { d, written } = deps({ A: due }, { resume: async () => { throw new Error('Authentication required'); } });
    await runDueRetries(d, NOW);
    expect(written.A).toMatchObject({ status: 'scheduled', retryAt: new Date(NOW + 5 * 60_000).toISOString() });
  });
});
