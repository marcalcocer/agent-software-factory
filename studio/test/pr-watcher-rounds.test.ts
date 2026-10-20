import { describe, expect, it } from 'vitest';

import {
  PrWatcher,
  type RoundInfo,
  type WatcherDeps,
  type WatcherMemory,
} from '../electron/services/pr-watcher';
import type { PrComment, PrFeedbackSummary } from '../shared/types';

/**
 * The watcher as a whole, with every outside thing replaced: GitHub (`pr-check`), the factory
 * process (`startRun`) and the disk. What matters here is what the card says WHILE a round starts -
 * the factory takes a few seconds to boot, and the card used to keep offering to start the round.
 */
const REPO = '/w/invest-track';
const KEY = `${REPO}#8`;

const comments: PrComment[] = ['c1', 'c2'].map((id) => ({
  id,
  source: 'REVIEW_THREAD',
  author: 'marc',
  body: 'please change this',
  createdAt: '2026-10-19T17:30:00Z',
  fresh: true,
}));

const triage: PrFeedbackSummary = {
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
};

function setup(startRun: WatcherDeps['startRun']) {
  const memory: WatcherMemory = { triageAttempts: {}, reviseAttempts: {}, approvals: {} };
  let rounds: RoundInfo[] = [];
  let alive = false;
  const states: Array<{ status: string; message: string; revisionRunId: string | null | undefined }> = [];

  const deps: WatcherDeps = {
    async runCli(args) {
      if (args[0] !== 'pr-check') return { code: 0, stdout: '', stderr: '' };
      const payload = {
        checkedAt: new Date().toISOString(),
        watching: 1,
        backfilled: 0,
        pullRequests: [
          {
            key: KEY, repoPath: REPO, repoName: 'invest-track', number: 8, url: 'https://github.com/o/r/pull/8',
            title: 'PR', headBranch: 'factory/f0001/feat-x', baseBranch: 'master', rootRunId: 'R1', latestRunId: 'R1',
            round: 1, state: 'OPEN', pending: comments, headSha: 'abc',
          },
        ],
      };
      return { code: 0, stdout: `PR_CHECK_JSON ${JSON.stringify(payload)}\n`, stderr: '' };
    },
    startRun: async (args, options) => {
      const result = await startRun(args, options);
      alive = true;
      rounds = [{ runId: result.runId, round: 2, status: 'RUNNING' }];
      return result;
    },
    findBusyRun: () => null,
    isRunActive: () => alive,
    listRounds: () => rounds,
    latestTriage: () => triage,
    isClean: async () => true,
    isDryRun: () => false,
    loadSettings: () => ({ autoRevise: false }), // the test starts the round by hand
    saveSettings: () => {},
    loadRepoOverrides: () => undefined,
    saveRepoOverrides: () => {},
    loadMemory: () => memory,
    saveMemory: () => {},
    emit: (state) => {
      const card = state.pullRequests[0];
      if (card) states.push({ status: card.status, message: card.message, revisionRunId: card.revisionRunId });
    },
    now: () => Date.now(),
  };
  return { watcher: new PrWatcher(deps), states };
}

const card = (watcher: PrWatcher) => watcher.getState().pullRequests[0]!;
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('what the card says while a round starts', () => {
  it('stops offering to start the round the moment it is being started', async () => {
    let finishBoot!: (value: { runId: string }) => void;
    const { watcher } = setup(() => new Promise((resolve) => (finishBoot = resolve)));

    await watcher.refresh({ automate: false });
    expect(card(watcher)).toMatchObject({ status: 'triaged' }); // "start round 2" is on offer

    const started = watcher.revise(KEY, { task: 'Do the thing.' });
    await tick(); // the factory process is booting: it has not named its run yet

    expect(card(watcher)).toMatchObject({ status: 'revising', message: 'Starting round 2...', revisionRunId: null });

    finishBoot({ runId: 'R2' });
    await started;
    expect(card(watcher)).toMatchObject({ status: 'revising', revisionRunId: 'R2', message: 'Round 2 is addressing the review comments.' });
  });

  it('never goes back to offering the start while the round boots, however often the picture is refreshed', async () => {
    let finishBoot!: (value: { runId: string }) => void;
    const { watcher, states } = setup(() => new Promise((resolve) => (finishBoot = resolve)));
    await watcher.refresh({ automate: false });

    const started = watcher.revise(KEY);
    await tick();
    await watcher.refresh({ automate: false }); // a poll lands in the middle of the boot
    await watcher.refresh({ automate: false });
    finishBoot({ runId: 'R2' });
    await started;

    const afterStart = states.slice(states.findIndex((s) => s.message === 'Starting round 2...'));
    expect(afterStart.map((s) => s.status)).not.toContain('triaged');
  });

  it('says what went wrong, and offers the round again, when it could not be started', async () => {
    const { watcher } = setup(async () => {
      throw new Error('no runId generated');
    });
    await watcher.refresh({ automate: false });

    await expect(watcher.revise(KEY)).rejects.toThrow('Could not start the round: no runId generated');

    expect(card(watcher).status).toBe('error');
    expect(card(watcher).message).toContain('Could not start the round');
    expect(card(watcher).message).not.toContain('Starting round');
  });

  it('refuses a second start while the first is booting', async () => {
    let finishBoot!: (value: { runId: string }) => void;
    const { watcher } = setup(() => new Promise((resolve) => (finishBoot = resolve)));
    await watcher.refresh({ automate: false });

    const first = watcher.revise(KEY);
    await tick();
    await expect(watcher.revise(KEY)).rejects.toThrow(/already/);

    finishBoot({ runId: 'R2' });
    await first;
  });
});
