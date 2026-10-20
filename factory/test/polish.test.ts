import { describe, expect, it } from 'vitest';

import { RUN, readJson } from '../../fixtures';
import {
  MAX_POLISH_CHANGED_LINES,
  MAX_POLISH_FILES,
  MAX_POLISH_FINDINGS,
  assertionsLost,
  judgePolish,
  readAnswer,
  renderCandidates,
  selectPolish,
  type PolishCandidate,
  type PolishFacts,
} from '../src/tools/polish.ts';
import type { QaReport, ReviewReport, SecurityReport } from '../src/utils/schemas.ts';

/** The gates' reports of the attempt that passed, from a real run. */
const gates = (runId: string) => ({
  qa: readJson(runId, '03-qa-tester.attempt-2.json').data as QaReport,
  review: readJson(runId, '05-code-review.attempt-2.json').data as ReviewReport,
  security: readJson(runId, '06-security.attempt-2.json').data as SecurityReport,
});

describe('what the polish pass would have picked up in the real UI refactor', () => {
  it('round 1: the privacy leak QA and the reviewer both named, and the reviewer\'s other minors', () => {
    const { candidates, reported } = selectPolish(gates(RUN.round1));

    expect(candidates.map((c) => [c.id, c.source])).toEqual([
      ['QA-1', 'qa'],
      ['REV-1', 'review'],
      ['REV-2', 'review'],
      ['REV-3', 'review'],
    ]);
    // QA's bug and the reviewer's first finding are one problem: the sign colour of a masked value.
    expect(candidates[0]!.problem).toContain('Profit and Benefit keep sign colouring in privacy mode');
    expect(candidates[1]!).toMatchObject({ file: 'ui/src/components/investments/Summary.jsx', line: 57 });
    expect(candidates[1]!.fix).toContain('isPrivate ? undefined : signClass(benefit)');
    expect(reported).toEqual([]);
  });

  it('round 2: the reviewer\'s four minors; the XSS that was there before is only reported', () => {
    const { candidates, reported } = selectPolish(gates(RUN.round2));

    expect(candidates.map((c) => c.id)).toEqual(['REV-1', 'REV-2', 'REV-3', 'REV-4']);
    expect(candidates.map((c) => c.file)).toEqual([
      'ui/src/lib/usePrivacyMode.js',
      'ui/src/components/Home.jsx',
      'ui/src/components/investments/Investment.jsx',
      'ui/src/lib/__tests__/chartTheme.test.js',
    ]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ source: 'security', reason: 'informational' });
    expect(reported[0]!.summary).toContain('XSS in ui/src/lib/ChartUtils.js:37');
  });

  it('renders the findings so the developer can answer each by its id', () => {
    const text = renderCandidates(selectPolish(gates(RUN.round2)).candidates);

    expect(text).toContain('### REV-2 (review, MINOR)');
    expect(text).toContain('- Where: ui/src/components/Home.jsx:77');
    expect(text).toContain('- Fix: Remove the comment.');
  });
});

describe('selectPolish', () => {
  const security = (over: Record<string, unknown>) =>
    ({
      status: 'PASS_WITH_WARNINGS',
      riskLevel: 'LOW',
      summary: '',
      findings: [
        {
          severity: 'LOW', category: 'XSS', owasp: null, cwe: null, file: 'src/a.js', line: 3,
          evidence: 'innerHTML with a name', impact: 'self-XSS', remediation: 'Escape the name.', preExisting: false,
          ...over,
        },
      ],
      secretsDetected: [],
      dependencyRisks: [],
      mustFixBeforeMerge: [],
    }) as SecurityReport;

  it('fixes LOW and MEDIUM security findings that this change introduced', () => {
    expect(selectPolish({ qa: null, review: null, security: security({}) }).candidates).toHaveLength(1);
    expect(selectPolish({ qa: null, review: null, security: security({ severity: 'MEDIUM' }) }).candidates).toHaveLength(1);
  });

  it('leaves HIGH and CRITICAL to the retry loop, which blocks on them', () => {
    for (const severity of ['HIGH', 'CRITICAL']) {
      expect(selectPolish({ qa: null, review: null, security: security({ severity }) })).toEqual({ candidates: [], reported: [] });
    }
  });

  it('only reports a problem that was already there, and one with no fix to apply', () => {
    expect(selectPolish({ qa: null, review: null, security: security({ preExisting: true }) }).reported[0]!.reason).toBe(
      'it was there before this change',
    );
    expect(selectPolish({ qa: null, review: null, security: security({ remediation: '  ' }) }).reported[0]!.reason).toBe(
      'no concrete fix was given',
    );
  });

  it('does not touch NITs, and does not act on a review remark without a fix', () => {
    const review = {
      findings: [
        { severity: 'NIT', file: 'a.ts', line: 1, issue: 'naming', suggestion: 'rename it', rule: null },
        { severity: 'MINOR', file: 'b.ts', line: 2, issue: 'maybe unclear', suggestion: '', rule: null },
        { severity: 'MAJOR', file: 'c.ts', line: 3, issue: 'blocks', suggestion: 'fix it', rule: null },
      ],
    } as ReviewReport;

    const { candidates, reported } = selectPolish({ qa: null, review, security: null });
    expect(candidates).toEqual([]);
    expect(reported.map((r) => r.reason)).toEqual(['a nit', 'no concrete fix was given']); // the MAJOR is the loop's
  });

  it('puts security first, then what QA saw, then the review', () => {
    const { candidates } = selectPolish({
      qa: { bugReports: [{ title: 'Bug', severity: 'MINOR', stepsToReproduce: [], expected: 'works', actual: 'does not', evidence: 'x:1' }] } as unknown as QaReport,
      review: { findings: [{ severity: 'MINOR', file: 'r.ts', line: 1, issue: 'i', suggestion: 's', rule: null }] } as ReviewReport,
      security: security({}),
    });
    expect(candidates.map((c) => c.id)).toEqual(['SEC-1', 'QA-1', 'REV-1']);
  });

  it('keeps to a handful and reports the rest', () => {
    const review = {
      findings: Array.from({ length: 12 }, (_, i) => ({ severity: 'MINOR', file: `f${i}.ts`, line: i, issue: `issue ${i}`, suggestion: `fix ${i}`, rule: null })),
    } as ReviewReport;

    const { candidates, reported } = selectPolish({ qa: null, review, security: null });
    expect(candidates).toHaveLength(MAX_POLISH_FINDINGS);
    expect(reported).toHaveLength(12 - MAX_POLISH_FINDINGS);
    expect(reported[0]!.reason).toContain(`more than ${MAX_POLISH_FINDINGS}`);
  });

  it('copes with gates that did not run', () => {
    expect(selectPolish({ qa: null, review: null, security: null })).toEqual({ candidates: [], reported: [] });
  });
});

describe('readAnswer', () => {
  const candidates = ['SEC-1', 'QA-1', 'REV-1', 'REV-2'].map(
    (id) => ({ id, source: 'review', severity: 'MINOR', file: null, line: null, problem: '', fix: '' }) as PolishCandidate,
  );

  it('tells what was fixed and what was declined, by the ids the developer started its lines with', () => {
    const answer = readAnswer(candidates, {
      appliedFeedback: ['QA-1: neutral colour when private', 'REV-1: fixed together with QA-1'],
      followUps: ['REV-2: Not applied - the rule is written for Java, JS here is mixed', 'Dark mode of the chart toolbar is still open'],
    });

    expect(answer.applied).toEqual(['QA-1', 'REV-1']);
    expect(answer.declined).toEqual([{ id: 'REV-2', reason: 'the rule is written for Java, JS here is mixed' }]);
    expect(answer.unanswered).toEqual(['SEC-1']);
    expect(answer.loose).toEqual(['Dark mode of the chart toolbar is still open']);
  });

  it('does not count a finding as declined when it was also fixed', () => {
    const answer = readAnswer(candidates, { appliedFeedback: ['REV-1: done'], followUps: ['REV-1: Not applied - changed my mind'] });
    expect(answer.applied).toEqual(['REV-1']);
    expect(answer.declined).toEqual([]);
  });

  it('ignores ids it was not given, and keeps what it could not read', () => {
    const answer = readAnswer(candidates, { appliedFeedback: ['REV-9: something unknown', 'fixed the colour'], followUps: [] });
    expect(answer.applied).toEqual([]);
    expect(answer.loose).toEqual(['REV-9: something unknown', 'fixed the colour']);
    expect(answer.unanswered).toHaveLength(4);
  });
});

describe('judgePolish', () => {
  const ok: PolishFacts = {
    before: { tests: 61, passed: 61, failed: 0, skipped: 0 },
    after: { testExit: 0, buildExit: 0, totals: { tests: 62, passed: 62, failed: 0, skipped: 0 } },
    changedFiles: 3,
    changedLines: 20,
    assertionsLost: 0,
  };

  it('keeps a small polish after which everything passes', () => {
    expect(judgePolish(ok)).toEqual({ ok: true });
  });

  it.each([
    ['the tests fail', { after: { ...ok.after, testExit: 1 } }, 'CHECKS_FAILED'],
    ['the build fails', { after: { ...ok.after, buildExit: 2 } }, 'CHECKS_FAILED'],
    ['a test is reported failed', { after: { ...ok.after, totals: { tests: 62, passed: 61, failed: 1, skipped: 0 } } }, 'CHECKS_FAILED'],
    ['fewer tests pass than before', { after: { ...ok.after, totals: { tests: 55, passed: 55, failed: 0, skipped: 0 } } }, 'TESTS_LOST'],
    ['assertions were removed', { assertionsLost: 2 }, 'WEAKENED_TESTS'],
    ['too many files', { changedFiles: MAX_POLISH_FILES + 1 }, 'TOO_LARGE'],
    ['too many lines', { changedLines: MAX_POLISH_CHANGED_LINES + 1 }, 'TOO_LARGE'],
  ] as Array<[string, Partial<PolishFacts>, string]>)('undoes it when %s', (_name, change, reason) => {
    const verdict = judgePolish({ ...ok, ...change });
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toBe(reason);
  });

  it('judges what it can: no baseline, or a runner whose totals are unknown, is not a reason to undo', () => {
    expect(judgePolish({ ...ok, before: null })).toEqual({ ok: true });
    expect(judgePolish({ ...ok, after: { testExit: 0, buildExit: null, totals: null } })).toEqual({ ok: true });
  });
});

describe('assertionsLost', () => {
  const patch = (path: string, removed: string[], added: string[]) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,5 +1,5 @@\n${removed.map((l) => `-${l}`).join('\n')}\n${added.map((l) => `+${l}`).join('\n')}\n`;

  it('counts assertions and tests taken out of a test file', () => {
    expect(assertionsLost(patch('ui/src/lib/__tests__/a.test.js', ["  expect(a).toBe(1);", "it('masks money', () => {"], []))).toBe(2);
    expect(assertionsLost(patch('tests/test_a.py', ['    assert x == 1', 'def test_one():'], []))).toBe(2);
  });

  it('is not fooled by a rewrite that keeps as many as it removes', () => {
    expect(assertionsLost(patch('a.test.js', ["  expect(formatPercentForPrivacy(0.1, true)).toBe('******');"], ["  expect(formatPercent(0.1)).toBe('10.00%');"]))).toBe(0);
  });

  it('does not look at production code', () => {
    expect(assertionsLost(patch('src/a.js', ['  assert(x > 0);', '  expect(thing)'], []))).toBe(0);
  });

  it('is zero for a patch that only adds tests', () => {
    expect(assertionsLost(patch('a.test.js', [], ["it('new', () => {", '  expect(1).toBe(1);']))).toBe(0);
    expect(assertionsLost('')).toBe(0);
  });
});
