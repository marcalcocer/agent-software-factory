import { describe, expect, it } from 'vitest';

import { RUN, readJson } from '../../fixtures';
import {
  cleanLabels,
  composeCommitMessage,
  fallbackPrText,
  normalizePrWriterOutput,
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
