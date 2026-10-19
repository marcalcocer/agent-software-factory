/**
 * What an agent is shown of a change, and an honest account of what it was not shown.
 *
 * The reviewers used to be handed `git diff` cut in the middle without a word: a real round of 31
 * files / 107,409 characters reached QA, the reviewer and the security agent as 24,040 characters of
 * 12 files. An agent that does not know a file is missing says "approved" about it; one that is told
 * can open it. So the diff is never cut silently. It is condensed in steps (generated files out, long
 * files shortened, whole files last) and the result carries a manifest of every changed file with
 * what was done to it, plus - when the whole diff did not fit - where to read the rest.
 *
 * Pure (no git, no model, no files) so the rules can be checked on their own.
 */
import { isGeneratedFile } from './pr-merge-rules.ts';

/* -------------------------------------------------------------------------- */
/* Splitting a diff                                                            */
/* -------------------------------------------------------------------------- */

export interface DiffSection {
  path: string;
  /** The whole section, header included, ending with a newline. */
  text: string;
  additions: number;
  deletions: number;
  isNew: boolean;
  isDeleted: boolean;
}

/** Splits a unified diff into one section per file. */
export function splitDiff(diff: string): DiffSection[] {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((part) => part.trim() !== '')
    .map((part) => {
      const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
      const text = part.endsWith('\n') ? part : `${part}\n`;
      let additions = 0;
      let deletions = 0;
      let inHunk = false;
      for (const line of text.split('\n')) {
        if (line.startsWith('@@')) inHunk = true;
        else if (!inHunk) continue;
        else if (line.startsWith('+')) additions += 1;
        else if (line.startsWith('-')) deletions += 1;
      }
      return {
        path: header?.[2] ?? header?.[1] ?? '(unknown file)',
        text,
        additions,
        deletions,
        isNew: /^new file mode /m.test(text),
        isDeleted: /^deleted file mode /m.test(text),
      };
    });
}

/** Test files, whatever the ecosystem: the part of a diff that shows whether verification was weakened. */
export function isTestFile(path: string): boolean {
  return /(^|\/)(__tests__|tests?|specs?)\//i.test(path) || /(\.|_)(test|spec)\.[a-z]+$|Tests?\.(java|kt|cs)$|(^|\/)test_[^/]+\.py$/i.test(path);
}

/* -------------------------------------------------------------------------- */
/* Condensing it                                                               */
/* -------------------------------------------------------------------------- */

export type FileStatus = 'in-full' | 'shortened' | 'not-shown' | 'generated';

export interface FileCoverage {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  isNew: boolean;
  isDeleted: boolean;
  /** For a shortened file: how many lines of its section were kept. */
  keptLines?: number;
}

export interface DiffCoverage {
  totalFiles: number;
  inFull: number;
  shortened: number;
  notShown: number;
  generated: number;
  /** True when every changed file that is not generated is shown in full. */
  complete: boolean;
}

export interface DiffView {
  /** Manifest and diff, ready to be put in a prompt section. */
  text: string;
  coverage: DiffCoverage;
  files: FileCoverage[];
}

export interface DiffViewOptions {
  /** Upper bound for `text`. Default 120,000 characters (about 30k tokens). */
  budgetChars?: number;
  /** Files that matter most for this reader: they are the last to be shortened or dropped. */
  priority?: (path: string) => boolean;
  /** Where the complete patch can be read, when it is on disk. */
  patchFile?: string | null;
}

export const DEFAULT_DIFF_BUDGET_CHARS = 120_000;

/** No file is cut below this many lines of its section: less than that shows nothing useful. */
const MIN_LINES_PER_FILE = 60;

function cutSection(section: DiffSection, maxLines: number): { text: string; keptLines: number; cut: boolean } {
  const lines = section.text.split('\n');
  if (lines.length - 1 <= maxLines) return { text: section.text, keptLines: lines.length - 1, cut: false };
  const left = lines.length - 1 - maxLines;
  return {
    text: `${lines.slice(0, maxLines).join('\n')}\n[... ${left} more lines of ${section.path} left out ...]\n`,
    keptLines: maxLines,
    cut: true,
  };
}

const total = (items: Array<{ text: string }>): number => items.reduce((sum, item) => sum + item.text.length, 0);

const describe = (file: FileCoverage): string => {
  const stats = `+${file.additions} -${file.deletions}${file.isNew ? ', new file' : file.isDeleted ? ', deleted' : ''}`;
  switch (file.status) {
    case 'in-full':
      return `- ${file.path} (${stats}): shown in full`;
    case 'shortened':
      return `- ${file.path} (${stats}): SHOWN IN PART, the first ${file.keptLines} lines`;
    case 'not-shown':
      return `- ${file.path} (${stats}): NOT SHOWN, over the size budget`;
    case 'generated':
      return `- ${file.path} (${stats}): generated file, not shown`;
  }
};

/**
 * Condenses a unified diff to the budget and says what was done to every file.
 *
 * Steps, each only if the previous one was not enough: generated files (lockfiles, bundles, source
 * maps) are left out; the largest files are cut to the longest length at which everything fits (so a
 * handful of big files lose lines, and the many small ones lose none); if even a cut of
 * `MIN_LINES_PER_FILE` lines each does not fit, whole files are dropped - the files that matter least
 * to this reader first, and the largest first, because that frees room for the most others.
 */
export function viewDiff(diff: string, options: DiffViewOptions = {}): DiffView {
  const budget = options.budgetChars ?? DEFAULT_DIFF_BUDGET_CHARS;
  const priority = options.priority ?? (() => false);
  const sections = splitDiff(diff);

  const readable = sections.filter((section) => !isGeneratedFile(section.path));

  // The manifest takes room too; keep a share of the budget for it.
  const manifestReserve = Math.min(Math.round(budget * 0.25), 140 * sections.length + 600);
  const bodyBudget = Math.max(0, budget - manifestReserve);

  const sizeAt = (items: DiffSection[], maxLines: number): number =>
    items.reduce((sum, section) => sum + cutSection(section, maxLines).text.length, 0);
  const longest = (items: DiffSection[]): number =>
    items.reduce((max, section) => Math.max(max, section.text.split('\n').length - 1), 0);

  let kept = readable;
  const dropped = new Set<string>();

  // Whole files go only when even the shortest sensible cut of each does not fit.
  if (sizeAt(kept, MIN_LINES_PER_FILE) > bodyBudget) {
    const order = [...kept].sort(
      (a, b) => Number(priority(a.path)) - Number(priority(b.path)) || b.text.length - a.text.length,
    );
    for (const section of order) {
      if (sizeAt(kept, MIN_LINES_PER_FILE) <= bodyBudget) break;
      dropped.add(section.path);
      kept = kept.filter((candidate) => candidate !== section);
    }
  }

  // The longest cut at which what is left fits: only the largest files lose lines.
  let maxLines = Math.max(longest(kept), MIN_LINES_PER_FILE);
  if (sizeAt(kept, maxLines) > bodyBudget) {
    let low = MIN_LINES_PER_FILE; // fits (checked above)
    let high = maxLines; // does not fit
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (sizeAt(kept, middle) <= bodyBudget) low = middle;
      else high = middle;
    }
    maxLines = low;
  }
  const chosen = kept.map((section) => ({ section, ...cutSection(section, maxLines) }));

  const files: FileCoverage[] = sections.map((section) => {
    const base = {
      path: section.path,
      additions: section.additions,
      deletions: section.deletions,
      isNew: section.isNew,
      isDeleted: section.isDeleted,
    };
    if (isGeneratedFile(section.path)) return { ...base, status: 'generated' as const };
    if (dropped.has(section.path)) return { ...base, status: 'not-shown' as const };
    const item = chosen.find((candidate) => candidate.section.path === section.path)!;
    return item.cut
      ? { ...base, status: 'shortened' as const, keptLines: item.keptLines }
      : { ...base, status: 'in-full' as const };
  });

  const count = (status: FileStatus): number => files.filter((file) => file.status === status).length;
  const coverage: DiffCoverage = {
    totalFiles: files.length,
    inFull: count('in-full'),
    shortened: count('shortened'),
    notShown: count('not-shown'),
    generated: count('generated'),
    complete: files.every((file) => file.status === 'in-full' || file.status === 'generated'),
  };

  const shownText = chosen.map((item) => item.text).join('');

  return { text: render(files, shownText, coverage, options.patchFile ?? null), coverage, files };
}

function render(files: FileCoverage[], shown: string, coverage: DiffCoverage, patchFile: string | null): string {
  if (files.length === 0) return '';

  const parts = [`### Files changed (${files.length})`, '', ...files.map(describe)];

  if (shown.trim() !== '') parts.push('', '### Diff', '', '```diff', shown.trimEnd(), '```');

  if (coverage.complete) {
    parts.push('', 'This is the complete diff of every file that is not generated.');
  } else {
    const missing = [
      coverage.shortened > 0 ? `${coverage.shortened} in part` : '',
      coverage.notShown > 0 ? `${coverage.notShown} not at all` : '',
    ]
      .filter(Boolean)
      .join(' and ');
    parts.push(
      '',
      `**This is NOT the whole diff**: ${missing} of ${coverage.totalFiles} files. Open those files in the working tree` +
        (patchFile ? `, and find their diff in the complete patch at \`${patchFile}\` (search it for \`diff --git a/<path>\`, then read from that line)` : '') +
        '. Do not call a file fine because you did not see it, and say in your summary what you could not check.',
    );
  }

  return parts.join('\n');
}

/** One line for logs and for the PR's quality-gates section; empty when everything was shown. */
export function describeCoverage(coverage: DiffCoverage): string {
  if (coverage.complete) return '';
  return `${coverage.inFull} of ${coverage.totalFiles - coverage.generated} changed files seen in full`;
}
