import { describe, expect, it } from 'vitest';

import { RUN, readJson } from '../../fixtures';
import {
  cleanLabels,
  composeCommitMessage,
  fallbackPrText,
  normalizePrWriterOutput,
  polishNote,
  withFollowUps,
  qualityGatesSection,
  removeSection,
  withQualityGates,
  type PrTextContext,
} from '../src/tools/pr-text.ts';

/** The context the PR writer worked from in round 1, rebuilt from the artifacts that run left. */
function round1Context(over: Partial<PrTextContext> = {}): PrTextContext {
  const data = (file: string) => readJson(RUN.round1, file).data;
  return {
    task: readJson(RUN.round1, 'run.json').task,
    plan: data('01-pm-architect.json').plan,
    developer: data('02-developer.attempt-2.json'),
    qa: data('03-qa-tester.attempt-2.json'),
    review: data('05-code-review.attempt-2.json'),
    security: data('06-security.attempt-2.json'),
    documentation: data('07-documentation.attempt-2.json'),
    pipeline: { qa: true, review: true, security: true, documentation: true },
    files: [],
    ...over,
  };
}

const gatesOf = (body: string): string => /## Quality gates[\s\S]*?(?=\n## |$)/.exec(body)![0].trim();

describe('the Quality gates section is the factory\'s own', () => {
  it('reproduces, from the reports, the section the real pull request carried', () => {
    const published = readJson(RUN.round1, '07-pr-writer.attempt-2.json').data.pullRequest.body;

    expect(qualityGatesSection(round1Context())).toBe(gatesOf(published));
  });

  it('says plainly what did not run', () => {
    const section = qualityGatesSection(
      round1Context({ pipeline: { qa: false, review: false, security: true, documentation: false } }),
    );

    expect(section).toContain('- QA: not run (disabled for this task)');
    expect(section).toContain('- Code review: not run (disabled for this task)');
    expect(section).toContain('- Documentation: not run (disabled for this task)');
    expect(section).toContain('- Security audit: PASS (no risk found)');
  });

  it('does not claim a result that was never recorded', () => {
    const section = qualityGatesSection(round1Context({ qa: null, review: null, security: null, documentation: null }));
    expect(section.match(/no result was recorded/g)).toHaveLength(4);
  });

  it('replaces a section a model wrote anyway, and keeps it before the risks', () => {
    const body = '## Summary\nS\n\n## Quality gates\n- QA: PASS - everything is great\n\n## Risks & rollback\nR';
    const result = withQualityGates(body, '## Quality gates\n\n- QA: FAIL');

    expect(result).not.toContain('everything is great');
    expect(result.indexOf('## Quality gates')).toBeLessThan(result.indexOf('## Risks & rollback'));
    expect(result.match(/## Quality gates/g)).toHaveLength(1);
  });

  it('puts the section at the end when there are no risks or follow-ups', () => {
    expect(withQualityGates('## Summary\nS', '## Quality gates\n\n- x')).toBe('## Summary\nS\n\n## Quality gates\n\n- x');
  });

  it('removes only the named section', () => {
    expect(removeSection('## A\n1\n\n## B\n2\n\n## C\n3', 'B')).toBe('## A\n1\n\n## C\n3');
    expect(removeSection('## A\n1', 'Z')).toBe('## A\n1');
  });
});

describe('normalizePrWriterOutput on the real writer output', () => {
  const real = readJson(RUN.round1, '07-pr-writer.attempt-2.json').data;
  const [subject = '', , ...rest] = String(real.commitMessage).split('\n');
  const agentOutput = {
    commitMessage: { subject, body: rest.join('\n').trim() },
    pullRequest: { ...real.pullRequest, labels: ['enhancement', 'Enhancement', ' ', 'a'.repeat(60)] },
  };

  it('gives back the text that was published', () => {
    const text = normalizePrWriterOutput(agentOutput, round1Context());

    expect(text.source).toBe('agent');
    expect(text.commitMessage).toBe(real.commitMessage);
    expect(text.pullRequest.title).toBe(real.pullRequest.title);
    expect(text.pullRequest.body).toBe(real.pullRequest.body);
  });

  it('cleans labels: trimmed, unique, not empty, not absurdly long', () => {
    expect(normalizePrWriterOutput(agentOutput, round1Context()).pullRequest.labels).toEqual(['enhancement']);
    expect(cleanLabels(['a', 'b', 'c', 'd', 'e', 'f'])).toHaveLength(5);
  });

  it('falls back to the plan\'s message when the writer gave no subject', () => {
    const text = normalizePrWriterOutput(
      { commitMessage: { subject: '  ', body: '' }, pullRequest: { title: '', body: 'B', labels: [], breakingChanges: false } },
      round1Context(),
    );

    expect(text.commitMessage).toBe('feat(ui): add design tokens, dark mode and modern app shell');
    expect(text.pullRequest.title).toBe(text.commitMessage);
  });
});

/** Every file round 1 changed, which is what git reports: attempt 1 wrote most, attempt 2 the fix. */
const round1Files = (): string[] => [
  ...new Set(
    ['02-developer.json', '02-developer.attempt-2.json'].flatMap((file) =>
      readJson(RUN.round1, file).data.changedFiles.map((entry: { path: string }) => entry.path),
    ),
  ),
];

describe('fallbackPrText: the same text from the reports alone', () => {
  it('describes the run without a model, says why, and is marked as a fallback', () => {
    const text = fallbackPrText(round1Context({ files: round1Files() }), 'The AI could not write this text.');

    expect(text.source).toBe('fallback');
    expect(text.note).toBe('The AI could not write this text.');
    expect(text.commitMessage).toBe('feat(ui): add design tokens, dark mode and modern app shell');
    for (const heading of ['## Summary', '## Changes', '## Test plan', '## Quality gates', '## Follow-ups']) {
      expect(text.pullRequest.body).toContain(heading);
    }
  });

  it('lists the files of the whole change, not only those of the last attempt', () => {
    // After a retry the developer report covers the retry alone: 3 of the 21 files in this run.
    const files = round1Files();
    expect(files.length).toBe(21);
    const changes = /## Changes\n\n([\s\S]*?)\n\n## /.exec(fallbackPrText(round1Context({ files })).pullRequest.body)![1]!;

    expect(changes.split('\n')).toHaveLength(13); // twelve files and "and 9 more files"
    expect(changes).toContain('- and 9 more files');
    expect(changes).toContain('`ui/src/lib/cn.js`');
  });

  it('keeps the purpose the developer gave for a file it did report', () => {
    const changes = fallbackPrText(round1Context({ files: ['ui/src/lib/currencyAdapter.js'] })).pullRequest.body;
    expect(changes).toContain('- `ui/src/lib/currencyAdapter.js` - Add formatPercentForPrivacy helper');
  });

  it('uses the developer report for the list only when git gave none', () => {
    const changes = fallbackPrText(round1Context({ files: [] })).pullRequest.body;
    expect(changes).toContain('`ui/src/components/investments/Summary.jsx`');
    expect(changes).not.toContain('`ui/src/lib/cn.js`');
  });

  it('says the tests were not run when QA was off', () => {
    const text = fallbackPrText(round1Context({ pipeline: { qa: false, review: true, security: true, documentation: true } }));
    expect(text.pullRequest.body).toContain('Not run: the QA stage was disabled for this task.');
  });

  it('counts the files beyond a dozen when there is no developer report at all', () => {
    const files = Array.from({ length: 15 }, (_, i) => `src/f${i}.ts`);
    const text = fallbackPrText(round1Context({ developer: null, files }));
    expect(text.pullRequest.body).toContain('- and 3 more files');
  });

  it('still produces a title when there is no plan at all', () => {
    const text = fallbackPrText({ ...round1Context(), plan: null, developer: null, task: 'Fix the token refresh race' });
    expect(text.pullRequest.title).toBe('Fix the token refresh race');
  });
});

describe('composeCommitMessage', () => {
  it('is the subject alone when there is no body', () => {
    expect(composeCommitMessage('feat: x.', '')).toBe('feat: x');
    expect(composeCommitMessage('feat: x', 'Why.')).toBe('feat: x\n\nWhy.');
  });
});

describe('what the pull request says about the polish pass', () => {
  const candidate = (id: string, file: string, line: number, problem: string) => ({
    id, source: 'review' as const, severity: 'MINOR', file, line, problem, fix: 'Do it.',
  });
  const base = {
    candidates: [
      candidate('REV-1', 'ui/src/Summary.jsx', 57, 'Sign colour reveals the hidden sign'),
      candidate('REV-2', 'ui/src/theme.test.js', 1, 'var and const are mixed'),
      candidate('REV-3', 'ui/src/ThemeToggle.jsx', 6, 'Icon is wrong for a moment on hydration'),
    ],
    applied: [] as string[],
    declined: [] as Array<{ id: string; reason: string }>,
    unanswered: [] as string[],
    reported: [] as Array<{ source: 'security' | 'qa' | 'review'; summary: string; reason: string }>,
    changedFiles: [] as string[],
    changedLines: 0,
  };

  it('says code changed after the review approved it, and what was left', () => {
    const note = polishNote({
      ...base,
      status: 'APPLIED',
      applied: ['REV-1'],
      declined: [{ id: 'REV-2', reason: 'the rule is written for Java' }],
      unanswered: ['REV-3'],
      changedFiles: ['ui/src/Summary.jsx'],
      changedLines: 4,
    })!;

    expect(note.line).toBe('Polish: fixed 1 of 3 minor findings - 1 file changed after the review, tests and build passed again');
    expect(note.followUps).toEqual([
      'ui/src/theme.test.js:1: var and const are mixed (not fixed: the rule is written for Java)',
      'ui/src/ThemeToggle.jsx:6: Icon is wrong for a moment on hydration (not fixed)',
    ]);
  });

  it('puts the polish line between the audit and the documentation in the quality gates', () => {
    const section = qualityGatesSection({
      ...round1Context(),
      polish: { ...base, status: 'APPLIED', applied: ['REV-1'], changedFiles: ['a.ts'], changedLines: 2 },
    });
    const lines = section.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.split(':')[0]);

    expect(lines).toEqual(['- QA', '- Code review', '- Security audit', '- Polish', '- Documentation']);
  });

  it('has no polish line for a run that never reached the pass', () => {
    expect(qualityGatesSection(round1Context())).not.toContain('Polish');
    expect(polishNote(null)).toBeNull();
  });

  it('lists every finding as not fixed when the pass was undone, and says why', () => {
    const note = polishNote({ ...base, status: 'REVERTED', reason: 'CHECKS_FAILED', detail: 'The test suite failed after the fixes (exit 1).' })!;

    expect(note.line).toBe('Polish: undone, The test suite failed after the fixes (exit 1).');
    expect(note.followUps).toHaveLength(3);
    expect(note.followUps.every((item) => item.endsWith('(not fixed)'))).toBe(true);
  });

  it.each([
    [{ status: 'NONE' as const }, 'Polish: no minor findings to fix'],
    [{ status: 'SKIPPED' as const, reason: 'DISABLED' }, 'Polish: not run (disabled for this task)'],
    [{ status: 'SKIPPED' as const, reason: 'NEEDS_QA' }, 'Polish: not run (it needs the QA stage to check its fixes)'],
    [{ status: 'DECLINED' as const }, 'Polish: 3 minor findings looked at, nothing changed'],
    [{ status: 'FAILED' as const, detail: 'usage limit reached' }, 'Polish: could not run (usage limit reached)'],
  ])('%j reads %s', (change, line) => {
    expect(polishNote({ ...base, ...change })!.line).toBe(line);
  });

  it('lists the minor findings when the pass was switched off, because nothing else will fix them', () => {
    const note = polishNote({ ...base, status: 'SKIPPED', reason: 'DISABLED', detail: 'Stage disabled for this task.' })!;

    expect(note.line).toBe('Polish: not run (disabled for this task)');
    expect(note.followUps).toEqual([
      'ui/src/Summary.jsx:57: Sign colour reveals the hidden sign (not fixed)',
      'ui/src/theme.test.js:1: var and const are mixed (not fixed)',
      'ui/src/ThemeToggle.jsx:6: Icon is wrong for a moment on hydration (not fixed)',
    ]);
  });

  it('keeps what the gates reported but never acted on in the follow-ups, except nits', () => {
    const note = polishNote({
      ...base,
      candidates: [],
      status: 'NONE',
      reported: [
        { source: 'security', summary: 'XSS in ui/src/lib/ChartUtils.js:37: self-XSS', reason: 'informational' },
        { source: 'review', summary: 'naming', reason: 'a nit' },
      ],
    })!;

    expect(note.followUps).toEqual(['XSS in ui/src/lib/ChartUtils.js:37: self-XSS (informational)']);
  });

  it('puts the unfixed findings in the follow-ups of the plain description as well', () => {
    const text = fallbackPrText({
      ...round1Context(),
      polish: { ...base, status: 'DECLINED', declined: [{ id: 'REV-2', reason: 'style only' }], unanswered: ['REV-1', 'REV-3'] },
    });

    expect(text.pullRequest.body).toContain('(not fixed: style only)');
    expect(text.pullRequest.body).toContain('- Polish: 3 minor findings looked at, nothing changed');
  });
});

describe('withFollowUps', () => {
  it('creates the section at the end when the description has none', () => {
    expect(withFollowUps('## Summary\nS', ['a: x (not fixed)', 'b: y (not fixed)'])).toBe(
      '## Summary\nS\n\n## Follow-ups\n\n- a: x (not fixed)\n- b: y (not fixed)',
    );
  });

  it('adds to the section the model wrote, and leaves what comes after it where it was', () => {
    const body = '## Summary\nS\n\n## Follow-ups\n- Decide on a changelog\n\n## Notes\nN';
    expect(withFollowUps(body, ['a: x (not fixed)'])).toBe(
      '## Summary\nS\n\n## Follow-ups\n- Decide on a changelog\n- a: x (not fixed)\n\n## Notes\nN',
    );
  });

  it('does not repeat an item that is already there, and does nothing for no items', () => {
    const body = '## Follow-ups\n- a: x (not fixed)';
    expect(withFollowUps(body, ['a: x (not fixed)'])).toBe(body);
    expect(withFollowUps('## Summary\nS', [])).toBe('## Summary\nS');
  });

  it('finds the heading however it is written', () => {
    for (const heading of ['## Follow-ups', '## Follow ups', '## Followups', '## follow-up']) {
      const result = withFollowUps(`${heading}\n- one`, ['two']);
      expect(result).toBe(`${heading}\n- one\n- two`);
    }
  });
});

describe('the description the agent wrote reaches the pull request with the factory\'s own parts', () => {
  const real = readJson(RUN.round1, '07-pr-writer.attempt-2.json').data;
  const [subject = '', , ...rest] = String(real.commitMessage).split('\n');

  it('lists the unfixed minor findings even when the model said nothing about them', () => {
    const text = normalizePrWriterOutput(
      { commitMessage: { subject, body: rest.join('\n').trim() }, pullRequest: { ...real.pullRequest, body: '## Summary\nA change.\n\n## Changes\n- x', labels: [] } },
      {
        ...round1Context(),
        polish: {
          status: 'SKIPPED', reason: 'DISABLED', changedFiles: [], changedLines: 0, applied: [], declined: [], unanswered: [], reported: [],
          candidates: [{ id: 'REV-1', source: 'review', severity: 'MINOR', file: 'ui/src/Summary.jsx', line: 57, problem: 'Sign colour reveals the hidden sign', fix: 'x' }],
        },
      },
    );

    expect(text.pullRequest.body).toContain('- Polish: not run (disabled for this task)');
    expect(text.pullRequest.body).toMatch(/## Follow-ups\n\n- ui\/src\/Summary.jsx:57: Sign colour reveals the hidden sign \(not fixed\)$/);
  });
});
