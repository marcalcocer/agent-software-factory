import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { RUN, readJson } from '../../fixtures';
import {
  branchNameFor,
  cleanTitle,
  fallbackRunName,
  formatTaskId,
  guessBranchType,
  normalizeRunName,
  roundTitle,
  slugify,
  withTaskTrailer,
} from '../src/tools/run-naming.ts';

const validBranch = (name: string): boolean => {
  try {
    execFileSync('git', ['check-ref-format', '--branch', name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

describe('fallbackRunName: a name from the request alone', () => {
  it('names the real request that was called "Untitled run" and branched as "factory/i-want-to-do-a-big-refactor-on-t-61e6"', () => {
    const task = readJson(RUN.round1, 'run.json').task;

    expect(fallbackRunName(task)).toEqual({
      title: 'Big refactor on the UI for this repository',
      slug: 'big-refactor-on-the-ui-for-this',
      type: 'refactor',
    });
  });

  it.each([
    ['Add pagination to GET /api/positions', 'Add pagination to GET /api/positions', 'feat'],
    ['Fix the token refresh race condition on concurrent requests', 'Fix the token refresh race condition on concurrent requests', 'fix'],
    ['Please could you update the README with the new commands. Thanks!', 'Update the README with the new commands', 'docs'],
    ['Hi! We need to add a CSV export for the report.', 'Add a CSV export for the report', 'feat'],
    ["Let's speed up the nightly import, it is far too slow", 'Speed up the nightly import', 'perf'],
    ['Do a minor improvement', 'Minor improvement', 'feat'],
  ])('%j', (task, title, type) => {
    expect(fallbackRunName(task)).toMatchObject({ title, type });
  });

  it('keeps ten words at most, and does not end on a filler word', () => {
    const { title } = fallbackRunName('Add support for importing portfolios from CSV files and validating every row against the schema');
    expect(title.split(' ').length).toBeLessThanOrEqual(10);
    expect(title).not.toMatch(/\b(and|or|to|for|of|the|a|an|on|in|with)$/i);

    const cut = fallbackRunName('Implement the new dashboard layout with the sidebar, and the');
    expect(cut.title).not.toMatch(/\bthe$/i);
  });

  it('takes the first sentence only', () => {
    expect(fallbackRunName('Add dark mode. Also rewrite everything else in the app!').title).toBe('Add dark mode');
  });

  it('still names something when there is nothing to go on', () => {
    expect(fallbackRunName('')).toEqual({ title: 'Untitled task', slug: 'untitled-task', type: 'feat' });
  });

  it('always yields a branch name git accepts, whatever the request looks like', () => {
    const awkward = [
      'Fix: crash on "save" when the name has a / slash \u2014 and \u00e9\u00e8 accents',
      '\ud83d\ude80\ud83d\ude80 ship it',
      '../../etc/passwd',
      '   ',
      'a'.repeat(300),
      'Fix the .lock file handling in ~/config^2*[x]',
      '-leading dash',
    ];
    for (const task of awkward) {
      const name = fallbackRunName(task);
      expect(validBranch(branchNameFor('f0042', name)), `${task.slice(0, 30)} -> ${branchNameFor('f0042', name)}`).toBe(true);
    }
  });
});

describe('normalizeRunName: an agent answer, checked', () => {
  const task = 'Add dark mode with system theme support';

  it('keeps a good answer as it is', () => {
    expect(normalizeRunName({ title: 'Dark mode for every screen', slug: 'dark-mode-every-screen', type: 'feat' }, task)).toEqual({
      title: 'Dark mode for every screen',
      slug: 'dark-mode-every-screen',
      type: 'feat',
    });
  });

  it('cleans what the model decorated', () => {
    expect(normalizeRunName({ title: '  "dark mode for every screen."  ', slug: 'Dark Mode!! For *Every* Screen', type: 'feat' }, task)).toEqual({
      title: 'Dark mode for every screen',
      slug: 'dark-mode-for-every-screen',
      type: 'feat',
    });
  });

  it('fills in, field by field, what is missing or unusable', () => {
    expect(normalizeRunName({ title: 'Dark mode', slug: '', type: 'feature' }, task)).toEqual({
      title: 'Dark mode',
      slug: 'dark-mode',
      type: 'feat',
    });
    expect(normalizeRunName({ title: '', slug: 'dark', type: 'fix' }, task)).toMatchObject({ title: 'Add dark mode with system theme support', slug: 'dark', type: 'fix' });
  });

  it('is the stand-in when the agent said nothing usable', () => {
    expect(normalizeRunName(null, task)).toEqual(fallbackRunName(task));
    expect(normalizeRunName({ title: 42, slug: null, type: {} }, task)).toEqual(fallbackRunName(task));
  });

  it('never makes a title longer than a card can hold', () => {
    expect(normalizeRunName({ title: 'word '.repeat(60), slug: 's', type: 'feat' }, task).title.length).toBeLessThanOrEqual(80);
  });
});

describe('the pieces', () => {
  it('writes a task id with at least four digits', () => {
    expect(formatTaskId(7)).toBe('f0007');
    expect(formatTaskId(42)).toBe('f0042');
    expect(formatTaskId(12_345)).toBe('f12345');
  });

  it('builds the branch from the id and what the task is', () => {
    expect(branchNameFor('f0042', { type: 'feat', slug: 'design-tokens-dark-mode' })).toBe('factory/f0042/feat-design-tokens-dark-mode');
    expect(branchNameFor('f0042', { type: 'fix', slug: '' })).toBe('factory/f0042/fix-task');
  });

  it('makes slugs of plain ascii, cut at a word', () => {
    expect(slugify('A\u00f1adir paginaci\u00f3n al listado')).toBe('anadir-paginacion-al-listado');
    expect(slugify('  --Hello,   World!!-- ')).toBe('hello-world');
    expect(slugify('one two three four five six seven eight nine ten', 20)).toBe('one-two-three-four');
    expect(slugify('\ud83d\ude80')).toBe('');
  });

  it('cleans a title', () => {
    expect(cleanTitle('\n  `parse the dates`: \n')).toBe('Parse the dates');
    expect(cleanTitle('')).toBe('');
  });

  it('guesses the type of a change from its words', () => {
    expect(guessBranchType('There is a crash when saving')).toBe('fix');
    expect(guessBranchType('Restructure the services layer')).toBe('refactor');
    expect(guessBranchType('Upgrade the dependencies')).toBe('build');
    expect(guessBranchType('Add a settings page')).toBe('feat');
  });
});

describe('a further round', () => {
  it('is named by what the triage said it is about, or by its task and number', () => {
    expect(roundTitle('Dark mode for every screen', 2, 'Finish dark mode on the investment pages.')).toBe('Finish dark mode on the investment pages');
    expect(roundTitle('Dark mode for every screen', 3, null)).toBe('Dark mode for every screen \u00b7 round 3');
    expect(roundTitle('Dark mode for every screen', 2, '   ')).toBe('Dark mode for every screen \u00b7 round 2');
  });
});

describe('withTaskTrailer', () => {
  it('ties the commit to its task with a git trailer', () => {
    expect(withTaskTrailer('feat: x\n\nWhy.', 'f0042')).toBe('feat: x\n\nWhy.\n\nFactory-Task: f0042');
    expect(withTaskTrailer('feat: x\n', 'f0042')).toBe('feat: x\n\nFactory-Task: f0042');
  });

  it('adds nothing twice, and nothing without an id', () => {
    const once = withTaskTrailer('feat: x', 'f0042');
    expect(withTaskTrailer(once, 'f0042')).toBe(once);
    expect(withTaskTrailer('feat: x', undefined)).toBe('feat: x');
  });
});
