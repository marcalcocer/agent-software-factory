import { describe, expect, it } from 'vitest';

import { RUN, readJson } from '../../fixtures';
import {
  assessMerge,
  cleanBody,
  cleanSubject,
  clipAtWord,
  condenseDiff,
  describePullRequest,
  explainAgentFailure,
  explainMergeFailure,
  fallbackSquashMessage,
  normalizeSquashMessage,
  summarizeChecks,
  withPullRequestReference,
  type Mergeability,
} from '../src/tools/pr-merge-rules.ts';

const ready: Mergeability = {
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeState: 'CLEAN',
  reviewDecision: '',
  checks: { total: 0, failing: 0, pending: 0 },
  baseBranch: 'master',
};

describe('assessMerge', () => {
  it('lets a clean pull request through', () => {
    expect(assessMerge(ready)).toEqual({ blockers: [], warnings: [], transient: false });
  });

  it.each([
    [{ isDraft: true }, 'still a draft'],
    [{ mergeable: 'CONFLICTING' }, 'conflicts with master'],
    [{ mergeState: 'DIRTY' }, 'conflicts with master'],
    [{ mergeState: 'BEHIND' }, 'behind master'],
    [{ mergeState: 'BLOCKED' }, 'required review or check'],
    [{ state: 'MERGED' }, 'already merged'],
    [{ state: 'CLOSED' }, 'is closed'],
  ] as Array<[Partial<Mergeability>, string]>)('refuses %j (%s)', (change, text) => {
    const { blockers } = assessMerge({ ...ready, ...change });
    expect(blockers.join(' ')).toContain(text);
  });

  it('waits a moment, rather than refusing for good, while GitHub works out mergeability', () => {
    const result = assessMerge({ ...ready, mergeable: 'UNKNOWN' });
    expect(result.transient).toBe(true);
    expect(result.blockers).toHaveLength(1);
  });

  it('only warns about failing and running checks and requested changes', () => {
    const result = assessMerge({
      ...ready,
      checks: { total: 3, failing: 1, pending: 2 },
      reviewDecision: 'CHANGES_REQUESTED',
    });
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([
      '1 check is failing.',
      '2 checks are still running.',
      'A reviewer has requested changes on GitHub.',
    ]);
  });
});

describe('summarizeChecks', () => {
  it('counts check runs and commit statuses alike', () => {
    expect(
      summarizeChecks([
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
        { status: 'IN_PROGRESS' },
        { state: 'ERROR' },
        { state: 'PENDING' },
        { state: 'SUCCESS' },
      ]),
    ).toEqual({ total: 6, failing: 2, pending: 2 });
  });

  it('copes with nothing, and with rubbish', () => {
    expect(summarizeChecks(null)).toEqual({ total: 0, failing: 0, pending: 0 });
    expect(summarizeChecks([null, 7])).toEqual({ total: 2, failing: 0, pending: 0 });
  });
});

describe('explainMergeFailure', () => {
  it.each([
    ['Pull request head branch was modified', 'The branch changed while merging'],
    ['Squash merges are not allowed on this repository', 'Squash merging is turned off'],
    ['the base branch policy prohibits the merge; required status check', 'branch protection rule'],
    ['Pull request is not mergeable: merge conflict', 'has conflicts'],
    ['To get started with GitHub CLI, please run: gh auth login', '`gh auth login`'],
  ])('%j becomes something a person can act on', (output, expected) => {
    expect(explainMergeFailure(output, 1)).toContain(expected);
  });

  it('does not mistake a policy refusal for a conflict', () => {
    expect(explainMergeFailure('is not mergeable: the base branch policy prohibits the merge', 1)).toContain('branch protection');
  });

  it('falls back to the first line of what gh said', () => {
    expect(explainMergeFailure('\n  something odd\nsecond line', 4)).toBe('gh pr merge failed (exit 4): something odd');
  });
});

describe('explainAgentFailure', () => {
  it.each([
    ['Agent "x" failed [claude-cli/auth]: OAuth session expired, run claude login', 'not signed in'],
    ["You've hit your session limit", 'usage limit'],
    ['Claude Code did not answer within the timeout', 'did not answer in time'],
    ['spawn claude ENOENT', 'not installed'],
  ])('%j', (message, expected) => {
    expect(explainAgentFailure(message)).toContain(expected);
  });

  it('drops the agent/step preamble from an unknown error', () => {
    expect(explainAgentFailure('Agent "pr-writer" failed during step "pr-writer" [claude-cli/api]: weird failure')).toBe('weird failure');
  });
});

describe('the squash message', () => {
  it('cleans a subject: one line, no quotes, no final full stop', () => {
    expect(cleanSubject('\n  "Add pagination."  \nsecond line')).toBe('Add pagination');
  });

  it('adds the pull request reference once, never twice', () => {
    expect(withPullRequestReference('Add pagination.', 12)).toBe('Add pagination (#12)');
    expect(withPullRequestReference('Add pagination (#12)', 12)).toBe('Add pagination (#12)');
    expect(withPullRequestReference('', 12)).toBe('(#12)');
  });

  it('matches the message the real merge agent produced', () => {
    const real = readJson(RUN.mergeSummary, '12-merge-summary.json').data.message;
    const subjectWithoutReference = real.subject.replace(/ \(#8\)$/, '');

    expect(withPullRequestReference(subjectWithoutReference, 8)).toBe(real.subject);
    expect(normalizeSquashMessage({ subject: subjectWithoutReference, body: real.body }, 8)).toEqual({
      subject: real.subject,
      body: real.body,
    });
  });

  it('drops a body that opens by repeating the subject', () => {
    expect(normalizeSquashMessage({ subject: 'Add pagination', body: 'Add pagination.\n\nMore detail.' }, 3)).toEqual({
      subject: 'Add pagination (#3)',
      body: 'More detail.',
    });
  });

  it('cuts at a word, and never leaves the text longer than asked', () => {
    const text = clipAtWord('one two three four five six seven', 20);
    expect(text.length).toBeLessThanOrEqual(20);
    expect(text.endsWith('...')).toBe(true);
    expect(text).not.toMatch(/\bfiv\b/);
    expect(clipAtWord('short', 20)).toBe('short');
  });

  it('unwraps a body in a code fence and collapses blank lines', () => {
    expect(cleanBody('```md\nline  \n\n\n\nnext\n```')).toBe('line\n\nnext');
  });

  it('describes a pull request by its Summary paragraph', () => {
    const body = '<!-- template -->\n## Summary\nFirst line\nsecond line.\n\nOther paragraph.\n\n## Changes\n- a';
    expect(describePullRequest(body)).toBe('First line second line.');
    expect(describePullRequest('Plain text only.')).toBe('Plain text only.');
    expect(describePullRequest('')).toBe('');
  });

  it('writes a plain message from the pull request itself when no agent could', () => {
    const files = Array.from({ length: 10 }, (_, i) => ({ path: `src/f${i}.ts`, additions: i, deletions: 1 }));
    const message = fallbackSquashMessage({
      number: 8,
      title: 'Add design tokens',
      body: '## Summary\nTokens and dark mode.',
      commits: [{ headline: 'first' }],
      files,
    });

    expect(message.subject).toBe('Add design tokens (#8)');
    expect(message.body).toContain('Tokens and dark mode.');
    expect(message.body).toContain('- src/f0.ts (+0 -1)');
    expect(message.body).toContain('- and 2 more files');
  });
});

describe('condenseDiff: what an agent is given of a large diff', () => {
  const file = (name: string, lines: number) =>
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+line ${i}`).join('\n')}\n`;

  it('leaves out lockfiles, minified bundles and source maps, and says so', () => {
    const result = condenseDiff(file('src/a.ts', 3) + file('package-lock.json', 3) + file('dist/app.min.js', 3) + file('app.js.map', 3));

    expect(result.omitted).toEqual(['package-lock.json', 'dist/app.min.js', 'app.js.map']);
    expect(result.text).toContain('src/a.ts');
    expect(result.text).not.toContain('package-lock.json');
  });

  it('keeps the start of a very long file and says it was cut', () => {
    const result = condenseDiff(file('big.ts', 50), { maxLinesPerFile: 10 });

    expect(result.shortened).toEqual(['big.ts']);
    expect(result.text).toContain('more lines of big.ts left out');
  });

  it('stays under the size limit by leaving whole files out, and lists them', () => {
    const result = condenseDiff(file('a.ts', 20) + file('b.ts', 20) + file('c.ts', 20), { maxChars: 700 });

    expect(result.text.length).toBeLessThanOrEqual(700);
    expect(result.omitted.length).toBeGreaterThan(0);
    expect(result.text).toContain('a.ts');
  });

  it('is empty for an empty diff', () => {
    expect(condenseDiff('')).toEqual({ text: '', omitted: [], shortened: [] });
  });
});
