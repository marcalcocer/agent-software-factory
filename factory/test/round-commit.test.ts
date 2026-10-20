import { describe, expect, it } from 'vitest';

import { RUN, readJson } from '../../fixtures';
import { composeRevision, readTriageSummary } from '../src/cli/revision.ts';
import { revisionCommitMessage } from '../src/workflows/software-factory.workflow.ts';
import type { Revision } from '../src/utils/schemas.ts';

const revision = (over: Partial<Revision> = {}): Revision => ({
  parentRunId: 'R1',
  rootRunId: 'R1',
  round: 2,
  action: 'RERUN_IMPLEMENTATION',
  originalTask: 'Task',
  pullRequest: { number: 8, url: 'https://github.com/o/r/pull/8', headBranch: 'b', baseBranch: 'master' },
  comments: [
    { id: 'c1', source: 'REVIEW_THREAD', author: 'marc', body: 'Some findings I see testing the UI:\n- dark mode', path: 'ui/src/Summary.jsx', line: 3, category: 'CODE_CHANGE_REQUEST' },
    { id: 'c2', source: 'REVIEW_THREAD', author: 'marc', body: 'Is this the only phase?', category: 'QUESTION' },
  ],
  ...over,
});

describe('revisionCommitMessage: the plain message of a round, when the PR writer cannot answer', () => {
  it('says what the round is about when the triage named it', () => {
    expect(revisionCommitMessage(revision({ title: 'Finish dark mode on the investment pages.' })).split('\n')[0]).toBe(
      'chore: finish dark mode on the investment pages',
    );
  });

  it('says it addresses review feedback on the pull request when nothing named the round', () => {
    expect(revisionCommitMessage(revision()).split('\n')[0]).toBe('chore: address review feedback on PR #8 (round 2)');
  });

  it('lists the comments that asked for a change, by author and place, and not the questions', () => {
    const lines = revisionCommitMessage(revision()).split('\n');
    expect(lines.filter((line) => line.startsWith('- '))).toEqual(['- marc (ui/src/Summary.jsx:3): Some findings I see testing the UI:']);
  });

  it('names the round the way the real triage of the UI refactor did', () => {
    const triage = { ...readTriageSummary(RUN.prTriage)!, roundTitle: 'Finish dark mode on the investment pages' };
    const result = composeRevision({
      entry: {
        key: 'k', repoPath: '/home/dev/workspace/invest-track', repoName: 'invest-track', number: 8,
        url: 'https://github.com/marcalcocer/invest-track/pull/8', title: 'PR', headBranch: 'factory/x', baseBranch: 'master',
        rootRunId: RUN.round1, latestRunId: RUN.round1, round: 1, watchSince: '', state: 'OPEN', handledCommentIds: [], registeredAt: '', updatedAt: '',
      },
      triage,
    });
    expect(result.ok && result.revision.title).toBe('Finish dark mode on the investment pages');
    expect(readJson(RUN.round2, 'run.json').task).toContain('finish the dark-mode work started in PR #8');
  });
});
