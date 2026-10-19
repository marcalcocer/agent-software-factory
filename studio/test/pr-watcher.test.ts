import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PR_WATCH_SETTINGS,
  classifyPullRequest,
  mergeStatusOf,
  nameOfRun,
  normalizePrWatchSettings,
  normalizeRepoOverrides,
  normalizeRepoOverridesMap,
  parseMarkerLine,
  summarizeFailure,
  triageCovers,
  type ClassifyInput,
  type RoundInfo,
} from '../electron/services/pr-watcher';
import type { PrCheckPullRequest, PrComment, PrFeedbackSummary } from '../shared/types';

const comment = (id: string, over: Partial<PrComment> = {}): PrComment => ({
  id,
  source: 'REVIEW_THREAD',
  author: 'marc',
  body: 'please change this',
  createdAt: '2026-10-19T17:30:00Z',
  fresh: true,
  ...over,
});

const pullRequest = (pending: PrComment[] = [], over: Partial<PrCheckPullRequest> = {}): PrCheckPullRequest => ({
  key: '/r/invest-track#8',
  repoPath: '/r/invest-track',
  repoName: 'invest-track',
  number: 8,
  url: 'https://github.com/o/r/pull/8',
  title: 'A pull request',
  headBranch: 'factory/f0001/feat-x',
  baseBranch: 'master',
  rootRunId: 'R1',
  latestRunId: 'R1',
  round: 1,
  state: 'OPEN',
  pending,
  headSha: 'abc1234',
  ...over,
});

const triage = (over: Partial<PrFeedbackSummary> = {}): PrFeedbackSummary => ({
  runId: 'T1',
  pullRequest: 8,
  pullRequestUrl: 'https://github.com/o/r/pull/8',
  action: 'RERUN_IMPLEMENTATION',
  summary: 'Code changes are needed.',
  commentsTriaged: 2,
  repliesPosted: 0,
  followUpTask: 'Do the thing.',
  blockers: [],
  headBranch: 'factory/f0001/feat-x',
  baseBranch: 'master',
  items: [],
  commentIds: ['c1', 'c2'],
  ...over,
});

const classify = (over: Partial<ClassifyInput> = {}) =>
  classifyPullRequest({
    pr: pullRequest(),
    inFlightTriage: false,
    jobError: undefined,
    rounds: [],
    triage: null,
    busy: null,
    attemptedRevise: undefined,
    settings: DEFAULT_PR_WATCH_SETTINGS,
    ...over,
  });

const round = (over: Partial<RoundInfo> = {}): RoundInfo => ({ runId: 'R2', round: 2, status: 'RUNNING', ...over });

const two = [comment('c1'), comment('c2')];

describe('classifyPullRequest: comments nobody has looked at', () => {
  it('is idle when there is nothing to deal with', () => {
    expect(classify()).toMatchObject({ status: 'idle', message: 'No unhandled review comments.' });
  });

  it('asks for a look at new comments', () => {
    expect(classify({ pr: pullRequest([comment('c1')]) })).toMatchObject({
      status: 'pending',
      message: '1 new comment to look at.',
    });
  });

  it('lists comments written before the factory watched, without acting on them', () => {
    const result = classify({ pr: pullRequest([comment('c1', { fresh: false })]) });
    expect(result.status).toBe('pending');
    expect(result.message).toContain('1 older comment');
    expect(result.message).toContain('written before the factory started watching');
  });

  it('says the comments are being read while a triage is under way', () => {
    expect(classify({ pr: pullRequest(two), inFlightTriage: true })).toMatchObject({
      status: 'triaging',
      message: 'Reading 2 comments...',
    });
  });

  it('reports an error from checking the pull request', () => {
    expect(classify({ pr: pullRequest([], { error: 'gh: not found' }) })).toMatchObject({
      status: 'error',
      message: 'Could not check this pull request: gh: not found',
    });
  });

  it('reports a failed job for exactly these comments, but not for different ones', () => {
    const jobError = { message: 'Triage failed: boom', signature: 'c1,c2' };
    expect(classify({ pr: pullRequest(two), jobError })).toMatchObject({ status: 'error', message: 'Triage failed: boom' });
    expect(classify({ pr: pullRequest([comment('c9')]), jobError }).status).toBe('pending');
  });
});

describe('classifyPullRequest: comments that have been triaged', () => {
  it('says a round will start by itself when automation is on', () => {
    const result = classify({ pr: pullRequest(two), triage: triage() });
    expect(result.status).toBe('triaged');
    expect(result.message).toBe('2 comments need code changes - a round will start automatically.');
    expect(result.triage?.runId).toBe('T1');
  });

  it('asks the user to start the round when automation is off', () => {
    const settings = { ...DEFAULT_PR_WATCH_SETTINGS, autoRevise: false };
    expect(classify({ pr: pullRequest(two), triage: triage(), settings }).message).toBe(
      '2 comments need code changes - start a round to address them.',
    );
  });

  it('ignores a triage that does not cover every pending comment', () => {
    // A new comment arrived after the triage: acting on the old one would skip it.
    const result = classify({ pr: pullRequest([...two, comment('c3')]), triage: triage() });
    expect(result.status).toBe('pending');
    expect(result.triage).toBeNull();
  });

  it('waits for another run that uses the same working copy, and names it', () => {
    const busy = { runId: 'X9', reason: 'running' as const, task: 'Add pagination to the positions endpoint' };
    const result = classify({ pr: pullRequest(two), triage: triage(), busy });
    expect(result.status).toBe('triaged');
    expect(result.message).toContain('"Add pagination to the positions endpoint" (run X9)');
    expect(result.message).toContain('to finish');
    expect(classify({ pr: pullRequest(two), triage: triage(), busy: { ...busy, reason: 'waiting' } }).message).toContain(
      'to be approved or closed',
    );
  });

  it('leaves a decision to a human when the triage found a blocker', () => {
    const blocked = triage({ blockers: ['The reviewer asks to delete a test.'] });
    expect(classify({ pr: pullRequest(two), triage: blocked }).message).toBe(
      'A human has to decide first: The reviewer asks to delete a test.',
    );
    expect(classify({ pr: pullRequest(two), triage: triage({ action: 'ESCALATE_HUMAN', summary: 'Contradictory.' }) }).message).toBe(
      'A human has to decide first: Contradictory.',
    );
  });

  it('needs no round for questions and notes', () => {
    const result = classify({ pr: pullRequest(two), triage: triage({ action: 'REPLY_ONLY' }) });
    expect(result.message).toBe('No code changes needed - these are questions or notes.');
  });
});

describe('classifyPullRequest: a round', () => {
  it('is revising while the round runs', () => {
    expect(classify({ pr: pullRequest(two), rounds: [round()] })).toMatchObject({
      status: 'revising',
      revisionRunId: 'R2',
      message: 'Round 2 is addressing the review comments.',
    });
  });

  it('asks for the push to be approved when the round waits at the delivery gate', () => {
    const waiting = round({ status: 'SUSPENDED', waitingFor: 'DELIVERY_APPROVAL_REQUIRED' });
    expect(classify({ pr: pullRequest(two), rounds: [waiting] })).toMatchObject({ status: 'awaiting-approval' });
  });

  it('is blocked, and not retryable, when the round waits for any other answer', () => {
    const waiting = round({ status: 'SUSPENDED', waitingFor: 'ESCALATION_REQUIRED' });
    const result = classify({ pr: pullRequest(two), rounds: [waiting] });
    expect(result.status).toBe('blocked');
    expect(result.retryable).toBeUndefined();
  });

  it('counts a round whose process runs but has not written its record yet', () => {
    const result = classify({ pr: pullRequest(two), triage: triage(), starting: { runId: 'R2', round: 2 } });
    expect(result).toMatchObject({ status: 'revising', revisionRunId: 'R2' });
  });

  it('can be started again after the round for exactly these comments failed', () => {
    const result = classify({
      pr: pullRequest(two),
      triage: triage(),
      rounds: [round({ status: 'FAILED', error: 'usage limit reached' })],
      attemptedRevise: 'c1,c2',
    });
    expect(result).toMatchObject({ status: 'blocked', retryable: true, revisionRunId: 'R2' });
    expect(result.message).toContain('Round 2 failed: usage limit reached');
  });

  it('says so when the round finished but the comments are still open', () => {
    const result = classify({
      pr: pullRequest(two),
      triage: triage(),
      rounds: [round({ status: 'DELIVERED_WITHOUT_PR' })],
      attemptedRevise: 'c1,c2',
    });
    expect(result.status).toBe('triaged');
    expect(result.message).toContain('nothing was pushed');
  });
});

describe('triageCovers', () => {
  it('needs every pending comment to be in the triage', () => {
    expect(triageCovers(triage(), [comment('c1'), comment('c2')])).toBe(true);
    expect(triageCovers(triage(), [comment('c1'), comment('c3')])).toBe(false);
  });

  it('covers nothing when there is no triage or nothing pending', () => {
    expect(triageCovers(null, two)).toBe(false);
    expect(triageCovers(triage(), [])).toBe(false);
  });
});

describe('mergeStatusOf', () => {
  const approval = { headSha: 'abc1234', approvedAt: '2026-10-19T17:50:00Z' };

  it('counts an approval of the commit that is on GitHub now', () => {
    expect(mergeStatusOf(pullRequest(), approval)).toMatchObject({ approval, approvalOutdated: false, blockers: [] });
  });

  it('does not count an approval given for an earlier commit, and says it is outdated', () => {
    const status = mergeStatusOf(pullRequest([], { headSha: 'def5678' }), approval);
    expect(status.approval).toBeNull();
    expect(status.approvalOutdated).toBe(true);
  });

  it('is not outdated when nothing was ever approved', () => {
    expect(mergeStatusOf(pullRequest(), undefined)).toMatchObject({ approval: null, approvalOutdated: false });
  });

  it('refuses to merge what GitHub has not reported a commit for', () => {
    const { headSha: _omit, ...withoutSha } = pullRequest();
    const status = mergeStatusOf(withoutSha as PrCheckPullRequest, undefined);
    expect(status.headSha).toBeNull();
    expect(status.blockers[0]).toContain('has not reported the latest commit');
  });

  it('passes on what the factory judged about the merge', () => {
    const status = mergeStatusOf(pullRequest([], { mergeBlockers: ['It has conflicts with master.'], mergeWarnings: ['1 check is failing.'] }), undefined);
    expect(status).toMatchObject({ blockers: ['It has conflicts with master.'], warnings: ['1 check is failing.'] });
  });
});

describe('settings', () => {
  it('keeps the interval inside its limits', () => {
    expect(normalizePrWatchSettings({ intervalSeconds: 5 }).intervalSeconds).toBe(30);
    expect(normalizePrWatchSettings({ intervalSeconds: 99_999 }).intervalSeconds).toBe(3600);
    expect(normalizePrWatchSettings({ intervalSeconds: Number.NaN }).intervalSeconds).toBe(60);
  });

  it('never turns on replies on GitHub unless it is literally true', () => {
    expect(normalizePrWatchSettings({}).replyOnGitHub).toBe(false);
    expect(normalizePrWatchSettings({ replyOnGitHub: 'yes' as never }).replyOnGitHub).toBe(false);
    expect(normalizePrWatchSettings({ replyOnGitHub: true }).replyOnGitHub).toBe(true);
  });

  it('keeps only real booleans as per-repository overrides', () => {
    expect(normalizeRepoOverrides({ autoRevise: false, autoTriage: 'no', replyOnGitHub: null, other: true })).toEqual({
      autoRevise: false,
    });
    expect(normalizeRepoOverridesMap({ a: { autoRevise: false }, b: { autoRevise: 'x' }, c: 'nope' })).toEqual({
      a: { autoRevise: false },
    });
  });
});

describe('reading what the factory printed', () => {
  it('takes the last line that carries the marker, ignoring log noise around it', () => {
    const stdout = ['starting', 'PR_CHECK_JSON {"n":1}', 'noise', 'PR_CHECK_JSON {"n":2}', 'bye'].join('\n');
    expect(parseMarkerLine<{ n: number }>(stdout, 'PR_CHECK_JSON')).toEqual({ n: 2 });
  });

  it('returns null when the marker is missing or its JSON is broken', () => {
    expect(parseMarkerLine('nothing here', 'PR_CHECK_JSON')).toBeNull();
    expect(parseMarkerLine('PR_CHECK_JSON {oops', 'PR_CHECK_JSON')).toBeNull();
  });

  it('summarises a failure with its last meaningful line', () => {
    const result = {
      code: 1,
      stdout: 'PR_CHECK_JSON {"error":"x"}\n',
      stderr: 'warming up\nGraphQL: Could not resolve to a PullRequest\n    at run (file.ts:1:1)\ntrace_id: abc\n',
    };
    expect(summarizeFailure(result)).toBe('GraphQL: Could not resolve to a PullRequest');
    expect(summarizeFailure({ code: 3, stdout: '', stderr: '' })).toBe('The command failed (exit 3).');
  });

  it('names a run by its task when it is known', () => {
    expect(nameOfRun({ runId: 'X1', reason: 'running' })).toBe('run X1');
    expect(nameOfRun({ runId: 'X1', reason: 'running', task: 'Short task' })).toBe('"Short task" (run X1)');
    const long = nameOfRun({ runId: 'X1', reason: 'running', task: 'word '.repeat(30) });
    expect(long).toContain('...');
    expect(long.length).toBeLessThan(90);
  });
});
