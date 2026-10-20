import { describe, expect, it } from 'vitest';

import { RUN, readJson } from '../../fixtures';
import { titleFromTask } from '../src/lib/runTitle';

describe('titleFromTask', () => {
  it('uses the first sentence', () => {
    expect(titleFromTask('Add dark mode. Also rewrite everything else!')).toBe('Add dark mode');
  });

  it('shows the real task that used to be called "Untitled run" as its first sentence', () => {
    expect(titleFromTask(readJson(RUN.round1, 'run.json').task)).toBe('I want to do a big refactor on the UI for this repository');
  });

  it('cuts a long first sentence at a word and says so', () => {
    const title = titleFromTask('Please add support for importing portfolios from CSV files and validating every single row against the schema');

    expect(title).toBe('Please add support for importing portfolios from CSV files and\u2026');
    expect(title.length).toBeLessThanOrEqual(71);
  });

  it('keeps the first line of a task written on several lines', () => {
    expect(titleFromTask('Fix the token refresh\nThe second line explains more')).toBe('Fix the token refresh');
  });

  it('has something to say for a task with no words in it', () => {
    expect(titleFromTask('   ')).toBe('Untitled run');
  });
});
