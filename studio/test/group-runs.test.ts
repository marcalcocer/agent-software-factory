import { describe, expect, it } from 'vitest';

import { RUN } from '../../fixtures';
import { groupRuns } from '../src/lib/groupRuns';

/** What the history list holds: newest first. */
const run = (id: string, rootRunId: string, round: number) => ({ id, rootRunId, round });

describe('groupRuns', () => {
  it('puts a round right under the run it continues', () => {
    const grouped = groupRuns([run(RUN.round2, RUN.round1, 2), run(RUN.round1, RUN.round1, 1)]);

    expect(grouped.map((entry) => [entry.run.id, entry.nested, entry.rounds])).toEqual([
      [RUN.round1, false, 2],
      [RUN.round2, true, 2],
    ]);
  });

  it('keeps unrelated tasks apart and in their order', () => {
    const grouped = groupRuns([run('c', 'c', 1), run('b', 'a', 2), run('a', 'a', 1)]);

    expect(grouped.map((entry) => entry.run.id)).toEqual(['c', 'a', 'b']);
    expect(grouped.map((entry) => entry.nested)).toEqual([false, false, true]);
  });

  it('orders the rounds of a task oldest first, whatever order they arrive in', () => {
    const grouped = groupRuns([run('r3', 'r1', 3), run('r2', 'r1', 2), run('r1', 'r1', 1)]);
    expect(grouped.map((entry) => entry.run.id)).toEqual(['r1', 'r2', 'r3']);
    expect(grouped.every((entry) => entry.rounds === 3)).toBe(true);
  });

  it('does not make a round disappear when its first run is not in the list', () => {
    // Deleted from the history, or it belongs to another repository.
    const grouped = groupRuns([run('r2', 'r1', 2)]);
    expect(grouped).toEqual([{ run: run('r2', 'r1', 2), nested: false, rounds: 1 }]);
  });

  it('treats a run that is its own root as a plain run', () => {
    expect(groupRuns([{ id: 'x' }])).toEqual([{ run: { id: 'x' }, nested: false, rounds: 1 }]);
  });
});
