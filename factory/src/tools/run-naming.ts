/**
 * The names of a task: the title people read in the run history, and the branch it is worked on.
 *
 * Both used to be a slice of the task text - "Untitled run" in the Studio, and
 * `factory/i-want-to-do-a-big-refactor-on-t-61e6` on GitHub, the first 32 characters of the request
 * cut mid-word. A cheap agent now names the task (`run-namer`); everything here is what is checked and
 * cleaned around it, and what stands in when it cannot answer. Pure (no model, no git, no files).
 */

import { branchTypeValues } from '../utils/schemas.ts';

export const BRANCH_TYPES = branchTypeValues;
export type BranchType = (typeof BRANCH_TYPES)[number];

export interface RunName {
  /** What the task is, as a short phrase: "Dark mode for every screen". */
  title: string;
  /** Lowercase words joined by hyphens, for the branch. */
  slug: string;
  type: BranchType;
}

const TITLE_MAX = 80;
const SLUG_MAX = 40;

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

/** `f0042`. Wider numbers keep all their digits. */
export function formatTaskId(sequence: number): string {
  return `f${String(sequence).padStart(4, '0')}`;
}

/** Ascii kebab-case, cut at a word boundary: what is safe in a branch name and still readable. */
export function slugify(text: string, max = SLUG_MAX): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const lastHyphen = cut.lastIndexOf('-');
  return (slug[max] === '-' || lastHyphen < max * 0.5 ? cut : cut.slice(0, lastHyphen)).replace(/-+$/, '');
}

/** `factory/f0042/feat-design-tokens-dark-mode`: one id for the whole task, then what it is. */
export function branchNameFor(taskId: string, name: Pick<RunName, 'type' | 'slug'>): string {
  return `factory/${taskId}/${name.type}-${name.slug || 'task'}`;
}

/** Cuts at a word, without an ellipsis: a title is a name, not an excerpt. */
function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:(-]+$/, '');
}

/** Wrapping quotes and trailing punctuation come off in any order they were put on, until neither is left. */
function stripDecoration(text: string): string {
  let current = text.trim();
  for (;;) {
    const next = current
      .replace(/^["'`\u201c\u201d\u2018\u2019]+|["'`\u201c\u201d\u2018\u2019]+$/g, '')
      .replace(/[.:;,\s]+$/, '')
      .trim();
    if (next === current) return current;
    current = next;
  }
}

/** One line, no wrapping quotes, no final full stop, first letter capital. */
export function cleanTitle(raw: string): string {
  const line = raw.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  const text = clipWords(stripDecoration(line.replace(/\s+/g, ' ')), TITLE_MAX);
  return text === '' ? '' : text.charAt(0).toUpperCase() + text.slice(1);
}

/* -------------------------------------------------------------------------- */
/* The stand-in when no agent can answer                                       */
/* -------------------------------------------------------------------------- */

/** The ways a request opens that say nothing about the work. Applied until none matches. */
const OPENERS: RegExp[] = [
  /^(hi|hello|hey)\b[\s,!.:-]*/i,
  /^(please|pls)\b[\s,:-]*/i,
  /^(can|could|would|will) you( please)?\b[\s,:-]*/i,
  /^(i|we)\s+(really\s+)?(want|need|would like|wish|plan|am going|are going)\s+(you\s+)?to\b[\s,:-]*/i,
  /^(i|we)\s+(want|need)\b[\s,:-]*/i,
  /^i'd like( you)? to\b[\s,:-]*/i,
  /^let'?s\b[\s,:-]*/i,
  /^(do|make|create|build)\s+(a|an|the)\s+/i,
];

const TRAILING_FILLER = /\b(and|or|to|for|of|the|a|an|on|in|with|so|that|then)$/i;

const TYPE_HINTS: Array<[BranchType, RegExp]> = [
  ['fix', /\b(fix|bug|crash|broken|regression|wrong|leak|race condition)\b/i],
  ['refactor', /\b(refactor|restructure|rewrite|reorgani[sz]e|clean ?up|modernize|migrate)\b/i],
  ['perf', /\b(performance|faster|speed up|optimi[sz]e|latency)\b/i],
  ['test', /\b(add|write|improve)\s+(unit |integration |e2e )?tests?\b/i],
  ['docs', /\b(readme|documentation|changelog|document)\b/i],
  ['build', /\b(dependenc(y|ies)|upgrade|bump|build system|webpack|vite)\b/i],
  ['ci', /\b(ci|github actions|pipeline|workflow file)\b/i],
];

/** A guess from the words of the request. Only used when the agent did not choose. */
export function guessBranchType(task: string): BranchType {
  return TYPE_HINTS.find(([, pattern]) => pattern.test(task))?.[0] ?? 'feat';
}

/** What is left of a sentence once the ways people begin a request are taken off. */
function withoutOpeners(sentence: string): string {
  let text = sentence.trim();
  for (let round = 0; round < 6; round += 1) {
    const stripped = OPENERS.reduce((current, opener) => current.replace(opener, ''), text).trim();
    if (stripped === text) break;
    text = stripped;
  }
  return text;
}

/**
 * A name made from the request alone: the first sentence that says something, without the ways people
 * begin a request ("I want to do a ...", "Hi!", "Please ..."), up to its first comma, at most ten
 * words. Not clever - the agent is - but always something a person recognises, which "Untitled run"
 * never was.
 */
export function fallbackRunName(task: string): RunName {
  const sentences = task.trim().split(/(?<=[.!?])\s+|\n/);
  const text = sentences.map(withoutOpeners).find((sentence) => /[a-z0-9]/i.test(sentence)) ?? '';

  // The clause before the first comma or dash, when it is a phrase of its own and not a lone verb.
  const clause = text.split(/[,;\u2014]|\s-\s/)[0] ?? text;
  const head = clause.trim().split(/\s+/).length >= 3 ? clause : text;

  let phrase = head.split(/\s+/).filter(Boolean).slice(0, 10).join(' ');
  for (let previous = ''; previous !== phrase; ) {
    previous = phrase;
    phrase = stripDecoration(phrase).replace(TRAILING_FILLER, '').trim();
  }

  const title = cleanTitle(phrase) || 'Untitled task';
  return { title, slug: slugify(title) || 'task', type: guessBranchType(task) };
}

/**
 * Puts an agent's answer into its final shape. Anything missing or unusable is taken from the stand-in,
 * field by field: a good title with an empty slug keeps its title.
 */
export function normalizeRunName(raw: Partial<Record<keyof RunName, unknown>> | null | undefined, task: string): RunName {
  const standIn = fallbackRunName(task);
  const title = typeof raw?.title === 'string' ? cleanTitle(raw.title) : '';
  const slug = typeof raw?.slug === 'string' ? slugify(raw.slug) : '';
  const type = BRANCH_TYPES.find((candidate) => candidate === raw?.type);
  const finalTitle = title || standIn.title;
  return { title: finalTitle, slug: slug || slugify(finalTitle) || standIn.slug, type: type ?? standIn.type };
}

/**
 * The title of a further round: the focus the triage gave it, or the task's title with the round.
 * Rounds are listed under their task, so the title only has to say what this round is about.
 */
export function roundTitle(taskTitle: string, round: number, focus?: string | null): string {
  const named = focus ? cleanTitle(focus) : '';
  return named || `${taskTitle} \u00b7 round ${round}`;
}

/**
 * Adds `Factory-Task: f0042` as a git trailer, so a commit leads back to the task that made it.
 * A message that already has one keeps it (the human may have edited the message at the gate).
 */
export function withTaskTrailer(message: string, taskId: string | null | undefined): string {
  if (!taskId || /^Factory-Task:/m.test(message)) return message;
  return `${message.trimEnd()}\n\nFactory-Task: ${taskId}`;
}
