import { describe, expect, it } from 'vitest';

import { branchNameProblem } from '../shared/gitRef';
import { inferInterruption } from '../shared/runInference';
import { formatDuration } from '../src/lib/format';

describe('branchNameProblem', () => {
  it.each([
    'factory/f0042/feat-design-tokens',
    'feature/ui-modernization-phase-1',
    'fix/token-refresh-race',
  ])('accepts %s', (name) => {
    expect(branchNameProblem(name)).toBeNull();
  });

  it.each([
    ['', 'empty'],
    [' leading', 'space'],
    ['has space', 'spaces'],
    ['a..b', '..'],
    ['a~b', '~'],
    ['-dash', '-'],
    ['/start', '/'],
    ['end/', '/'],
    ['a//b', '//'],
    ['ends.', '.'],
    ['topic.lock', '.lock'],
    ['a/.hidden', 'start with "."'],
    ['a@{b', '@{'],
  ])('rejects %j (%s)', (name) => {
    expect(branchNameProblem(name)).not.toBeNull();
  });
});

describe('formatDuration', () => {
  it.each([
    [-5, '0s'],
    [2500, '2.5s'],
    [12_000, '12s'],
    [83_000, '1m 23s'],
    [120_000, '2m'],
    [3_900_000, '1h 5m'],
    [7_200_000, '2h'],
    [8_130_000, '2h 15m 30s'],
  ])('%d ms is %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('inferInterruption', () => {
  const event = (type: string, extra: Record<string, unknown> = {}) => ({ at: 't', type, ...extra });

  it('says so when nothing was recorded', () => {
    expect(inferInterruption([]).message).toContain('before it recorded any progress');
  });

  it('blames the delivery when the run died after its approval was answered', () => {
    const result = inferInterruption([event('run_suspended', { reason: 'DELIVERY_APPROVAL_REQUIRED' })]);
    expect(result.failedStep).toBe('pull-request');
    expect(result.message).toContain('The delivery step is the likely culprit');
  });

  it('says retrying is harmless when only the closing record is missing', () => {
    const result = inferInterruption([event('step_artifact', { step: 'delivery', status: 'PR_CREATED' })]);
    expect(result.message).toContain('Nothing needs to be redone');
  });

  it('names the step a run stopped after', () => {
    const result = inferInterruption([event('step_artifact', { step: 'qa-tester', status: 'FAIL' })]);
    expect(result.message).toContain('stopped right after the QA step');
  });
});
