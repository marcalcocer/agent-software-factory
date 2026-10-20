import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commandScopeDecide } from '../src/cli/initiatives.ts';
import { composeRevision, type TriageSummary } from '../src/cli/revision.ts';
import { renderRoadmapForTriage, phaseTask } from '../src/initiatives/phasing.ts';
import { decideScope, normalizeTriage, titleFromComment, type RoadmapTargets } from '../src/initiatives/scope.ts';
import { withStore } from '../src/initiatives/store.ts';
import { loadRegistry, markCommentsHandled, pullRequestKey, registerPullRequest, type RegisteredPullRequest } from '../src/tools/pr-registry.ts';
import { checkPullRequests } from '../src/tools/pr-watch.ts';
import { feedbackTriageReportSchema, type FeedbackTriageReport, type RevisionComment } from '../src/utils/schemas.ts';

const REPO = '/home/dev/workspace/invest-track';
const KEY = pullRequestKey(REPO, 8);
let logs: string;

beforeEach(() => {
  logs = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-scope-'));
  vi.stubEnv('FACTORY_LOG_DIR', logs);
});
afterEach(() => fs.rmSync(logs, { recursive: true, force: true }));

/** Phase 1 ("Foundation") is this pull request, in review; phases 2-4 are planned. */
async function project() {
  return await withStore(async (store) => {
    const created = await store.createInitiative({ repoPath: REPO, title: 'Redesign', goal: 'Redesign the frontend', firstPhase: { title: 'Foundation' } });
    await store.linkRun(created.phases[0]!.id, { taskId: 'f0042', rootRunId: 'run-1', branch: 'factory/f0042/feat-x' });
    const set = await store.setRoadmap(created.id, {
      title: 'Redesign the frontend',
      phases: [
        { title: 'Foundation', scope: ['Design tokens'] },
        { title: 'Screens', goal: 'Migrate every screen', scope: ['Migrate the settings screen', 'Migrate the home screen'] },
        { title: 'Charts', goal: 'Dark charts', scope: ['Recolour the charts'] },
        { title: 'Cleanup' },
      ],
    });
    await store.linkPullRequest(set.phases[0]!.id, { number: 8, url: 'https://github.com/o/r/pull/8' });
    return (await store.getInitiative(set.id))!;
  });
}

const item = (overrides: Partial<FeedbackTriageReport['items'][number]> = {}): FeedbackTriageReport['items'][number] => ({
  commentId: 'c1', author: 'marc', excerpt: 'Make the settings page dark too', category: 'CODE_CHANGE_REQUEST', assignTo: 'developer',
  reasoning: 'r', reply: 'ok', filesInvolved: [], ...overrides,
});
const report = (items: FeedbackTriageReport['items'], overrides: Partial<FeedbackTriageReport> = {}): FeedbackTriageReport => ({
  overallAction: 'RERUN_IMPLEMENTATION', summary: 's', items, taskForNextRun: 'Do the things.', roundTitle: 'Do the things', blockers: [], ...overrides,
});
const ROADMAP: RoadmapTargets = { planned: new Set(['i0001-p2', 'i0001-p3', 'i0001-p4']) };

describe('the triage schema', () => {
  it('knows FUTURE_PHASE and a target phase, and still reads a report from before they existed', () => {
    const now = report([item({ category: 'FUTURE_PHASE', assignTo: 'none', targetPhase: 'i0001-p2' })]);
    expect(feedbackTriageReportSchema.parse(now).items[0]).toMatchObject({ category: 'FUTURE_PHASE', targetPhase: 'i0001-p2' });

    const old = JSON.parse(JSON.stringify(report([item()])));
    expect(feedbackTriageReportSchema.parse(old).items[0]!.targetPhase).toBeUndefined();
    expect(feedbackTriageReportSchema.safeParse(report([item({ category: 'NOT_A_CATEGORY' as never })])).success).toBe(false);
  });
});

describe('normalizeTriage', () => {
  it('leaves a report that needs nothing alone', () => {
    const input = report([item(), item({ commentId: 'c2', category: 'QUESTION', assignTo: 'none' })]);

    expect(normalizeTriage(input, ROADMAP)).toEqual({ report: input, corrections: [] });
  });

  it('keeps a later-phase comment with a phase it can really go to, or NEW, and routes it to nobody', () => {
    const { report: out, corrections } = normalizeTriage(
      report([
        item({ commentId: 'a', category: 'FUTURE_PHASE', assignTo: 'developer', targetPhase: 'i0001-p3' }),
        item({ commentId: 'b', category: 'FUTURE_PHASE', assignTo: 'pm-architect', targetPhase: ' new ' }),
      ]),
      ROADMAP,
    );

    expect(out.items.map((entry) => [entry.commentId, entry.category, entry.assignTo, entry.targetPhase])).toEqual([
      ['a', 'FUTURE_PHASE', 'none', 'i0001-p3'],
      ['b', 'FUTURE_PHASE', 'none', 'NEW'],
    ]);
    expect(corrections).toEqual(expect.arrayContaining([expect.stringContaining('asked for another round')]));
  });

  it.each([
    ['a phase that is delivered (this one)', 'i0001-p1'],
    ['a phase that does not exist', 'i0009-p1'],
    ['no phase at all', null],
    ['an empty string', ''],
  ])('does not trust %s as a target: the user chooses', (_name, target) => {
    const { report: out } = normalizeTriage(report([item({ category: 'FUTURE_PHASE', assignTo: 'none', targetPhase: target })]), ROADMAP);

    expect(out.items[0]).toMatchObject({ category: 'FUTURE_PHASE', targetPhase: null });
  });

  it('without a roadmap there is no later phase: the comment is new scope for this pull request', () => {
    const { report: out, corrections } = normalizeTriage(report([item({ category: 'FUTURE_PHASE', assignTo: 'none', targetPhase: 'i0001-p2' })]), null);

    expect(out.items[0]).toMatchObject({ category: 'SCOPE_CHANGE', assignTo: 'pm-architect', targetPhase: null });
    expect(corrections[0]).toContain('has no later phase');
    expect(out.overallAction).toBe('RERUN_IMPLEMENTATION'); // the agent's own word is kept when it already asked for a round
  });

  it('and then it is not lost because the agent had answered "reply only" for what it took to be a later phase', () => {
    const { report: out, corrections } = normalizeTriage(
      report([item({ category: 'FUTURE_PHASE', assignTo: 'none', excerpt: 'Make the settings page dark too' })], { overallAction: 'REPLY_ONLY', taskForNextRun: '', roundTitle: undefined }),
      null,
    );

    expect(out.overallAction).toBe('RERUN_PLANNING');
    expect(out.taskForNextRun).toBe('Plan in and address these review comments, which ask for work the plan does not cover:\n- Make the settings page dark too');
    expect(corrections.join(' ')).toContain('needs a round that plans it in');
  });

  it('drops a target from a comment that is not about a later phase', () => {
    const { report: out } = normalizeTriage(report([item({ category: 'CODE_CHANGE_REQUEST', targetPhase: 'i0001-p2' })]), ROADMAP);

    expect(out.items[0]!.targetPhase).toBeNull();
  });

  describe('a round needs a comment that asks for a change', () => {
    const onlyLater = [item({ category: 'FUTURE_PHASE', assignTo: 'none', targetPhase: 'i0001-p2' }), item({ commentId: 'c2', category: 'QUESTION', assignTo: 'none' })];

    it.each(['RERUN_IMPLEMENTATION', 'RERUN_PLANNING'] as const)('turns %s into a reply when nothing but later-phase requests and questions is left', (action) => {
      const { report: out, corrections } = normalizeTriage(report(onlyLater, { overallAction: action }), ROADMAP);

      expect(out).toMatchObject({ overallAction: 'REPLY_ONLY', taskForNextRun: '' });
      expect(out.roundTitle).toBeUndefined();
      expect(corrections.join(' ')).toContain('no comment asks for a change');
    });

    it('turns it into an escalation when a disagreement a human must settle is among them', () => {
      const { report: out } = normalizeTriage(report([...onlyLater, item({ commentId: 'c3', category: 'BLOCKER_DISAGREEMENT', assignTo: 'human' })], { overallAction: 'RERUN_IMPLEMENTATION' }), ROADMAP);

      expect(out.overallAction).toBe('ESCALATE_HUMAN');
    });

    it('keeps the round when some comment does ask for a change', () => {
      const { report: out, corrections } = normalizeTriage(report([...onlyLater, item({ commentId: 'c3' })]), ROADMAP);

      expect(out).toMatchObject({ overallAction: 'RERUN_IMPLEMENTATION', taskForNextRun: 'Do the things.', roundTitle: 'Do the things' });
      expect(corrections).toEqual([]);
    });

    it('does not make a round out of a reply-only report', () => {
      expect(normalizeTriage(report(onlyLater, { overallAction: 'REPLY_ONLY', taskForNextRun: '' }), ROADMAP).report.overallAction).toBe('REPLY_ONLY');
    });
  });
});

describe('renderRoadmapForTriage', () => {
  it('lists the phases with their ids and what the planned ones cover, and says which is this pull request', async () => {
    const text = renderRoadmapForTriage(await project(), 'i0001-p1')!;

    expect(text).toContain('This pull request is phase 1 of 4 of "Redesign the frontend" (i0001).');
    expect(text).toContain('i0001-p1 - 1. Foundation [THIS PULL REQUEST]');
    expect(text).toContain('i0001-p2 - 2. Screens [planned]');
    expect(text).toContain('Covers: Migrate the settings screen; Migrate the home screen');
    expect(text).toContain('Goal: Dark charts');
    expect(text).toContain('`FUTURE_PHASE` with `targetPhase` "NEW"');
  });

  it('does not offer a delivered or skipped phase as somewhere to go', async () => {
    await project();
    await withStore(async (store) => {
      await store.updatePhase('i0001-p2', { status: 'MERGED' });
      await store.updatePhase('i0001-p4', { status: 'SKIPPED' });
    });
    const text = renderRoadmapForTriage((await withStore((store) => store.getInitiative('i0001')))!, 'i0001-p1')!;

    expect(text).toContain('i0001-p2 - 2. Screens [delivered]');
    expect(text).not.toContain('Covers: Migrate the settings screen'); // a delivered phase is listed, not described as a target
    expect(text).not.toContain('i0001-p4');
    expect(text).toContain('This pull request is phase 1 of 3');
  });

  it('is nothing for a project of one phase - a plain task is reviewed as it always was', async () => {
    const alone = await withStore(async (store) => {
      const created = await store.createInitiative({ repoPath: REPO, title: 'Fix a typo', goal: 'g', kind: 'quick', firstPhase: { title: 'Fix a typo' } });
      return created;
    });

    expect(renderRoadmapForTriage(alone, alone.phases[0]!.id)).toBeNull();
    expect(renderRoadmapForTriage(await project(), 'i0001-p99')).toBeNull();
  });
});

describe('titleFromComment', () => {
  it.each([
    ['Make the settings page dark too. It still has white cards.', 'Make the settings page dark too'],
    ['- also handle the empty state', 'Also handle the empty state'],
    ['  \n  ', 'Review request'],
    ['x'.repeat(200), `${'x'.repeat(59)}\u2026`.replace(/^x/, 'X')],
  ])('%j -> %j', (body, title) => {
    expect(titleFromComment(body)).toBe(title);
  });
});

/** The comments of a triage, as `summary.json` keeps them. */
const comments = (): RevisionComment[] => [
  { id: 'c1', source: 'REVIEW_THREAD', threadId: 'T1', author: 'marc', body: 'Make the settings page dark too. It still has white cards.', path: 'ui/src/Settings.jsx', line: 12, category: 'FUTURE_PHASE', targetPhase: 'i0001-p2' },
  { id: 'c2', source: 'ISSUE_COMMENT', author: 'marc', body: 'Could you add a keyboard shortcut for the theme toggle?', category: 'FUTURE_PHASE', targetPhase: null },
  { id: 'c3', source: 'ISSUE_COMMENT', author: 'marc', body: 'Why const here?', category: 'QUESTION' },
  { id: 'c4', source: 'ISSUE_COMMENT', author: 'marc', body: 'The contrast of the muted text is too low.', category: 'CODE_CHANGE_REQUEST' },
];

describe('decideScope', () => {
  const decide = async (decisions: Parameters<typeof decideScope>[0]['decisions'], extra: Partial<Parameters<typeof decideScope>[0]> = {}) => {
    await markRegistered();
    return await decideScope({ repoPath: REPO, number: 8, comments: comments(), decisions, ...extra });
  };
  const markRegistered = async () => {
    if (!loadRegistry().pullRequests[KEY]) {
      await registerPullRequest({ repoPath: REPO, number: 8, url: 'https://github.com/o/r/pull/8', title: 'Foundation', headBranch: 'factory/f0042/feat-x', baseBranch: 'main', runId: 'run-1' });
    }
  };
  const phases = async () => (await withStore((store) => store.getInitiative('i0001')))!.phases;
  const handled = () => loadRegistry().pullRequests[KEY]!.handledCommentIds;

  beforeEach(async () => {
    await project();
  });

  it('defers a comment to a phase: it becomes that phase\'s request, in the user\'s words, and the comment is settled', async () => {
    const { results } = await decide([{ commentId: 'c1', decision: 'DEFER', targetPhase: 'i0001-p2' }]);

    expect(results).toEqual([{ commentId: 'c1', decision: 'DEFER', ok: true, target: { phaseId: 'i0001-p2', ordinal: 2, title: 'Screens', created: false } }]);
    const screens = (await phases())[1]!;
    expect(screens.notes).toHaveLength(1);
    expect(screens.notes[0]).toMatchObject({ source: 'user-request' });
    expect(screens.notes[0]!.text).toBe('Make the settings page dark too. It still has white cards. (ui/src/Settings.jsx:12) - from the review of pull request #8');
    expect(handled()).toEqual(['c1']);
    expect(await withStore((store) => store.listScopeDecisions(KEY))).toMatchObject([{ commentId: 'c1', decision: 'DEFER', targetPhaseId: 'i0001-p2', fromPhaseId: 'i0001-p1', initiativeId: 'i0001' }]);
  });

  it('takes the phase the triage suggested when the user does not choose another', async () => {
    const { results } = await decide([{ commentId: 'c1', decision: 'DEFER' }]);

    expect(results[0]).toMatchObject({ ok: true, target: { phaseId: 'i0001-p2' } });
  });

  it('the next run of that phase is asked for it - phaseTask carries the request', async () => {
    await decide([{ commentId: 'c1', decision: 'DEFER', targetPhase: 'i0001-p2' }]);
    const initiative = (await withStore((store) => store.getInitiative('i0001')))!;

    expect(phaseTask(initiative, initiative.phases[1]!)).toContain('The user asked for these while reviewing an earlier phase, and agreed they belong here:');
    expect(phaseTask(initiative, initiative.phases[1]!)).toContain('Make the settings page dark too');
  });

  it('can make a phase of its own for it, at the end, waiting for the one before', async () => {
    const { results } = await decide([{ commentId: 'c2', decision: 'DEFER', targetPhase: 'NEW' }]);

    // Named by its first sentence, without the closing punctuation; the goal keeps the words as they were.
    expect(results[0]!.target).toMatchObject({ ordinal: 5, title: 'Could you add a keyboard shortcut for the theme toggle', created: true });
    const created = (await phases())[4]!;
    expect(created).toMatchObject({ ordinal: 5, status: 'PLANNED', dependsOn: ['i0001-p4'], goal: 'Could you add a keyboard shortcut for the theme toggle?' });
    expect(created.notes[0]!.text).toContain('keyboard shortcut');
    expect(handled()).toEqual(['c2']);
  });

  it('two new phases in one go: each waits for the one before it', async () => {
    await decide([{ commentId: 'c1', decision: 'DEFER', targetPhase: 'NEW' }, { commentId: 'c2', decision: 'DEFER', targetPhase: 'NEW' }]);

    expect((await phases()).slice(4).map((phase) => [phase.ordinal, phase.dependsOn])).toEqual([[5, ['i0001-p4']], [6, ['i0001-p5']]]);
  });

  it('keeps a comment for this pull request when the user says to do it now: still pending, recorded', async () => {
    const { results } = await decide([{ commentId: 'c1', decision: 'DO_NOW' }]);

    expect(results).toEqual([{ commentId: 'c1', decision: 'DO_NOW', ok: true }]);
    expect(handled()).toEqual([]);
    expect((await phases()).every((phase) => phase.notes.length === 0)).toBe(true);
    expect(await withStore((store) => store.listScopeDecisions(KEY))).toMatchObject([{ commentId: 'c1', decision: 'DO_NOW', targetPhaseId: null }]);
  });

  it('can change its mind about a comment that is still pending: do it now, then defer it', async () => {
    await decide([{ commentId: 'c1', decision: 'DO_NOW' }]);
    await decide([{ commentId: 'c1', decision: 'DEFER', targetPhase: 'i0001-p3' }]);

    expect(await withStore((store) => store.listScopeDecisions(KEY))).toMatchObject([{ commentId: 'c1', decision: 'DEFER', targetPhaseId: 'i0001-p3' }]);
    expect(handled()).toEqual(['c1']);
  });

  it('is the same asked twice: the request is not added to the phase a second time', async () => {
    await decide([{ commentId: 'c1', decision: 'DEFER', targetPhase: 'i0001-p2' }]);
    const again = await decide([{ commentId: 'c1', decision: 'DEFER', targetPhase: 'i0001-p2' }]);
    const asNew = await decide([{ commentId: 'c1', decision: 'DEFER', targetPhase: 'NEW' }]);

    expect(again.results[0]).toMatchObject({ ok: true, alreadyDecided: true });
    expect(asNew.results[0]).toMatchObject({ ok: true, alreadyDecided: true });
    expect((await phases())[1]!.notes).toHaveLength(1);
    expect(await phases()).toHaveLength(4); // and no phase was made by the "new" click
  });

  it('will not take back a deferral by "do it now" - it is recorded in the phase, and says where', async () => {
    await decide([{ commentId: 'c1', decision: 'DEFER', targetPhase: 'i0001-p2' }]);

    const { results } = await decide([{ commentId: 'c1', decision: 'DO_NOW' }]);

    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]!.error).toContain('already deferred to phase 2 ("Screens")');
  });

  it.each([
    ['a comment that is not in the triage', { commentId: 'zzz', decision: 'DEFER' as const, targetPhase: 'i0001-p2' }, 'not part of the latest triage'],
    ['no phase named and none suggested', { commentId: 'c2', decision: 'DEFER' as const }, 'Say which phase it goes to'],
    ['a phase of another project', { commentId: 'c1', decision: 'DEFER' as const, targetPhase: 'i0009-p2' }, 'i0009-p2 is not a phase of this project'],
    ['do it now for a comment that is already part of this pull request', { commentId: 'c4', decision: 'DO_NOW' as const }, 'already part of this pull request'],
  ])('refuses %s', async (_name, request, message) => {
    const { results } = await decide([request]);

    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]!.error).toContain(message);
    expect(handled()).toEqual([]);
  });

  it('refuses a phase that is delivered or already under way: it cannot take new work', async () => {
    await withStore(async (store) => {
      await store.updatePhase('i0001-p2', { status: 'MERGED' });
      await store.updatePhase('i0001-p3', { status: 'RUNNING' });
    });

    const merged = await decide([{ commentId: 'c1', decision: 'DEFER', targetPhase: 'i0001-p2' }]);
    const running = await decide([{ commentId: 'c1', decision: 'DEFER', targetPhase: 'i0001-p3' }]);

    expect(merged.results[0]!.error).toContain('already delivered');
    expect(running.results[0]!.error).toContain('not waiting any more');
    expect(handled()).toEqual([]);
  });

  it('can defer a comment the triage thought was a change request - the user has the last word', async () => {
    const { results } = await decide([{ commentId: 'c4', decision: 'DEFER', targetPhase: 'i0001-p3' }]);

    expect(results[0]).toMatchObject({ ok: true });
  });

  it('says so when the pull request is not a phase of a project', async () => {
    const { results, initiativeId } = await decideScope({ repoPath: REPO, number: 99, comments: comments(), decisions: [{ commentId: 'c1', decision: 'DO_NOW' }] });

    expect(initiativeId).toBeNull();
    expect(results[0]!.error).toContain('not a phase of a project');
  });

  it('carries out the ones it can and refuses the others, without stopping at the first refusal', async () => {
    const { results } = await decide([{ commentId: 'zzz', decision: 'DEFER', targetPhase: 'i0001-p2' }, { commentId: 'c1', decision: 'DEFER', targetPhase: 'i0001-p2' }]);

    expect(results.map((result) => result.ok)).toEqual([false, true]);
    expect(handled()).toEqual(['c1']);
  });

  describe('acknowledging on GitHub', () => {
    it('says only that it was noted and where it went - for a phase, and for a new one', async () => {
      const posted: string[] = [];
      const reply = vi.fn(async (comment: RevisionComment, body: string) => (posted.push(`${comment.id}: ${body}`), { posted: true }));

      const { results } = await decide([{ commentId: 'c1', decision: 'DEFER', targetPhase: 'i0001-p2' }, { commentId: 'c2', decision: 'DEFER', targetPhase: 'NEW' }], { replyOnGitHub: true, reply });

      expect(posted).toEqual([
        'c1: Noted. This is not part of this pull request; it goes to phase 2 of the roadmap ("Screens"), where it will be planned.',
        expect.stringMatching(/^c2: Noted\. This is not part of this pull request; it is now a phase of its own in the roadmap \("Could you add a keyboard shortcut for the theme toggle"\)/),
      ]);
      expect(results.map((result) => result.replied)).toEqual([true, true]);
    });

    it('does not post when replies are off, for "do it now", or for what was refused', async () => {
      const reply = vi.fn(async () => ({ posted: true }));

      await decide([{ commentId: 'c1', decision: 'DEFER', targetPhase: 'i0001-p2' }], { reply }); // off
      await decide([{ commentId: 'c2', decision: 'DO_NOW' }, { commentId: 'zzz', decision: 'DEFER', targetPhase: 'i0001-p2' }], { replyOnGitHub: true, reply });

      expect(reply).not.toHaveBeenCalled();
    });

    it('is not a failure of the decision when GitHub refuses the reply', async () => {
      const { results } = await decide([{ commentId: 'c1', decision: 'DEFER', targetPhase: 'i0001-p2' }], {
        replyOnGitHub: true,
        reply: async () => ({ posted: false, reason: 'gh is not logged in' }),
      });

      expect(results[0]).toMatchObject({ ok: true, replied: false, replyError: 'gh is not logged in' });
      expect(handled()).toEqual(['c1']);
    });
  });
});

describe('composeRevision with scope decisions', () => {
  const entry = (handledCommentIds: string[] = []): RegisteredPullRequest => ({
    key: KEY, repoPath: REPO, repoName: 'invest-track', number: 8, url: 'https://github.com/o/r/pull/8', title: 'Foundation', headBranch: 'factory/f0042/feat-x',
    baseBranch: 'main', rootRunId: 'run-1', latestRunId: 'run-1', round: 1, watchSince: '2026-01-01T00:00:00Z', state: 'OPEN', handledCommentIds,
    registeredAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  });
  const triage = (overrides: Partial<TriageSummary> = {}): TriageSummary => ({
    runId: 't1', pullRequest: 8, repository: REPO, status: 'RERUN_IMPLEMENTATION', summary: 's', followUpTask: 'Fix the contrast of the muted text.', blockers: [],
    branch: 'factory/f0042/feat-x', comments: comments(), ...overrides,
  });
  const compose = (input: Partial<Parameters<typeof composeRevision>[0]> = {}) => composeRevision({ entry: entry(), triage: triage(), ...input });

  it('leaves out a comment that waits for the user - it is not part of the round, and the round says so', () => {
    const result = compose();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revision.comments.map((comment) => comment.id)).toEqual(['c3', 'c4']);
    expect(result.notes).toEqual(['2 comments about a later phase are not in this round: they wait for your decision on where they belong.']);
    expect(result.revision.action).toBe('RERUN_IMPLEMENTATION');
    expect(result.task).toBe('Fix the contrast of the muted text.');
  });

  it('puts in a comment the user said to do now, as new scope - and re-plans, because the plan does not cover it', () => {
    const result = compose({ scopeDecisions: [{ commentId: 'c1', decision: 'DO_NOW' }] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revision.comments.map((comment) => [comment.id, comment.category])).toEqual([['c1', 'SCOPE_CHANGE'], ['c3', 'QUESTION'], ['c4', 'CODE_CHANGE_REQUEST']]);
    expect(result.revision.action).toBe('RERUN_PLANNING');
    expect(result.notes.join(' ')).toContain('Re-planning: a comment asks for work the plan does not cover');
    expect(result.task).toContain('Fix the contrast of the muted text.');
    expect(result.task).toContain('The user decided that these review comments belong in this pull request after all');
    expect(result.task).toContain('- marc (ui/src/Settings.jsx:12): Make the settings page dark too. It still has white cards.');
  });

  it('re-plans even when the human asked for implementation only: the work is not in the plan', () => {
    const result = compose({ action: 'RERUN_IMPLEMENTATION', scopeDecisions: [{ commentId: 'c1', decision: 'DO_NOW' }] });

    expect(result.ok && result.revision.action).toBe('RERUN_PLANNING');
  });

  it('makes a round out of "do it now" even when the triage said no code was needed', () => {
    const result = compose({ triage: triage({ status: 'REPLY_ONLY', followUpTask: '' }), scopeDecisions: [{ commentId: 'c2', decision: 'DO_NOW' }] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revision.action).toBe('RERUN_PLANNING');
    expect(result.revision.comments.map((comment) => comment.id)).toEqual(['c2', 'c3', 'c4']);
    expect(result.task).toMatch(/^Address the review comments on pull request #8\.\n\nThe user decided/);
  });

  it('does not put in a comment that was deferred, even if it was somehow not marked settled', () => {
    const result = compose({ scopeDecisions: [{ commentId: 'c1', decision: 'DEFER' }, { commentId: 'c2', decision: 'DO_NOW' }] });

    expect(result.ok && result.revision.comments.map((comment) => comment.id)).toEqual(['c2', 'c3', 'c4']);
  });

  it('has no round to make while the only comments left wait for the user - and says what to do', () => {
    const result = compose({ entry: entry(['c3', 'c4']), triage: triage({ status: 'REPLY_ONLY' }), action: 'RERUN_IMPLEMENTATION' });

    expect(result).toEqual({ ok: false, reason: 'The 2 remaining review comments belong to a later phase and wait for your decision: defer it to a phase, or do it in this pull request.' });
  });

  it('still says that nothing calls for code when that is all there is, and that all is handled when it is', () => {
    expect(compose({ triage: triage({ status: 'REPLY_ONLY' }) })).toMatchObject({ ok: false, reason: expect.stringContaining('does not call for code changes') });
    expect(compose({ entry: entry(['c1', 'c2', 'c3', 'c4']) })).toEqual({ ok: false, reason: 'Every review comment of this triage has already been handled.' });
  });

  it('is what it was for a triage with no later-phase comments at all', () => {
    const plain = triage({ comments: comments().filter((comment) => comment.category !== 'FUTURE_PHASE') });

    const result = composeRevision({ entry: entry(), triage: plain });

    expect(result.ok && result.notes).toEqual([]);
    expect(result.ok && result.revision.comments.map((comment) => comment.id)).toEqual(['c3', 'c4']);
  });
});

describe('what pr-check tells the Studio', () => {
  const review = (state = 'OPEN') => async () => ({
    number: 8, title: 'Foundation', state, url: 'https://github.com/o/r/pull/8', headBranch: 'factory/f0042/feat-x', baseBranch: 'main', comments: [],
  });
  const check = async () => (await checkPullRequests({ repoPath: REPO, fetchReview: review() as never })).pullRequests[0]!;

  beforeEach(async () => {
    await project();
    await registerPullRequest({ repoPath: REPO, number: 8, url: 'https://github.com/o/r/pull/8', title: 'Foundation', headBranch: 'factory/f0042/feat-x', baseBranch: 'main', runId: 'run-1' });
  });

  it('carries the roadmap, so a comment can be deferred to a phase, and what the user decided', async () => {
    await withStore((store) => store.recordScopeDecision({ prKey: KEY, commentId: 'c1', initiativeId: 'i0001', fromPhaseId: 'i0001-p1', targetPhaseId: null, decision: 'DO_NOW', excerpt: 'x' }));

    const pr = await check();

    expect(pr.roadmap).toEqual({
      initiativeId: 'i0001', title: 'Redesign the frontend', phaseId: 'i0001-p1', ordinal: 1, total: 4,
      phases: [
        { id: 'i0001-p1', ordinal: 1, title: 'Foundation', status: 'IN_REVIEW' },
        { id: 'i0001-p2', ordinal: 2, title: 'Screens', status: 'PLANNED' },
        { id: 'i0001-p3', ordinal: 3, title: 'Charts', status: 'PLANNED' },
        { id: 'i0001-p4', ordinal: 4, title: 'Cleanup', status: 'PLANNED' },
      ],
    });
    expect(pr.scopeDecisions).toEqual([{ commentId: 'c1', decision: 'DO_NOW', targetPhaseId: null }]);
  });

  it('says nothing of a roadmap for a plain task: there is no later phase to defer to', async () => {
    await withStore(async (store) => {
      for (const id of ['i0001-p2', 'i0001-p3', 'i0001-p4']) await store.updatePhase(id, { status: 'SKIPPED' });
    });

    const pr = await check();

    expect(pr.roadmap).toBeUndefined();
    expect(pr.scopeDecisions).toBeUndefined();
  });

  it('does not fail the check when the roadmap cannot be read - the comments are what it is for', async () => {
    // A log directory of its own whose database is a directory: the store cannot open there.
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-scope-broken-'));
    fs.mkdirSync(path.join(broken, 'initiatives.db'));
    vi.stubEnv('FACTORY_LOG_DIR', broken);
    await registerPullRequest({ repoPath: REPO, number: 8, url: 'https://github.com/o/r/pull/8', title: 'Foundation', headBranch: 'factory/f0042/feat-x', baseBranch: 'main', runId: 'run-1' });

    const result = await checkPullRequests({ repoPath: REPO, fetchReview: review() as never });

    expect(result.pullRequests).toHaveLength(1);
    expect(result.pullRequests[0]).toMatchObject({ number: 8, state: 'OPEN' });
    expect(result.pullRequests[0]!.roadmap).toBeUndefined();
    fs.rmSync(broken, { recursive: true, force: true });
  });
});

describe('scope-decide', () => {
  const run = async (flags: Record<string, string | boolean>) => {
    const out: string[] = [];
    const err: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (out.push(String(chunk)), true));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (err.push(String(chunk)), true));
    try {
      const code = await commandScopeDecide(flags);
      const line = out.join('').split('\n').find((candidate) => candidate.startsWith('SCOPE_DECIDE_JSON '));
      return { code, payload: line ? JSON.parse(line.slice('SCOPE_DECIDE_JSON '.length)) : null, stderr: err.join('') };
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  };

  it('needs the repository, the pull request and the decisions', async () => {
    expect((await run({ pr: '8', decisions: '[]' })).code).toBe(2);
    expect((await run({ repo: 'x', decisions: '[]' })).code).toBe(2);
    expect((await run({ repo: 'x', pr: '8' })).code).toBe(2);
  });

  it.each([
    ['not JSON', '{ nope', 'not valid JSON'],
    ['an empty list', '[]', 'decisions'],
    ['a decision it does not know', '[{"commentId":"c1","decision":"MAYBE"}]', 'decision'],
    ['a field it does not know', '[{"commentId":"c1","decision":"DEFER","phase":"x"}]', 'decisions'],
  ])('says the decisions are not valid: %s', async (_name, decisions, mention) => {
    const result = await run({ repo: 'x', pr: '8', decisions });

    expect(result.code).toBe(1);
    expect(result.payload.error).toContain(mention);
  });
});
