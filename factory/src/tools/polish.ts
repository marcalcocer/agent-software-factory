/**
 * The polish pass: what happens to the minor findings the gates leave behind.
 *
 * QA, the reviewer and the security agent each report things that do not block a merge - a sign colour
 * that reveals what privacy mode hides, a stale comment, a low-risk input that is not escaped. They were
 * written down and then dropped: in a real run the same one-line fix was named by QA and by the reviewer
 * and nothing happened, and it was on `master` after the merge.
 *
 * Findings now have three fates:
 *   - blocking (BLOCKER / MAJOR / CRITICAL / HIGH, or a failed gate) -> the existing retry loop;
 *   - polishable (below) -> ONE developer pass, checked by the tests and the build, undone if it makes
 *     things worse;
 *   - everything else (NITs, INFO, problems that were there before this change, opinions without a
 *     concrete fix) -> reported, never acted on.
 *
 * This file is the policy, with no I/O: what counts as polishable, how the developer is asked, what the
 * answer means and when a polish is rejected. The orchestration is in `workflows/polish-pass.ts`.
 */
import type { DeveloperReport, QaReport, ReviewReport, SecurityReport } from '../utils/schemas.ts';
import { isTestFile, splitDiff } from './diff-view.ts';

/* -------------------------------------------------------------------------- */
/* Limits                                                                      */
/* -------------------------------------------------------------------------- */

/** More than this in one pass stops being a polish: the rest are reported. */
export const MAX_POLISH_FINDINGS = 8;
/** A polish bigger than this is a change of its own, and is undone. */
export const MAX_POLISH_FILES = 10;
export const MAX_POLISH_CHANGED_LINES = 250;

/* -------------------------------------------------------------------------- */
/* Which findings                                                              */
/* -------------------------------------------------------------------------- */

export type PolishSource = 'security' | 'qa' | 'review';

export interface PolishCandidate {
  /** `SEC-1`, `QA-1`, `REV-1`: how the developer refers to it in its answer. */
  id: string;
  source: PolishSource;
  severity: string;
  file: string | null;
  line: number | null;
  problem: string;
  /** What to change. A finding without one is an opinion, not a task. */
  fix: string;
}

export interface PolishInput {
  qa: QaReport | null;
  review: ReviewReport | null;
  security: SecurityReport | null;
}

export interface PolishSelection {
  /** Handed to the developer, most important first. */
  candidates: PolishCandidate[];
  /** Real findings the pass will not act on, with the reason: they go to the pull request's follow-ups. */
  reported: Array<{ source: PolishSource; summary: string; reason: string }>;
}

const clean = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();

const location = (file: string | null, line: number | null): string => (file ? `${file}${line ? `:${line}` : ''}` : 'somewhere in the change');

/**
 * Picks what the polish pass works on.
 *
 * Fixed: security LOW and MEDIUM that this change introduced; QA bugs of MINOR severity; review
 * findings of MINOR severity. Each needs a concrete fix to follow - a remark that says "consider" with
 * nothing to do is a NIT, whatever it was called.
 *
 * Not fixed, only reported: NITs and INFO; anything that was already there (`preExisting`); a finding
 * with no fix to apply; whatever does not fit in `MAX_POLISH_FINDINGS`. Blocking findings are not here
 * at all: by the time a change reaches the polish pass the loop has dealt with them.
 */
export function selectPolish(input: PolishInput): PolishSelection {
  const candidates: PolishCandidate[] = [];
  const reported: PolishSelection['reported'] = [];
  const count: Record<PolishSource, number> = { security: 0, qa: 0, review: 0 };
  const prefix: Record<PolishSource, string> = { security: 'SEC', qa: 'QA', review: 'REV' };

  const add = (source: PolishSource, candidate: Omit<PolishCandidate, 'id' | 'source'>) => {
    count[source] += 1;
    candidates.push({ id: `${prefix[source]}-${count[source]}`, source, ...candidate });
  };

  for (const finding of input.security?.findings ?? []) {
    const summary = `${finding.category} in ${location(finding.file, finding.line)}: ${clean(finding.impact)}`;
    if (finding.severity !== 'LOW' && finding.severity !== 'MEDIUM') {
      if (finding.severity === 'INFO') reported.push({ source: 'security', summary, reason: 'informational' });
      continue; // HIGH and CRITICAL are blocking: the retry loop's business
    }
    if (finding.preExisting) {
      reported.push({ source: 'security', summary, reason: 'it was there before this change' });
    } else if (clean(finding.remediation) === '') {
      reported.push({ source: 'security', summary, reason: 'no concrete fix was given' });
    } else {
      add('security', {
        severity: finding.severity,
        file: finding.file || null,
        line: finding.line,
        problem: `${finding.category}: ${clean(finding.evidence)} Impact: ${clean(finding.impact)}`,
        fix: clean(finding.remediation),
      });
    }
  }

  for (const bug of input.qa?.bugReports ?? []) {
    const summary = clean(bug.title);
    if (bug.severity !== 'MINOR') continue; // MAJOR and up fail QA: the retry loop's business
    const fix = clean(bug.expected) === '' ? '' : `Make the behaviour match: ${clean(bug.expected)}`;
    if (fix === '') {
      reported.push({ source: 'qa', summary, reason: 'no expected behaviour was given' });
    } else {
      add('qa', { severity: bug.severity, file: null, line: null, problem: `${clean(bug.title)}. Actual: ${clean(bug.actual)} Evidence: ${clean(bug.evidence)}`, fix });
    }
  }

  for (const finding of input.review?.findings ?? []) {
    const summary = `${location(finding.file, finding.line)}: ${clean(finding.issue)}`;
    if (finding.severity === 'NIT') {
      reported.push({ source: 'review', summary, reason: 'a nit' });
      continue;
    }
    if (finding.severity !== 'MINOR') continue; // BLOCKER and MAJOR are blocking
    if (clean(finding.suggestion) === '') {
      reported.push({ source: 'review', summary, reason: 'no concrete fix was given' });
    } else {
      add('review', { severity: finding.severity, file: finding.file || null, line: finding.line, problem: clean(finding.issue), fix: clean(finding.suggestion) });
    }
  }

  // Security first (it can matter to users), then what QA saw running, then the reviewer's reading.
  // Stable inside each group: the agents list the important ones first.
  const rank: Record<PolishSource, number> = { security: 0, qa: 1, review: 2 };
  candidates.sort((a, b) => rank[a.source] - rank[b.source]);

  for (const left of candidates.splice(MAX_POLISH_FINDINGS)) {
    reported.push({ source: left.source, summary: `${location(left.file, left.line)}: ${left.problem}`, reason: `more than ${MAX_POLISH_FINDINGS} findings: this pass keeps to the first ones` });
  }
  return { candidates, reported };
}

/* -------------------------------------------------------------------------- */
/* Asking the developer                                                        */
/* -------------------------------------------------------------------------- */

/** The findings as the developer reads them. */
export function renderCandidates(candidates: PolishCandidate[]): string {
  return candidates
    .map((candidate) =>
      [
        `### ${candidate.id} (${candidate.source}, ${candidate.severity})`,
        `- Where: ${location(candidate.file, candidate.line)}`,
        `- Problem: ${candidate.problem}`,
        `- Fix: ${candidate.fix}`,
      ].join('\n'),
    )
    .join('\n\n');
}

export const POLISH_INSTRUCTIONS = [
  '## Instructions',
  '',
  'The change already passed QA, the review and the security audit. These are the minor findings they left. This is a polish pass: small, safe, and one time only.',
  '',
  '1. Fix a finding only when the fix is clearly right and small. Read the code first: a finding can be wrong.',
  '2. A finding you will not fix - you disagree, the fix is large or risky, or it needs a decision - goes in `followUps` as `<ID>: Not applied - <the reason>`.',
  '3. A finding you fixed goes in `appliedFeedback` as `<ID>: <what you changed>`. Start every entry with the finding id.',
  '   Two findings can describe the same problem: fix it once and answer both ids.',
  '4. Change nothing else: no refactoring, no renaming, no restyling, no new features.',
  '5. Do not remove, skip or loosen any test or assertion. You may add a test for what you changed.',
  '6. The factory runs the tests and the build afterwards. If they fail, everything you did is undone.',
].join('\n');

const ID = /^\s*([A-Z]{2,4}-\d+)\b/;

export interface PolishAnswer {
  /** Findings the developer says it fixed. */
  applied: string[];
  /** Findings it declined, with its reason. */
  declined: Array<{ id: string; reason: string }>;
  /** Findings it did not mention at all. */
  unanswered: string[];
  /** Lines of the answer that name no finding (kept, in case the developer ignored the format). */
  loose: string[];
}

/** Reads which findings the developer fixed and which it declined from the ids it started its lines with. */
export function readAnswer(candidates: PolishCandidate[], report: Pick<DeveloperReport, 'appliedFeedback' | 'followUps'>): PolishAnswer {
  const known = new Set(candidates.map((candidate) => candidate.id));
  const applied: string[] = [];
  const declined: PolishAnswer['declined'] = [];
  const loose: string[] = [];

  for (const line of report.appliedFeedback) {
    const id = ID.exec(line)?.[1];
    if (id && known.has(id)) applied.push(id);
    else loose.push(line);
  }
  for (const line of report.followUps) {
    const id = ID.exec(line)?.[1];
    if (id && known.has(id) && !applied.includes(id)) {
      declined.push({ id, reason: clean(line.replace(ID, '').replace(/^[:\s-]*(Not applied\s*[-:]?\s*)?/i, '')) || 'no reason given' });
    } else if (!id) {
      loose.push(line);
    }
  }
  const answered = new Set([...applied, ...declined.map((entry) => entry.id)]);
  return { applied: [...new Set(applied)], declined, unanswered: candidates.map((c) => c.id).filter((id) => !answered.has(id)), loose };
}

/* -------------------------------------------------------------------------- */
/* Judging the result                                                          */
/* -------------------------------------------------------------------------- */

export interface Totals {
  tests: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
}

export interface CheckResult {
  /** Exit code of the suite, or `null` when there is none to run. */
  testExit: number | null;
  buildExit: number | null;
  totals: Totals | null;
}

export interface PolishFacts {
  /** What QA saw before the polish. */
  before: Totals | null;
  after: CheckResult;
  changedFiles: number;
  changedLines: number;
  /** Assertions and test definitions removed from test files, minus those added. */
  assertionsLost: number;
}

export type PolishRejection = 'CHECKS_FAILED' | 'TESTS_LOST' | 'WEAKENED_TESTS' | 'TOO_LARGE';

export type PolishVerdict = { ok: true } | { ok: false; reason: PolishRejection; detail: string };

/**
 * Decides whether the polish stays. It is undone when the tests or the build fail, when fewer tests
 * pass than before, when it took assertions out of a test, or when it grew into a change of its own.
 */
export function judgePolish(facts: PolishFacts): PolishVerdict {
  const { after } = facts;
  if (after.testExit !== null && after.testExit !== 0) {
    return { ok: false, reason: 'CHECKS_FAILED', detail: `The test suite failed after the fixes (exit ${after.testExit}).` };
  }
  if (after.buildExit !== null && after.buildExit !== 0) {
    return { ok: false, reason: 'CHECKS_FAILED', detail: `The build failed after the fixes (exit ${after.buildExit}).` };
  }
  if (after.totals?.failed) {
    return { ok: false, reason: 'CHECKS_FAILED', detail: `${after.totals.failed} test(s) failed after the fixes.` };
  }
  const was = facts.before?.passed;
  const now = after.totals?.passed;
  if (typeof was === 'number' && typeof now === 'number' && now < was) {
    return { ok: false, reason: 'TESTS_LOST', detail: `${was} tests passed before the fixes and ${now} after: tests went missing.` };
  }
  if (facts.assertionsLost > 0) {
    return { ok: false, reason: 'WEAKENED_TESTS', detail: `The fixes removed ${facts.assertionsLost} assertion(s) or test(s) from the test files.` };
  }
  if (facts.changedFiles > MAX_POLISH_FILES || facts.changedLines > MAX_POLISH_CHANGED_LINES) {
    return {
      ok: false,
      reason: 'TOO_LARGE',
      detail: `The fixes touched ${facts.changedFiles} files and ${facts.changedLines} lines; a polish pass is at most ${MAX_POLISH_FILES} files and ${MAX_POLISH_CHANGED_LINES} lines.`,
    };
  }
  return { ok: true };
}

const ASSERTION_LINE =
  /^\s*(?:(?:it|test|describe)(?:\.(?:each|only|skip))?\s*\(|expect\s*\(|assert(?:[A-Za-z]*\s*[.(]|\s+\S)|should\b|@Test\b|def\s+test_|func\s+Test|t\.(?:Error|Fatal|Run)\b)/;

/**
 * How many assertions and test definitions a patch takes out of test files, net of those it puts in
 * (rewriting a test is not weakening it; deleting its assertions is).
 */
export function assertionsLost(patch: string): number {
  let removed = 0;
  let added = 0;
  for (const section of splitDiff(patch)) {
    if (!isTestFile(section.path)) continue;
    for (const line of section.text.split('\n')) {
      if (line.startsWith('---') || line.startsWith('+++')) continue;
      if (line.startsWith('-') && ASSERTION_LINE.test(line.slice(1))) removed += 1;
      else if (line.startsWith('+') && ASSERTION_LINE.test(line.slice(1))) added += 1;
    }
  }
  return Math.max(0, removed - added);
}
