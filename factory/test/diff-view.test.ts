import { describe, expect, it } from 'vitest';

import { DEFAULT_DIFF_BUDGET_CHARS, describeCoverage, isTestFile, splitDiff, viewDiff } from '../src/tools/diff-view.ts';

/** One file's section of a unified diff, with `added` and `removed` lines in a single hunk. */
function section(path: string, added: number, removed = 0, mode: 'new' | 'deleted' | 'modified' = 'modified'): string {
  return [
    `diff --git a/${path} b/${path}`,
    mode === 'new' ? 'new file mode 100644' : mode === 'deleted' ? 'deleted file mode 100644' : '',
    'index 1111111..2222222 100644',
    `--- ${mode === 'new' ? '/dev/null' : `a/${path}`}`,
    `+++ ${mode === 'deleted' ? '/dev/null' : `b/${path}`}`,
    `@@ -1,${removed} +1,${added} @@`,
    ...Array.from({ length: removed }, (_, i) => `-old line ${i} of ${path}`),
    ...Array.from({ length: added }, (_, i) => `+new line ${i} of ${path}`),
  ]
    .filter((line) => line !== '')
    .join('\n')
    .concat('\n');
}

describe('splitDiff', () => {
  it('splits per file and counts the changed lines, not the file headers', () => {
    const sections = splitDiff(section('a.ts', 3, 1) + section('b.ts', 5, 0, 'new') + section('c.ts', 0, 4, 'deleted'));

    expect(sections.map((s) => [s.path, s.additions, s.deletions, s.isNew, s.isDeleted])).toEqual([
      ['a.ts', 3, 1, false, false],
      ['b.ts', 5, 0, true, false],
      ['c.ts', 0, 4, false, true],
    ]);
  });

  it('keeps a binary file as a section without changed lines', () => {
    const [binary] = splitDiff('diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n');
    expect(binary).toMatchObject({ path: 'logo.png', additions: 0, deletions: 0 });
  });

  it('is empty for an empty diff', () => {
    expect(splitDiff('')).toEqual([]);
  });
});

describe('viewDiff: a diff that fits', () => {
  const diff = section('src/a.ts', 4, 2) + section('src/b.ts', 10, 0, 'new') + section('src/old.ts', 0, 6, 'deleted');
  const view = viewDiff(diff);

  it('shows every file in full and says it is the complete diff', () => {
    expect(view.coverage).toEqual({ totalFiles: 3, inFull: 3, shortened: 0, notShown: 0, generated: 0, complete: true });
    expect(view.text).toContain('This is the complete diff');
    expect(view.text).not.toContain('NOT the whole diff');
  });

  it('lists each file with its size and what kind of change it is', () => {
    expect(view.text).toContain('- src/a.ts (+4 -2): shown in full');
    expect(view.text).toContain('- src/b.ts (+10 -0, new file): shown in full');
    expect(view.text).toContain('- src/old.ts (+0 -6, deleted): shown in full');
  });

  it('puts the diff itself in a fenced block, untouched', () => {
    expect(view.text).toContain('```diff\n' + diff.trimEnd() + '\n```');
  });

  it('gives nothing for an empty diff', () => {
    expect(viewDiff('')).toMatchObject({ text: '', coverage: { totalFiles: 0, complete: true } });
  });
});

describe('viewDiff: generated files', () => {
  const view = viewDiff(section('src/a.ts', 3) + section('package-lock.json', 4000) + section('dist/app.min.js', 50));

  it('leaves them out, says so, and does not count them as missing', () => {
    expect(view.coverage).toMatchObject({ totalFiles: 3, inFull: 1, generated: 2, notShown: 0, complete: true });
    expect(view.text).toContain('- package-lock.json (+4000 -0): generated file, not shown');
    expect(view.text).not.toContain('new line 100 of package-lock.json');
  });
});

describe('viewDiff: a diff that does not fit', () => {
  it('shortens only the largest files and leaves the small ones whole', () => {
    const small = Array.from({ length: 10 }, (_, i) => section(`src/small${i}.ts`, 12));
    const diff = small.join('') + section('src/huge.ts', 900);
    const view = viewDiff(diff, { budgetChars: 20_000 });

    const huge = view.files.find((f) => f.path === 'src/huge.ts')!;
    expect(huge.status).toBe('shortened');
    expect(huge.keptLines).toBeGreaterThanOrEqual(60);
    expect(view.files.filter((f) => f.path.startsWith('src/small')).every((f) => f.status === 'in-full')).toBe(true);
    expect(view.text).toContain('SHOWN IN PART');
    expect(view.text).toContain('more lines of src/huge.ts left out');
    expect(view.coverage.complete).toBe(false);
  });

  it('stays within the budget', () => {
    const diff = Array.from({ length: 30 }, (_, i) => section(`src/f${i}.ts`, 80, 20)).join('');
    for (const budgetChars of [20_000, 40_000, 80_000]) {
      expect(viewDiff(diff, { budgetChars }).text.length).toBeLessThanOrEqual(budgetChars);
    }
  });

  it('drops whole files only when even a short cut of each does not fit, the largest first', () => {
    const diff = section('src/big.ts', 400) + Array.from({ length: 8 }, (_, i) => section(`src/s${i}.ts`, 40)).join('');
    const view = viewDiff(diff, { budgetChars: 9_000 });

    expect(view.files.find((f) => f.path === 'src/big.ts')!.status).toBe('not-shown');
    expect(view.coverage.notShown).toBeGreaterThan(0);
    expect(view.text).toContain('- src/big.ts (+400 -0): NOT SHOWN, over the size budget');
    expect(view.text).not.toContain('new line 3 of src/big.ts');
  });

  it('keeps the priority files when it has to drop some', () => {
    const diff =
      section('src/service.ts', 300) +
      section('src/other.ts', 300) +
      section('src/__tests__/service.test.ts', 300);
    const view = viewDiff(diff, { budgetChars: 5_000, priority: isTestFile });
    const status = Object.fromEntries(view.files.map((f) => [f.path, f.status]));

    expect(status['src/__tests__/service.test.ts']).not.toBe('not-shown');
    expect(Object.values(status)).toContain('not-shown');
  });

  it('says what was missed, and where the rest can be read', () => {
    const view = viewDiff(section('src/a.ts', 900), { budgetChars: 3_000, patchFile: '/logs/run/context/diff-attempt-2.patch' });

    expect(view.text).toContain('**This is NOT the whole diff**');
    expect(view.text).toContain('`/logs/run/context/diff-attempt-2.patch`');
    expect(view.text).toContain('Do not call a file fine because you did not see it');
  });

  it('does not point at a patch file it was not given', () => {
    const view = viewDiff(section('src/a.ts', 900), { budgetChars: 3_000, patchFile: null });
    expect(view.text).toContain('NOT the whole diff');
    expect(view.text).not.toContain('complete patch');
  });
});

describe('what a real round needs', () => {
  // The round that went wrong: 31 files, 107,409 characters. The agents saw 24,040 of them.
  const round = Array.from({ length: 31 }, (_, i) => section(`ui/src/c${i}.jsx`, 55 + (i % 5) * 4, 40 + (i % 4) * 4)).join('');

  it('is the size of the real round', () => {
    expect(round.length).toBeGreaterThan(100_000);
    expect(round.length).toBeLessThan(118_000);
  });

  it('now reaches an agent whole under the default budget', () => {
    expect(DEFAULT_DIFF_BUDGET_CHARS).toBe(120_000);
    const view = viewDiff(round);
    expect(view.coverage).toMatchObject({ totalFiles: 31, inFull: 31, complete: true });
  });

  it('is condensed rather than cut when it does not', () => {
    const view = viewDiff(round, { budgetChars: 60_000 });
    expect(view.coverage.totalFiles).toBe(31);
    expect(view.coverage.inFull + view.coverage.shortened + view.coverage.notShown).toBe(31);
    expect(view.text.match(/^- ui\/src\/c\d+\.jsx/gm)).toHaveLength(31); // every file is accounted for
    expect(view.text.length).toBeLessThanOrEqual(60_000);
  });
});

describe('describeCoverage', () => {
  it('is empty when the whole change was seen', () => {
    expect(describeCoverage(viewDiff(section('a.ts', 2)).coverage)).toBe('');
  });

  it('counts the files seen in full out of those that could be read', () => {
    const view = viewDiff(section('a.ts', 900) + section('b.ts', 900) + section('package-lock.json', 10), { budgetChars: 4_000 });
    expect(describeCoverage(view.coverage)).toMatch(/^\d of 2 changed files seen in full$/);
  });
});

describe('isTestFile', () => {
  it.each([
    'ui/src/lib/__tests__/theme.test.js',
    'src/foo.spec.ts',
    'tests/test_foo.py',
    'pkg/foo_test.go',
    'src/test/java/com/acme/FooTest.java',
    'test_util.py',
  ])('%s is a test', (path) => {
    expect(isTestFile(path)).toBe(true);
  });

  it.each(['src/latest.ts', 'src/contest/Main.java', 'README.md', 'src/protest.js'])('%s is not', (path) => {
    expect(isTestFile(path)).toBe(false);
  });
});
