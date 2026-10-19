/**
 * Puts the rounds of one task together in the run history.
 *
 * A round on a pull request is a run of its own (its own trace, so round 1's results are never
 * overwritten) but it is the *same task*. Listed flat, the user would see unrelated entries; here
 * each round is shown right under the run it continues.
 *
 * Pure (no React, no DOM) so the ordering rules can be tested directly.
 */
export interface GroupableRun {
  id: string;
  /** The run that started the task. A run that is its own root has no parent. */
  rootRunId?: string;
  round?: number;
}

export interface GroupedRun<T extends GroupableRun> {
  run: T;
  /** Shown indented under its task. */
  nested: boolean;
  /** How many rounds the task has, counting this one when it is the first (1 = a plain run). */
  rounds: number;
}

/**
 * Orders `runs` (given newest first) so every round follows the run it continues, oldest round
 * first. A round whose original run is not in the list (deleted, or belongs to another repository)
 * stays where it is, un-nested, rather than disappearing.
 */
export function groupRuns<T extends GroupableRun>(runs: T[]): Array<GroupedRun<T>> {
  const ids = new Set(runs.map((run) => run.id));
  const rounds = new Map<string, T[]>();
  const roots: T[] = [];

  for (const run of runs) {
    const root = run.rootRunId;
    if (root && root !== run.id && ids.has(root)) {
      rounds.set(root, [...(rounds.get(root) ?? []), run]);
    } else {
      roots.push(run);
    }
  }

  const grouped: Array<GroupedRun<T>> = [];
  for (const root of roots) {
    const children = (rounds.get(root.id) ?? []).sort(
      (a, b) => (a.round ?? 0) - (b.round ?? 0) || a.id.localeCompare(b.id),
    );
    grouped.push({ run: root, nested: false, rounds: 1 + children.length });
    for (const child of children) grouped.push({ run: child, nested: true, rounds: 1 + children.length });
  }
  return grouped;
}
