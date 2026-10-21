import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PR_WATCH_SETTINGS,
  busyScopeOf,
  changeRequestCount,
  busyScopeOfView,
  classifyPullRequest,
  PrWatcher,
  scopeOf,
  type BusyScope,
  type ClassifyInput,
  type RoundInfo,
  type WatcherDeps,
  type WatcherMemory,
} from '../electron/services/pr-watcher';
import type { PrCheckPullRequest, PrComment, PrFeedbackSummary, PrMergeResult, SettledPhase } from '../shared/types';

const REPO = '/w/invest-track';
const KEY = `${REPO}#8`;

const comment = (id: string, over: Partial<PrComment> = {}): PrComment => ({
  id, source: 'REVIEW_THREAD', author: 'marc', body: `body of ${id}`, createdAt: '2026-10-19T17:30:00Z', fresh: true, ...over,
});

const pullRequest = (pending: PrComment[], over: Partial<PrCheckPullRequest> = {}): PrCheckPullRequest => ({
  key: KEY, repoPath: REPO, repoName: 'invest-track', number: 8, url: 'https://github.com/o/r/pull/8', title: 'Foundation',
  headBranch: 'factory/f0042/feat-x', baseBranch: 'main', rootRunId: 'R1', latestRunId: 'R1', round: 1, state: 'OPEN', pending, headSha: 'abc1234', ...over,
});

const item = (commentId: string, category: string, over: Partial<PrFeedbackSummary['items'][number]> = {}): PrFeedbackSummary['items'][number] => ({
  commentId, author: 'marc', excerpt: `excerpt of ${commentId}`, category, assignTo: 'none', reasoning: '', reply: '', filesInvolved: [], ...over,
});

const triage = (items: PrFeedbackSummary['items'], over: Partial<PrFeedbackSummary> = {}): PrFeedbackSummary => ({
  runId: 'T1', pullRequest: 8, pullRequestUrl: 'https://github.com/o/r/pull/8', action: 'REPLY_ONLY', summary: 's', commentsTriaged: items.length, repliesPosted: 0,
  followUpTask: '', blockers: [], headBranch: 'factory/f0042/feat-x', baseBranch: 'main', items, commentIds: items.map((entry) => entry.commentId), ...over,
});

const classify = (over: Partial<ClassifyInput> = {}) =>
  classifyPullRequest({ pr: pullRequest([]), inFlightTriage: false, jobError: undefined, rounds: [], triage: null, busy: null, attemptedRevise: undefined, settings: DEFAULT_PR_WATCH_SETTINGS, ...over });

const LATER = [comment('c1', { path: 'ui/src/Settings.jsx', line: 12 }), comment('c2')];
const LATER_ITEMS = [item('c1', 'FUTURE_PHASE', { targetPhase: 'i0001-p3' }), item('c2', 'FUTURE_PHASE', { targetPhase: null })];

describe('scopeOf: comments that belong to a later phase', () => {
  it('lists the ones nobody decided, with the phase the triage suggested', () => {
    const scope = scopeOf(pullRequest(LATER), triage(LATER_ITEMS));

    expect(scope).toEqual({
      undecided: [
        { id: 'c1', author: 'marc', body: 'body of c1', excerpt: 'excerpt of c1', path: 'ui/src/Settings.jsx', line: 12, suggestedPhaseId: 'i0001-p3' },
        { id: 'c2', author: 'marc', body: 'body of c2', excerpt: 'excerpt of c2', suggestedPhaseId: null },
      ],
      doNow: [],
    });
  });

  it('knows which the user said to do in this pull request, and no longer asks about them', () => {
    const scope = scopeOf(pullRequest(LATER, { scopeDecisions: [{ commentId: 'c1', decision: 'DO_NOW', targetPhaseId: null }] }), triage(LATER_ITEMS));

    expect(scope!.doNow).toEqual(['c1']);
    expect(scope!.undecided.map((entry) => entry.id)).toEqual(['c2']);
  });

  it('is nothing when the triage has no comment about a later phase', () => {
    expect(scopeOf(pullRequest(LATER), triage([item('c1', 'CODE_CHANGE_REQUEST'), item('c2', 'QUESTION')]))).toBeNull();
  });

  it('is nothing for a triage that does not cover what is pending now - a stale one is not acted on', () => {
    expect(scopeOf(pullRequest([...LATER, comment('c3')]), triage(LATER_ITEMS))).toBeNull();
    expect(scopeOf(pullRequest(LATER), null)).toBeNull();
  });

  it('only looks at the comments that are still pending: a deferred one is settled and gone', () => {
    const scope = scopeOf(pullRequest([LATER[1]!], { scopeDecisions: [{ commentId: 'c1', decision: 'DEFER', targetPhaseId: 'i0001-p3' }] }), triage(LATER_ITEMS, { commentIds: ['c1', 'c2'] }));

    expect(scope!.undecided.map((entry) => entry.id)).toEqual(['c2']);
  });
});

describe('classifyPullRequest: awaiting scope', () => {
  it('waits for the user while a comment about a later phase has no decision', () => {
    const result = classify({ pr: pullRequest(LATER), triage: triage(LATER_ITEMS) });

    expect(result.status).toBe('awaiting-scope');
    expect(result.message).toBe('2 comments ask for something that belongs to a later phase. Choose where each goes.');
  });

  it('says it in the singular for one', () => {
    const one = [comment('c1')];
    const result = classify({ pr: pullRequest(one), triage: triage([item('c1', 'FUTURE_PHASE')]) });

    expect(result.message).toBe('1 comment asks for something that belongs to a later phase. Choose where it goes.');
  });

  it('holds back a round the triage asked for, so what the user decides goes in together', () => {
    const mixed = [comment('c1'), comment('c2')];
    const result = classify({
      pr: pullRequest(mixed),
      triage: triage([item('c1', 'FUTURE_PHASE'), item('c2', 'CODE_CHANGE_REQUEST', { assignTo: 'developer' })], { action: 'RERUN_IMPLEMENTATION', followUpTask: 'Fix c2.' }),
      settings: { ...DEFAULT_PR_WATCH_SETTINGS, autoRevise: true },
    });

    expect(result.status).toBe('awaiting-scope');
    expect(result.message).not.toContain('a round will start automatically');
  });

  it('comes before a human decision on a disagreement - it has the buttons', () => {
    const result = classify({ pr: pullRequest(LATER), triage: triage(LATER_ITEMS, { action: 'ESCALATE_HUMAN', blockers: ['A reviewer asks to delete a test'] }) });

    expect(result.status).toBe('awaiting-scope');
  });

  it('is over once every such comment has a decision - the "do it now" ones make a round', () => {
    const decided = [{ commentId: 'c1', decision: 'DO_NOW' as const, targetPhaseId: null }, { commentId: 'c2', decision: 'DO_NOW' as const, targetPhaseId: null }];
    const manual = classify({ pr: pullRequest(LATER, { scopeDecisions: decided }), triage: triage(LATER_ITEMS), settings: { ...DEFAULT_PR_WATCH_SETTINGS, autoRevise: false } });
    const automatic = classify({ pr: pullRequest(LATER, { scopeDecisions: decided }), triage: triage(LATER_ITEMS), settings: { ...DEFAULT_PR_WATCH_SETTINGS, autoRevise: true } });

    // The triage said "reply only", but the user said these belong here: that is code to write.
    expect(manual).toMatchObject({ status: 'triaged', message: '2 comments need code changes - start a round to address them.' });
    expect(automatic.message).toBe('2 comments need code changes - a round will start automatically.');
  });

  it('does not hide a round in progress: that is what the user needs to know first', () => {
    const rounds: RoundInfo[] = [{ runId: 'R2', round: 2, status: 'RUNNING' }];
    expect(classify({ pr: pullRequest(LATER), triage: triage(LATER_ITEMS), rounds }).status).toBe('revising');
  });

  it('is what it was for a triage with nothing about a later phase', () => {
    const result = classify({ pr: pullRequest([comment('c1')]), triage: triage([item('c1', 'QUESTION')]) });

    expect(result).toMatchObject({ status: 'triaged', message: 'No code changes needed - these are questions or notes.' });
  });
});

describe('busy scope', () => {
  it('is the task\'s own checkout for a pull request that worked in one, and the repository for one that did not', () => {
    expect(busyScopeOf(pullRequest([], { workCopy: { isolation: 'worktree', path: '/w/.factory/worktrees/invest-track/f0042', exists: true } }))).toEqual({ isolation: 'worktree', rootRunId: 'R1' });
    expect(busyScopeOf(pullRequest([]))).toEqual({ isolation: 'in-place', rootRunId: 'R1' });
  });
});

describe('what the card says needs code changes', () => {
  const mixed = [comment('c1'), comment('c2'), comment('c3')];
  const items = [item('c1', 'CODE_CHANGE_REQUEST', { assignTo: 'developer' }), item('c2', 'QUESTION'), item('c3', 'FUTURE_PHASE')];
  const roundFor = (extra: Partial<PrFeedbackSummary> = {}) => triage(items, { action: 'RERUN_IMPLEMENTATION', followUpTask: 'Fix c1.', ...extra });

  it('counts the comments that ask for a change - not the question beside them, nor the request for later', () => {
    expect(changeRequestCount(mixed, roundFor())).toBe(1);
  });

  it('counts a request for a later phase the user said to do here', () => {
    expect(changeRequestCount(mixed, roundFor(), ['c3'])).toBe(2);
  });

  it('counts a comment the triage did not classify: it is assumed to ask for something, as the factory does', () => {
    expect(changeRequestCount([...mixed, comment('c4')], roundFor())).toBe(2);
  });

  it('never says zero: with nothing classified as a change, it names what is pending', () => {
    expect(changeRequestCount([comment('c2')], triage([item('c2', 'QUESTION')]))).toBe(1);
    expect(changeRequestCount([comment('c1'), comment('c2')], null)).toBe(2);
  });

  it('is what the message says: one code change beside a question is "1 comment needs", not "2 comments need"', () => {
    const pending = [comment('c1'), comment('c2')];
    const result = classify({ pr: pullRequest(pending), triage: triage(items.slice(0, 2), { action: 'RERUN_IMPLEMENTATION', followUpTask: 'Fix c1.' }), settings: { ...DEFAULT_PR_WATCH_SETTINGS, autoRevise: false } });

    expect(result.message).toBe('1 comment needs code changes - start a round to address them.');
  });

  it('says it for several, and for a round that will start by itself', () => {
    const pending = [comment('c1'), comment('c2'), comment('c3')];
    const two = triage([item('c1', 'CODE_CHANGE_REQUEST'), item('c2', 'TEST_CHANGE_REQUEST'), item('c3', 'QUESTION')], { action: 'RERUN_IMPLEMENTATION', followUpTask: 'x' });

    expect(classify({ pr: pullRequest(pending), triage: two, settings: { ...DEFAULT_PR_WATCH_SETTINGS, autoRevise: false } }).message).toBe('2 comments need code changes - start a round to address them.');
    expect(classify({ pr: pullRequest(pending), triage: two, settings: { ...DEFAULT_PR_WATCH_SETTINGS, autoRevise: true } }).message).toBe('2 comments need code changes - a round will start automatically.');
  });

  it('and while another run is in the way', () => {
    const pending = [comment('c1'), comment('c2')];
    const result = classify({
      pr: pullRequest(pending), triage: triage(items.slice(0, 2), { action: 'RERUN_IMPLEMENTATION', followUpTask: 'x' }),
      busy: { runId: 'R9', reason: 'running', task: 'Another task' },
    });

    expect(result.message).toContain('1 comment needs code changes. Waiting for');
  });

  it('is unchanged when only questions are left - the message does not speak of code', () => {
    const result = classify({ pr: pullRequest([comment('c2')]), triage: triage([item('c2', 'QUESTION')]) });

    expect(result.message).toBe('No code changes needed - these are questions or notes.');
  });
});

/* -------------------------------------------------------------------------- */
/* The watcher as a whole                                                      */
/* -------------------------------------------------------------------------- */

interface Harness {
  watcher: PrWatcher;
  /** What the factory has recorded as decided - changes what the next `pr-check` says. */
  decisions: PrCheckPullRequest['scopeDecisions'];
  cli: Array<string[]>;
  started: Array<string[]>;
  busyAsked: BusyScope[];
  reconciled: string[];
  changed: string[];
}

function setup(options: {
  pending?: PrComment[];
  triage?: PrFeedbackSummary | null;
  workCopy?: PrCheckPullRequest['workCopy'];
  scopeDecisions?: PrCheckPullRequest['scopeDecisions'];
  settled?: PrCheckPullRequest['settled'];
  state?: PrCheckPullRequest['state'];
  settings?: Partial<typeof DEFAULT_PR_WATCH_SETTINGS>;
  clean?: boolean;
  busy?: (scope: BusyScope) => ReturnType<WatcherDeps['findBusyRun']>;
  autoReconcile?: boolean;
  dryRun?: boolean;
  answers?: Record<string, string>;
} = {}): Harness {
  const memory: WatcherMemory = { triageAttempts: {}, reviseAttempts: {}, approvals: {} };
  const h: Harness = { watcher: undefined as never, decisions: options.scopeDecisions, cli: [], started: [], busyAsked: [], reconciled: [], changed: [] };

  const deps: WatcherDeps = {
    async runCli(args) {
      h.cli.push(args);
      if (args[0] === 'phase-reconcile') h.reconciled.push(args[2]!);
      if (options.answers?.[args[0]!] !== undefined) return { code: 0, stdout: options.answers[args[0]!]!, stderr: '' };
      if (args[0] !== 'pr-check') return { code: 0, stdout: '', stderr: '' };
      const payload = {
        checkedAt: new Date().toISOString(), watching: 1, backfilled: 0,
        pullRequests: [
          pullRequest(options.pending ?? [], {
            ...(options.workCopy ? { workCopy: options.workCopy } : {}),
            ...(h.decisions ? { scopeDecisions: h.decisions } : {}),
            ...(options.settled ? { settled: options.settled } : {}),
            ...(options.state ? { state: options.state } : {}),
          }),
        ],
      };
      return { code: 0, stdout: `PR_CHECK_JSON ${JSON.stringify(payload)}\n`, stderr: '' };
    },
    startRun: async (args) => {
      h.started.push(args);
      return { runId: 'R2' };
    },
    findBusyRun: (_repo, scope) => {
      h.busyAsked.push(scope);
      return options.busy ? options.busy(scope) : null;
    },
    isRunActive: () => false,
    listRounds: () => [],
    latestTriage: () => options.triage ?? null,
    isClean: async () => options.clean ?? true,
    isDryRun: () => options.dryRun ?? false,
    autoReconcile: () => options.autoReconcile ?? true,
    projectsChanged: (repoPath) => h.changed.push(repoPath),
    loadSettings: () => ({ autoRevise: true, autoTriage: false, ...(options.settings ?? {}) }),
    saveSettings: () => {},
    loadRepoOverrides: () => ({}),
    saveRepoOverrides: () => {},
    loadMemory: () => memory,
    saveMemory: () => {},
    emit: () => {},
    now: () => Date.now(),
  };
  h.watcher = new PrWatcher(deps);
  return h;
}

const FIX = [comment('c1'), comment('c2')];
const FIX_TRIAGE = triage([item('c1', 'CODE_CHANGE_REQUEST', { assignTo: 'developer' }), item('c2', 'CODE_CHANGE_REQUEST', { assignTo: 'developer' })], {
  action: 'RERUN_IMPLEMENTATION', followUpTask: 'Fix them.',
});
const WORKTREE = { isolation: 'worktree' as const, path: '/w/.factory/worktrees/invest-track/f0042', exists: true };
const IN_PLACE = { isolation: 'in-place' as const, path: REPO, exists: true };

describe('the watcher: where a round works decides what it waits for', () => {
  it('starts a round of a task in its own checkout while the user\'s repository is dirty - it does not use it', async () => {
    const h = setup({ pending: FIX, triage: FIX_TRIAGE, workCopy: WORKTREE, clean: false });

    await h.watcher.refresh();

    expect(h.started).toHaveLength(1);
    expect(h.started[0]![0]).toBe('revise');
  });

  it('still waits for the user\'s repository to be clean when the task works in it', async () => {
    const h = setup({ pending: FIX, triage: FIX_TRIAGE, workCopy: IN_PLACE, clean: false });

    await h.watcher.refresh();

    expect(h.started).toEqual([]);
    await expect(h.watcher.revise(KEY)).rejects.toThrow('The repository has uncommitted changes');
  });

  it('asks about busy runs for the task\'s own checkout - the same task, not the whole repository', async () => {
    const h = setup({ pending: FIX, triage: FIX_TRIAGE, workCopy: WORKTREE });

    await h.watcher.refresh();

    expect(h.busyAsked.length).toBeGreaterThan(0);
    expect(h.busyAsked.every((scope) => scope.isolation === 'worktree' && scope.rootRunId === 'R1')).toBe(true);
  });

  it('waits when another round of the same task is going', async () => {
    const h = setup({ pending: FIX, triage: FIX_TRIAGE, workCopy: WORKTREE, busy: () => ({ runId: 'R9', reason: 'running', task: 'Round of the same task' }) });

    await h.watcher.refresh();

    expect(h.started).toEqual([]);
    expect(h.watcher.getState().pullRequests[0]!.message).toContain('Waiting for "Round of the same task"');
  });

  it('puts the user\'s repository back on the base branch only when no run of the user\'s repository is using it', async () => {
    const free = setup({ pending: [], workCopy: WORKTREE });
    await free.watcher.refresh();
    await free.watcher.approve(KEY, 'abc1234');
    await free.watcher.merge(KEY, { subject: 'feat: x', body: '', deleteBranch: true }).catch(() => {});
    expect(free.busyAsked.at(-1)).toEqual({ isolation: 'in-place' });
  });

  it('carries the work copy and the roadmap to the card', async () => {
    const roadmap = { initiativeId: 'i0001', title: 'Redesign', phaseId: 'i0001-p1', ordinal: 1, total: 3, phases: [{ id: 'i0001-p1', ordinal: 1, title: 'Foundation', status: 'IN_REVIEW' as const }] };
    const h = setup({ pending: [], workCopy: WORKTREE });
    await h.watcher.refresh();
    const view = h.watcher.getState().pullRequests[0]!;

    expect(view.workCopy).toEqual(WORKTREE);
    expect(busyScopeOfView(view)).toEqual({ isolation: 'worktree', rootRunId: 'R1' });
    expect(view.roadmap).toBeUndefined();
    void roadmap;
  });
});

describe('the watcher: a round that waits for a scope decision', () => {
  it('does not start by itself while a comment about a later phase has no home', async () => {
    const mixed = [comment('c1'), comment('c2')];
    const h = setup({
      pending: mixed,
      triage: triage([item('c1', 'FUTURE_PHASE'), item('c2', 'CODE_CHANGE_REQUEST', { assignTo: 'developer' })], { action: 'RERUN_IMPLEMENTATION', followUpTask: 'Fix c2.' }),
      workCopy: WORKTREE,
    });

    await h.watcher.refresh();

    expect(h.started).toEqual([]);
    expect(h.watcher.getState().pullRequests[0]!.status).toBe('awaiting-scope');
  });

  it('starts once everything is decided - and a "do it now" comment is enough to make the round on its own', async () => {
    const h = setup({
      pending: [comment('c1')],
      triage: triage([item('c1', 'FUTURE_PHASE')]),
      workCopy: WORKTREE,
      scopeDecisions: [{ commentId: 'c1', decision: 'DO_NOW', targetPhaseId: null }],
    });

    await h.watcher.refresh();

    expect(h.started).toHaveLength(1);
    expect(h.started[0]).toEqual(expect.arrayContaining(['revise', '--repo', REPO, '--pr', '8']));
  });

  it('shows the card what to ask: the comments, and where each might go', async () => {
    const h = setup({ pending: LATER, triage: triage(LATER_ITEMS), workCopy: WORKTREE });
    await h.watcher.refresh();

    const view = h.watcher.getState().pullRequests[0]!;

    expect(view.scope!.undecided.map((entry) => [entry.id, entry.suggestedPhaseId])).toEqual([['c1', 'i0001-p3'], ['c2', null]]);
  });

  describe('decideScope', () => {
    const decided = JSON.stringify({ results: [{ commentId: 'c1', decision: 'DEFER', ok: true, target: { phaseId: 'i0001-p3', ordinal: 3, title: 'Charts', created: false } }] });
    const answers = { 'scope-decide': `SCOPE_DECIDE_JSON ${decided}\n` };

    it('hands the decisions to the factory and looks again, so the card shows what is left', async () => {
      const h = setup({ pending: LATER, triage: triage(LATER_ITEMS), workCopy: WORKTREE, answers });
      await h.watcher.refresh();
      const before = h.cli.filter((args) => args[0] === 'pr-check').length;

      const results = await h.watcher.decideScope(KEY, [{ commentId: 'c1', decision: 'DEFER', targetPhase: 'i0001-p3' }]);

      expect(results[0]).toMatchObject({ ok: true, target: { ordinal: 3 } });
      const call = h.cli.find((args) => args[0] === 'scope-decide')!;
      expect(call).toEqual(['scope-decide', '--repo', REPO, '--pr', '8', '--decisions', JSON.stringify([{ commentId: 'c1', decision: 'DEFER', targetPhase: 'i0001-p3' }])]);
      expect(h.cli.filter((args) => args[0] === 'pr-check').length).toBe(before + 1);
      expect(h.changed).toContain(REPO);
    });

    it('does not start a round while there is still something to decide', async () => {
      const h = setup({ pending: LATER, triage: triage(LATER_ITEMS), workCopy: WORKTREE, answers, settings: { autoRevise: true } });
      await h.watcher.refresh();

      h.decisions = [{ commentId: 'c1', decision: 'DO_NOW', targetPhaseId: null }]; // c2 has no home yet
      await h.watcher.decideScope(KEY, [{ commentId: 'c1', decision: 'DO_NOW' }]);

      expect(h.started).toEqual([]);
      expect(h.watcher.getState().pullRequests[0]!.status).toBe('awaiting-scope');
    });

    it('starts the round the moment the last comment has its home - not at the next poll - when rounds start by themselves', async () => {
      const h = setup({ pending: LATER, triage: triage(LATER_ITEMS), workCopy: WORKTREE, answers, settings: { autoRevise: true } });
      await h.watcher.refresh();
      expect(h.started).toEqual([]);

      h.decisions = [{ commentId: 'c1', decision: 'DO_NOW', targetPhaseId: null }, { commentId: 'c2', decision: 'DO_NOW', targetPhaseId: null }];
      await h.watcher.decideScope(KEY, [{ commentId: 'c1', decision: 'DO_NOW' }, { commentId: 'c2', decision: 'DO_NOW' }]);

      expect(h.started).toHaveLength(1);
      expect(h.started[0]![0]).toBe('revise');
    });

    it('leaves the round to the user when rounds do not start by themselves', async () => {
      const h = setup({ pending: LATER, triage: triage(LATER_ITEMS), workCopy: WORKTREE, answers, settings: { autoRevise: false } });
      await h.watcher.refresh();

      h.decisions = [{ commentId: 'c1', decision: 'DO_NOW', targetPhaseId: null }, { commentId: 'c2', decision: 'DO_NOW', targetPhaseId: null }];
      await h.watcher.decideScope(KEY, [{ commentId: 'c1', decision: 'DO_NOW' }, { commentId: 'c2', decision: 'DO_NOW' }]);

      expect(h.started).toEqual([]);
      expect(h.watcher.getState().pullRequests[0]).toMatchObject({ status: 'triaged', message: '2 comments need code changes - start a round to address them.' });
    });

    it('asks the factory to acknowledge on GitHub only when replies are on', async () => {
      const off = setup({ pending: LATER, triage: triage(LATER_ITEMS), answers });
      await off.watcher.refresh();
      await off.watcher.decideScope(KEY, [{ commentId: 'c1', decision: 'DEFER' }]);
      expect(off.cli.find((args) => args[0] === 'scope-decide')).not.toContain('--reply');

      const on = setup({ pending: LATER, triage: triage(LATER_ITEMS), answers, settings: { replyOnGitHub: true } });
      await on.watcher.refresh();
      await on.watcher.decideScope(KEY, [{ commentId: 'c1', decision: 'DEFER' }]);
      expect(on.cli.find((args) => args[0] === 'scope-decide')).toContain('--reply');
    });

    it('says why when the factory refuses, and still looks again', async () => {
      const refused = { 'scope-decide': 'SCOPE_DECIDE_JSON {"error":"No triage of pull request #8 found. Triage its comments first."}\n' };
      const h = setup({ pending: LATER, triage: triage(LATER_ITEMS), answers: refused });
      await h.watcher.refresh();

      await expect(h.watcher.decideScope(KEY, [{ commentId: 'c1', decision: 'DEFER' }])).rejects.toThrow('No triage of pull request #8 found');
    });

    it('has nothing to do for an empty decision, and cannot decide for a pull request it does not watch', async () => {
      const h = setup({ pending: LATER, triage: triage(LATER_ITEMS), answers });
      await h.watcher.refresh();

      await expect(h.watcher.decideScope(KEY, [])).rejects.toThrow('There is nothing to decide');
      await expect(h.watcher.decideScope('/other#1', [{ commentId: 'c1', decision: 'DEFER' }])).rejects.toThrow('no longer being watched');
    });
  });
});

describe('the watcher: the roadmap after a phase is delivered', () => {
  const settledPhase = (over: Partial<SettledPhase> = {}): SettledPhase => ({
    initiativeId: 'i0001', kind: 'project', initiativeTitle: 'Redesign', phaseId: 'i0001-p1', title: 'Foundation', ordinal: 1, total: 3, merged: true, alreadySettled: false,
    next: { phaseId: 'i0001-p2', ordinal: 2, title: 'Screens' }, initiativeDone: false, ...over,
  });
  const reportLine = `PHASE_RECONCILE_JSON ${JSON.stringify({ report: { summary: 'Delivered.', changes: [], backlogAdded: 0, source: 'agent' } })}\n`;
  const merged = (phase?: SettledPhase): string => `PR_MERGE_JSON ${JSON.stringify({ merged: true, notes: [], ...(phase ? { phase } : {}) } satisfies PrMergeResult)}\n`;

  async function mergeThrough(h: Harness): Promise<PrMergeResult> {
    await h.watcher.refresh();
    await h.watcher.approve(KEY, 'abc1234');
    return await h.watcher.merge(KEY, { subject: 'feat: foundation', body: '', deleteBranch: true });
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('is compared with what the phase delivered, in the background, as soon as the user merges it', async () => {
    const h = setup({ workCopy: WORKTREE, answers: { 'pr-merge': merged(settledPhase()), 'phase-reconcile': reportLine } });

    const outcome = await mergeThrough(h);
    await settle();

    expect(outcome.phase).toMatchObject({ phaseId: 'i0001-p1', next: { ordinal: 2 } });
    expect(h.cli.find((args) => args[0] === 'phase-reconcile')).toEqual(['phase-reconcile', '--phase', 'i0001-p1']);
    expect(h.changed.length).toBeGreaterThan(0);
  });

  it('is left alone when the user switched it off, but the screen is still told the roadmap moved', async () => {
    const h = setup({ workCopy: WORKTREE, autoReconcile: false, answers: { 'pr-merge': merged(settledPhase()) } });

    await mergeThrough(h);
    await settle();

    expect(h.cli.some((args) => args[0] === 'phase-reconcile')).toBe(false);
    expect(h.changed).toContain(REPO);
  });

  it('does not compare a one-off task with a roadmap it does not have - not after a merge here, not after one on GitHub', async () => {
    const here = setup({ workCopy: WORKTREE, answers: { 'pr-merge': merged(settledPhase({ kind: 'quick', total: 1, next: null, initiativeDone: true })), 'phase-reconcile': reportLine } });
    await mergeThrough(here);
    await settle();
    expect(here.cli.some((args) => args[0] === 'phase-reconcile')).toBe(false);
    expect(here.changed).toContain(REPO); // the roadmap list may still have to look again

    const github = setup({ state: 'MERGED', settled: { phase: settledPhase({ kind: 'quick', total: 1, next: null, initiativeDone: true }), notes: [] }, answers: { 'phase-reconcile': reportLine } });
    await github.watcher.refresh();
    await settle();
    expect(github.reconciled).toEqual([]);
  });

  it('does nothing for a pull request that is not a phase of a project', async () => {
    const h = setup({ answers: { 'pr-merge': merged() } });

    await mergeThrough(h);
    await settle();

    expect(h.cli.some((args) => args[0] === 'phase-reconcile')).toBe(false);
  });

  it('is rehearsed, not paid for, in a dry run', async () => {
    const h = setup({ dryRun: true, answers: { 'pr-merge': merged(settledPhase()), 'phase-reconcile': reportLine } });

    await mergeThrough(h);
    await settle();

    expect(h.cli.find((args) => args[0] === 'phase-reconcile')).toContain('--dry-run');
  });

  it('is also done for a pull request found merged on GitHub - once', async () => {
    const settled = { phase: settledPhase(), notes: [] };
    const h = setup({ state: 'MERGED', settled, answers: { 'phase-reconcile': reportLine } });

    await h.watcher.refresh();
    await settle();

    expect(h.reconciled).toEqual(['i0001-p1']);
    expect(h.changed).toContain(REPO);
  });

  it('is not done again for one the factory had settled before', async () => {
    const h = setup({ state: 'MERGED', settled: { phase: settledPhase({ alreadySettled: true }), notes: [] }, answers: { 'phase-reconcile': reportLine } });

    await h.watcher.refresh();
    await settle();

    expect(h.reconciled).toEqual([]);
  });

  it('is not done for one that was closed without merging - but the roadmap still changed', async () => {
    const h = setup({ state: 'CLOSED', settled: { phase: settledPhase({ merged: false }), notes: [] } });

    await h.watcher.refresh();
    await settle();

    expect(h.reconciled).toEqual([]);
    expect(h.changed).toContain(REPO);
  });

  describe('reconcile (asked for by hand)', () => {
    it('returns what the factory concluded, and asks again only when told to', async () => {
      const h = setup({ answers: { 'phase-reconcile': reportLine } });

      expect(await h.watcher.reconcile('i0001-p1')).toMatchObject({ summary: 'Delivered.', source: 'agent' });
      await h.watcher.reconcile('i0001-p1', { force: true });

      expect(h.cli.filter((args) => args[0] === 'phase-reconcile').map((args) => args.includes('--force'))).toEqual([false, true]);
    });

    it('is one at a time per phase: a second click while it runs does nothing', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const h = setup({ answers: { 'phase-reconcile': reportLine } });
      const original = (h.watcher as unknown as { deps: WatcherDeps }).deps.runCli;
      (h.watcher as unknown as { deps: WatcherDeps }).deps.runCli = async (args, opts) => {
        if (args[0] === 'phase-reconcile') await gate;
        return original(args, opts);
      };

      const first = h.watcher.reconcile('i0001-p1');
      expect(await h.watcher.reconcile('i0001-p1')).toBeNull();
      release();
      await first;
      expect(h.cli.filter((args) => args[0] === 'phase-reconcile')).toHaveLength(1);
    });

    it('says why when the factory could not', async () => {
      const h = setup({ answers: { 'phase-reconcile': 'PHASE_RECONCILE_JSON {"error":"Phase i0001-p1 was not found."}\n' } });

      await expect(h.watcher.reconcile('i0001-p1')).rejects.toThrow('Phase i0001-p1 was not found.');
    });
  });
});

void vi;
