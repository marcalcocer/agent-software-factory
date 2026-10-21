// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PullRequestsPanel } from '../src/components/PullRequestsPanel';
import type { PrMergeNotice, PrWatchState, ScopeDecisionResult, WatchedPullRequest } from '../shared/types';
import { idleWatcher, installFakeApi, REPO_PATH } from './support/fake-api';

const ROADMAP = {
  initiativeId: 'i0001',
  title: 'Redesign the frontend',
  phaseId: 'i0001-p1',
  ordinal: 1,
  total: 4,
  phases: [
    { id: 'i0001-p1', ordinal: 1, title: 'Foundation', status: 'IN_REVIEW' as const },
    { id: 'i0001-p2', ordinal: 2, title: 'Screens', status: 'PLANNED' as const },
    { id: 'i0001-p3', ordinal: 3, title: 'Charts', status: 'PLANNED' as const },
    { id: 'i0001-p4', ordinal: 4, title: 'Cleanup', status: 'MERGED' as const },
  ],
};

const settingsComment = { id: 'c1', source: 'REVIEW_THREAD' as const, author: 'marc', body: 'Make the settings page dark too. It still has white cards.', createdAt: '2026-10-19T17:30:00Z', fresh: true, path: 'ui/src/Settings.jsx', line: 12 };
const shortcutComment = { id: 'c2', source: 'ISSUE_COMMENT' as const, author: 'marc', body: 'Could you add a keyboard shortcut for the theme toggle?', createdAt: '2026-10-19T17:31:00Z', fresh: true };

const pr = (over: Partial<WatchedPullRequest> = {}): WatchedPullRequest => ({
  key: `${REPO_PATH}#8`, repoPath: REPO_PATH, repoName: 'invest-track', number: 8, url: 'https://github.com/o/r/pull/8', title: 'Foundation',
  headBranch: 'factory/f0042/feat-x', baseBranch: 'main', rootRunId: 'R1', latestRunId: 'R1', round: 1, pending: [settingsComment, shortcutComment],
  status: 'awaiting-scope', message: '2 comments ask for something that belongs to a later phase. Choose where each goes.',
  merge: { headSha: 'abc1234', blockers: [], warnings: [], approval: null, approvalOutdated: false },
  roadmap: ROADMAP,
  scope: {
    undecided: [
      { id: 'c1', author: 'marc', body: settingsComment.body, excerpt: 'Make the settings page dark too', path: 'ui/src/Settings.jsx', line: 12, suggestedPhaseId: 'i0001-p3' },
      { id: 'c2', author: 'marc', body: shortcutComment.body, excerpt: 'keyboard shortcut', suggestedPhaseId: null },
    ],
    doNow: [],
  },
  ...over,
});

const watcher = (...prs: WatchedPullRequest[]): PrWatchState => ({ ...idleWatcher(), watching: prs.length, pullRequests: prs });

function panel(state: PrWatchState, overrides: Partial<React.ComponentProps<typeof PullRequestsPanel>> = {}) {
  const decide = vi.fn(async (): Promise<ScopeDecisionResult[]> => [{ commentId: 'c1', decision: 'DEFER', ok: true }]);
  const props = {
    repoPath: REPO_PATH, state, onRefresh: () => {}, notices: [] as PrMergeNotice[], onDismissNotice: () => {},
    onTriage: async () => {}, onRevise: async () => {}, onDismiss: async () => {}, onPostReplies: async () => {}, onOpenRun: () => {},
    onApprove: async () => {}, onWithdrawApproval: async () => {}, onMergeDraft: async () => { throw new Error('not here'); },
    onMerge: async () => ({ merged: true, notes: [] }), onDecideScope: decide, ...overrides,
  };
  render(<PullRequestsPanel {...props} />);
  return { decide: props.onDecideScope as ReturnType<typeof vi.fn> };
}

describe('a pull request waiting for the user to say where comments go', () => {
  it('says so, in words, and lists each comment with where it is', () => {
    installFakeApi({});
    panel(watcher(pr()));

    expect(screen.getByText('Choose where it goes')).toBeTruthy();
    expect(screen.getByTestId('pr-message').textContent).toBe('2 comments ask for something that belongs to a later phase. Choose where each goes.');
    const section = screen.getByTestId('scope-section');
    expect(section.textContent).toContain('These comments ask for more than this pull request');
    expect(section.textContent).toContain('This is phase 1 of 4 of "Redesign the frontend". Nothing starts until you say where each goes.');
    const first = screen.getByTestId('scope-comment-c1');
    expect(first.textContent).toContain('@marc');
    expect(first.textContent).toContain('ui/src/Settings.jsx:12');
    expect(first.textContent).toContain('Make the settings page dark too. It still has white cards.');
  });

  it('offers the phase the triage suggested as one click, when there is one - and no guess when there is not', () => {
    installFakeApi({});
    panel(watcher(pr()));

    expect(within(screen.getByTestId('scope-comment-c1')).getByRole('button', { name: 'Defer to phase 3: Charts' })).toBeTruthy();
    expect(within(screen.getByTestId('scope-comment-c2')).queryByRole('button', { name: /Defer to phase/ })).toBeNull();
    expect(within(screen.getByTestId('scope-comment-c2')).getByRole('combobox')).toBeTruthy(); // choose one
  });

  it('defers to the suggested phase', async () => {
    installFakeApi({});
    const user = userEvent.setup();
    const { decide } = panel(watcher(pr()));

    await user.click(screen.getByRole('button', { name: 'Defer to phase 3: Charts' }));

    expect(decide).toHaveBeenCalledWith(`${REPO_PATH}#8`, [{ commentId: 'c1', decision: 'DEFER', targetPhase: 'i0001-p3' }]);
  });

  it('defers to another phase the user picks - only phases that are still planned', async () => {
    installFakeApi({});
    const user = userEvent.setup();
    const { decide } = panel(watcher(pr()));
    const choose = within(screen.getByTestId('scope-comment-c2')).getByRole('combobox');

    expect(within(choose).getAllByRole('option').map((option) => option.textContent)).toEqual(['Defer to...', 'Phase 2: Screens', 'Phase 3: Charts', 'A phase of its own']);
    expect(within(screen.getByTestId('scope-comment-c2')).queryByRole('button', { name: 'Defer' })).toBeNull(); // nothing chosen yet

    await user.selectOptions(choose, 'i0001-p2');
    await user.click(within(screen.getByTestId('scope-comment-c2')).getByRole('button', { name: 'Defer' }));

    expect(decide).toHaveBeenCalledWith(`${REPO_PATH}#8`, [{ commentId: 'c2', decision: 'DEFER', targetPhase: 'i0001-p2' }]);
  });

  it('makes a phase of its own for a comment no phase covers', async () => {
    installFakeApi({});
    const user = userEvent.setup();
    const { decide } = panel(watcher(pr()));

    await user.selectOptions(within(screen.getByTestId('scope-comment-c2')).getByRole('combobox'), 'NEW');
    await user.click(within(screen.getByTestId('scope-comment-c2')).getByRole('button', { name: 'Defer' }));

    expect(decide).toHaveBeenCalledWith(`${REPO_PATH}#8`, [{ commentId: 'c2', decision: 'DEFER', targetPhase: 'NEW' }]);
  });

  it('offers a new phase as the one click when that is what the triage suggested', async () => {
    installFakeApi({});
    const user = userEvent.setup();
    const state = watcher(pr({ scope: { undecided: [{ id: 'c2', author: 'marc', body: shortcutComment.body, excerpt: 'x', suggestedPhaseId: 'NEW' }], doNow: [] } }));
    const { decide } = panel(state);

    await user.click(screen.getByRole('button', { name: 'Make it a phase of its own' }));

    expect(decide).toHaveBeenCalledWith(`${REPO_PATH}#8`, [{ commentId: 'c2', decision: 'DEFER', targetPhase: 'NEW' }]);
  });

  it('does not suggest a phase that is no longer waiting', () => {
    installFakeApi({});
    const state = watcher(pr({ scope: { undecided: [{ id: 'c1', author: 'marc', body: 'x', excerpt: 'x', suggestedPhaseId: 'i0001-p4' }], doNow: [] } })); // p4 is merged
    panel(state);

    expect(screen.queryByRole('button', { name: /Defer to phase/ })).toBeNull();
  });

  it('does it in this pull request when the user says so', async () => {
    installFakeApi({});
    const user = userEvent.setup();
    const { decide } = panel(watcher(pr()));

    await user.click(within(screen.getByTestId('scope-comment-c2')).getByRole('button', { name: 'Do it in this pull request' }));

    expect(decide).toHaveBeenCalledWith(`${REPO_PATH}#8`, [{ commentId: 'c2', decision: 'DO_NOW' }]);
  });

  it('shows what the user already decided to do here - the next round plans it in', () => {
    installFakeApi({});
    panel(watcher(pr({ scope: { undecided: [{ id: 'c2', author: 'marc', body: shortcutComment.body, excerpt: 'x', suggestedPhaseId: null }], doNow: ['c1'] }, pending: [settingsComment, shortcutComment] })));

    expect(screen.getByTestId('scope-do-now').textContent).toBe('1 comment goes into this pull request: the next round plans it in.');
    // The comment still asked about has its buttons; the decided one is not asked about again.
    expect(screen.queryByTestId('scope-comment-c1')).toBeNull();
    expect(screen.getByTestId('scope-comment-c2')).toBeTruthy();
  });

  it('lists the other pending comments plainly, below - the ones the section already shows are not repeated', () => {
    installFakeApi({});
    const other = { ...settingsComment, id: 'c9', body: 'The contrast of the muted text is too low.', path: undefined, line: undefined };
    panel(watcher(pr({ pending: [settingsComment, shortcutComment, other] })));

    const list = screen.getByTestId('pending-comments');
    expect(list.textContent).toContain('The contrast of the muted text is too low.');
    expect(list.textContent).not.toContain('Make the settings page dark too');
  });

  it('says why when the decision was refused, and keeps the buttons', async () => {
    installFakeApi({});
    const user = userEvent.setup();
    const { decide } = panel(watcher(pr()));
    decide.mockResolvedValueOnce([{ commentId: 'c1', decision: 'DEFER', ok: false, error: 'Phase 3 ("Charts") is already delivered, so it cannot take new work.' }]);

    await user.click(screen.getByRole('button', { name: 'Defer to phase 3: Charts' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Phase 3 ("Charts") is already delivered, so it cannot take new work.');
    expect(screen.getByRole('button', { name: 'Defer to phase 3: Charts' })).toBeTruthy();
  });

  it('says why when the call itself failed - without the Electron wrapper', async () => {
    installFakeApi({});
    const user = userEvent.setup();
    const { decide } = panel(watcher(pr()));
    decide.mockRejectedValueOnce(new Error("Error invoking remote method 'pr-watch:decide-scope': Error: No triage of pull request #8 found."));

    await user.click(screen.getByRole('button', { name: 'Defer to phase 3: Charts' }));

    expect((await screen.findByRole('alert')).textContent).toBe('No triage of pull request #8 found.');
  });

  it('holds the buttons while a decision is being saved - a double click cannot decide twice', async () => {
    installFakeApi({});
    const user = userEvent.setup();
    let finish: (results: ScopeDecisionResult[]) => void = () => {};
    const { decide } = panel(watcher(pr()));
    decide.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    await user.click(screen.getByRole('button', { name: 'Defer to phase 3: Charts' }));

    expect(await screen.findByText('Saving...')).toBeTruthy();
    for (const buttonEl of screen.getAllByRole('button', { name: 'Do it in this pull request' })) expect((buttonEl as HTMLButtonElement).disabled).toBe(true);
    finish([{ commentId: 'c1', decision: 'DEFER', ok: true }]);
    await waitFor(() => expect(screen.queryByText('Saving...')).toBeNull());
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('does not offer to start a round or to read the comments while they wait for a decision', () => {
    installFakeApi({});
    panel(watcher(pr()));

    expect(screen.queryByRole('button', { name: /Start round/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Read the comments' })).toBeNull();
  });

  it('is what it was for a pull request with nothing about a later phase', () => {
    installFakeApi({});
    panel(watcher(pr({ status: 'pending', message: '2 new comments to look at.', scope: undefined, roadmap: undefined })));

    expect(screen.queryByTestId('scope-section')).toBeNull();
    expect(screen.getByRole('button', { name: 'Read the comments' })).toBeTruthy();
  });
});

describe('what the card lists of a triage once part of it is done', () => {
  const comment = (id: string, body: string) => ({ id, source: 'ISSUE_COMMENT' as const, author: 'marc', body, createdAt: '2026-10-19T17:30:00Z', fresh: true });
  const item = (commentId: string, category: string, reply = '') => ({
    commentId, author: 'marc', excerpt: `excerpt of ${commentId}`, category, assignTo: 'none', reasoning: '', reply, filesInvolved: [] as string[],
  });
  const triaged = (pending: ReturnType<typeof comment>[], items: ReturnType<typeof item>[]) =>
    pr({
      status: 'triaged', message: 'No code changes needed - these are questions or notes.', scope: undefined, roadmap: undefined, pending,
      triage: {
        runId: 'T1', pullRequest: 8, pullRequestUrl: 'u', action: 'REPLY_ONLY', summary: 'Questions only.', commentsTriaged: items.length, repliesPosted: 0,
        followUpTask: '', blockers: [], headBranch: 'b', baseBranch: 'main', items, commentIds: items.map((entry) => entry.commentId),
      },
    });
  const QUESTIONS = [item('q1', 'QUESTION', 'Because X.'), item('q2', 'QUESTION', 'Because Y.'), item('n1', 'PRAISE_OR_NOTE', 'Thanks!')];

  it('offers to answer the questions that are still open - and counts only those', () => {
    installFakeApi({});
    panel(watcher(triaged([comment('q1', 'Why X?'), comment('q2', 'Why Y?')], QUESTIONS)));

    expect(screen.getByRole('button', { name: 'Answer 2 questions on GitHub' })).toBeTruthy();
  });

  it('does not count a question that was already answered - the triage still lists it, but there is nothing left to do', () => {
    installFakeApi({});
    // q1 was answered on GitHub (so it is no longer pending); q2 was not.
    panel(watcher(triaged([comment('q2', 'Why Y?')], QUESTIONS)));

    expect(screen.getByRole('button', { name: 'Answer 1 question on GitHub' })).toBeTruthy();
  });

  it('offers nothing to answer when every question has been answered', () => {
    installFakeApi({});
    panel(watcher(triaged([comment('c9', 'Another remark, no reply drafted')], [...QUESTIONS, item('c9', 'CODE_CHANGE_REQUEST')])));

    expect(screen.queryByRole('button', { name: /Answer \d+ question/ })).toBeNull();
  });

  it('lists in the triage summary only the comments that are still open', () => {
    installFakeApi({});
    panel(watcher(triaged([comment('q2', 'Why Y?')], QUESTIONS)));

    const card = screen.getByTestId('pr-card-8');
    expect(within(card).getAllByText(/@marc: /).map((entry) => entry.textContent)).toEqual(['@marc: question']);
  });

  it('lists none - and no empty row - when everything the triage looked at is done with', () => {
    installFakeApi({});
    panel(watcher(triaged([comment('c9', 'A comment the triage has not seen')], QUESTIONS)));

    const card = screen.getByTestId('pr-card-8');
    expect(within(card).queryByText(/@marc: /)).toBeNull();
    expect(card.querySelector('ul.flex.flex-wrap')).toBeNull();
  });
});

describe('where the pull request\'s code is', () => {
  it('is on the card - the folder of its task, so it can be checked by hand', () => {
    installFakeApi({});
    panel(watcher(pr({ workCopy: { isolation: 'worktree', path: '/home/dev/workspace/.factory/worktrees/invest-track/f0042', exists: true } })));

    const line = screen.getByTestId('pr-work-copy');
    expect(line.textContent).toContain('Isolated worktree');
    expect(line.textContent).toContain('/home/dev/workspace/.factory/worktrees/invest-track/f0042');
  });

  it('is not there for a factory that does not say', () => {
    installFakeApi({});
    panel(watcher(pr({ workCopy: undefined })));

    expect(screen.queryByTestId('pr-work-copy')).toBeNull();
  });
});

describe('what a merge leaves in the notice', () => {
  const notice = (phase: Parameters<typeof makeNotice>[0]): PrMergeNotice => makeNotice(phase);
  function makeNotice(phase: NonNullable<PrMergeNotice['result']['phase']> | undefined): PrMergeNotice {
    return {
      id: 'n1', repoPath: REPO_PATH, number: 8, title: 'Foundation', url: 'https://github.com/o/r/pull/8', at: '2026-10-20T10:00:00Z',
      result: { merged: true, baseBranch: 'main', notes: [], ...(phase ? { phase } : {}) },
    };
  }
  const settled = (over: Partial<NonNullable<PrMergeNotice['result']['phase']>> = {}) => ({
    initiativeId: 'i0001', kind: 'project' as const, initiativeTitle: 'Redesign the frontend', phaseId: 'i0001-p1', title: 'Foundation', ordinal: 1, total: 4, merged: true,
    alreadySettled: false, next: { phaseId: 'i0001-p2', ordinal: 2, title: 'Screens' }, initiativeDone: false, ...over,
  });

  it('says which phase is delivered and which is next', () => {
    installFakeApi({});
    panel(watcher(), { notices: [notice(settled())] });

    expect(screen.getByTestId('phase-outcome').textContent).toBe(
      'Phase 1 of 4 of Redesign the frontend is delivered. Phase 2 ("Screens") is next - start it from the roadmap below.',
    );
  });

  it('says the project is finished when it is', () => {
    installFakeApi({});
    panel(watcher(), { notices: [notice(settled({ ordinal: 4, next: null, initiativeDone: true }))] });

    expect(screen.getByTestId('phase-outcome').textContent).toContain('The project is finished.');
  });

  it('says so when nothing can start yet', () => {
    installFakeApi({});
    panel(watcher(), { notices: [notice(settled({ next: null }))] });

    expect(screen.getByTestId('phase-outcome').textContent).toContain('No other phase can start yet.');
  });

  it('says nothing about phases, a roadmap or a finished project for a one-off task - it never had any', () => {
    installFakeApi({});
    panel(watcher(), { notices: [notice(settled({ kind: 'quick', initiativeTitle: 'Add a percent formatter', total: 1, next: null, initiativeDone: true }))] });

    expect(screen.getByTestId('merge-notice').textContent).toContain('Merged #8');
    expect(screen.queryByTestId('phase-outcome')).toBeNull();
    expect(screen.getByTestId('merge-notice').textContent).not.toMatch(/phase|project|roadmap/i);
  });

  it('says nothing about phases for a pull request that was not one', () => {
    installFakeApi({});
    panel(watcher(), { notices: [notice(undefined)] });

    expect(screen.getByTestId('merge-notice')).toBeTruthy();
    expect(screen.queryByTestId('phase-outcome')).toBeNull();
  });
});
