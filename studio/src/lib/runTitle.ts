/**
 * The title of a run for runs that were stored without one (made before the factory named its tasks):
 * the first sentence of the task, cut at a word. The factory's own names are better, and are used
 * whenever a run has one; this only has to be something a person recognises, which "Untitled run"
 * never was.
 */
export function titleFromTask(task: string, max = 70): string {
  const first = (task.trim().split(/(?<=[.!?])\s+|\n/)[0] ?? '').replace(/\s+/g, ' ').trim();
  if (first === '') return 'Untitled run';

  const text = first.replace(/[.:;,]+$/, '');
  if (text.length <= max) return text;

  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:(-]+$/, '')}\u2026`;
}
