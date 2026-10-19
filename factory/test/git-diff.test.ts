import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDiff, getFullDiff } from '../src/tools/git-tools.ts';
import { BIG_CHANGE_FILES as FILES, createBigChangeRepo } from './support/git-repo';

let repo: string;
let cleanup: () => void;

beforeAll(() => {
  ({ repo, cleanup } = createBigChangeRepo());
});

afterAll(() => cleanup());

describe('getFullDiff', () => {
  it('returns a diff far larger than the old 24,000-character cap, whole', async () => {
    const { diff, truncated, files } = await getFullDiff(repo);

    expect(diff.length).toBeGreaterThan(60_000);
    expect(truncated).toBe(false);
    expect(diff).not.toContain('characters truncated');
    expect(files).toHaveLength(FILES + 1);
  });

  it('has the middle of the change, which is what used to disappear', async () => {
    const { diff } = await getFullDiff(repo);
    for (const file of ['file00', 'file19', 'file20', 'file39']) {
      expect(diff).toContain(`diff --git a/src/${file}.ts b/src/${file}.ts`);
    }
    expect(diff).toContain('value20_17 = \'after-');
  });

  it('includes a file that is not tracked yet', async () => {
    const { diff, files } = await getFullDiff(repo);
    expect(files).toContain('src/brand-new.ts');
    expect(diff).toContain('+export const fresh = true;');
  });
});

describe('getDiff with its default limit', () => {
  it('still cuts, but from the end and with an honest note, not in the middle', async () => {
    const { diff, truncated, files } = await getDiff(repo);

    expect(truncated).toBe(true);
    expect(diff).toContain('[... diff truncated at 48000 characters ...]');
    expect(diff.startsWith('diff --git a/src/brand-new.ts') || diff.startsWith('diff --git a/src/file00.ts')).toBe(true);
    expect(files).toHaveLength(FILES + 1); // the list of files is never cut
  });
});
