import { describe, expect, it } from 'vitest';

import { conflictingRun, type RunProbe } from '../electron/services/busy';

const REPO = '/w/invest-track';

const probe = (runId: string, over: Partial<NonNullable<RunProbe['info']>> = {}, reason: RunProbe['reason'] = 'running'): RunProbe => ({
  runId, reason, info: { repoPath: REPO, isolation: 'in-place', rootRunId: runId, task: `task of ${runId}`, ...over },
});
const justStarted = (runId: string): RunProbe => ({ runId, reason: 'running', info: null });

describe('a task that works in the user\'s own repository', () => {
  const scope = { isolation: 'in-place' as const };

  it('waits for another one that does - they would switch each other\'s branch', () => {
    expect(conflictingRun([probe('A')], REPO, scope)).toEqual({ runId: 'A', reason: 'running', task: 'task of A' });
  });

  it('waits for a run that is parked at a gate, and says so', () => {
    expect(conflictingRun([probe('A', {}, 'waiting')], REPO, scope)).toMatchObject({ runId: 'A', reason: 'waiting' });
  });

  it('does not wait for a task in a checkout of its own - it does not touch the repository', () => {
    expect(conflictingRun([probe('A', { isolation: 'worktree' })], REPO, scope)).toBeNull();
  });

  it('does not wait for a run in another repository', () => {
    expect(conflictingRun([probe('A', { repoPath: '/w/other' })], REPO, scope)).toBeNull();
  });

  it('waits for a run that has only just started: nothing is known about it, and it may be in the repository', () => {
    expect(conflictingRun([justStarted('A')], REPO, scope)).toEqual({ runId: 'A', reason: 'running' });
  });
});

describe('a task in a checkout of its own', () => {
  const fresh = { isolation: 'worktree' as const };

  it('waits for nothing: another task, in the repository or not, does not share its checkout', () => {
    expect(conflictingRun([probe('A'), probe('B', { isolation: 'worktree' }), probe('C', {}, 'waiting')], REPO, fresh)).toBeNull();
  });

  it('is not held up by a run that has only just started - a new task cannot share anything with it', () => {
    expect(conflictingRun([justStarted('A')], REPO, fresh)).toBeNull();
  });
});

describe('a further round of a task', () => {
  const round = { isolation: 'worktree' as const, rootRunId: 'ROOT' };

  it('waits for another run of the same task - they share its one checkout', () => {
    expect(conflictingRun([probe('R2', { isolation: 'worktree', rootRunId: 'ROOT' })], REPO, round)).toMatchObject({ runId: 'R2' });
    expect(conflictingRun([probe('R2', { isolation: 'worktree', rootRunId: 'ROOT' }, 'waiting')], REPO, round)).toMatchObject({ reason: 'waiting' });
  });

  it('does not wait for a run of another task', () => {
    expect(conflictingRun([probe('X', { isolation: 'worktree', rootRunId: 'OTHER' })], REPO, round)).toBeNull();
  });

  it('waits for a run that has only just started: it may well be a round of this task', () => {
    expect(conflictingRun([justStarted('A')], REPO, round)).toEqual({ runId: 'A', reason: 'running' });
  });

  it('is in the way of its own task wherever it works: a task started in place and continued in place', () => {
    const inPlaceRound = { isolation: 'in-place' as const, rootRunId: 'ROOT' };

    expect(conflictingRun([probe('R2', { isolation: 'in-place', rootRunId: 'ROOT' })], REPO, inPlaceRound)).toMatchObject({ runId: 'R2' });
    expect(conflictingRun([probe('R2', { isolation: 'worktree', rootRunId: 'OTHER' })], REPO, inPlaceRound)).toBeNull();
  });
});

describe('what it reports', () => {
  it('names the first run that is in the way, and carries what it is for', () => {
    const found = conflictingRun([probe('A', { repoPath: '/w/other' }), probe('B'), probe('C')], REPO, { isolation: 'in-place' });

    expect(found).toEqual({ runId: 'B', reason: 'running', task: 'task of B' });
  });

  it('compares folders, not spellings of them', () => {
    expect(conflictingRun([probe('A', { repoPath: '/w/invest-track/' })], '/w/./invest-track', { isolation: 'in-place' })).toMatchObject({ runId: 'A' });
  });

  it('is nothing when nothing is running', () => {
    expect(conflictingRun([], REPO, { isolation: 'in-place' })).toBeNull();
  });
});
