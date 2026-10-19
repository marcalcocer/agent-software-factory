/**
 * The rules of merging a pull request, kept free of I/O (no git, no GitHub, no model) so they
 * can be checked on their own:
 *
 *   - when GitHub's own verdict means "not now" (conflicts, draft, blocked, ...),
 *   - what the squash commit message looks like (subject, pull-request reference, the plain
 *     fallback used when no agent can write one),
 *   - how a large diff is cut down before an agent reads it.
 *
 * The Studio never re-implements any of this: it asks the factory (`pr-check`, `pr-merge-draft`,
 * `pr-merge`), exactly like it does for "what counts as unhandled feedback".
 */

/* -------------------------------------------------------------------------- */
/* GitHub's verdict                                                            */
/* -------------------------------------------------------------------------- */

export interface CheckSummary {
  total: number;
  failing: number;
  pending: number;
}

const FAILING_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const FAILING_STATES = new Set(['FAILURE', 'ERROR']);
const PENDING_STATES = new Set(['PENDING', 'EXPECTED']);

const upper = (value: unknown): string => (typeof value === 'string' ? value.toUpperCase() : '');

/**
 * Counts what `statusCheckRollup` reports. It mixes two kinds of entries: check runs (`status`
 * plus, once finished, a `conclusion`) and commit statuses (a single `state`).
 */
export function summarizeChecks(rollup: unknown): CheckSummary {
  const items = Array.isArray(rollup) ? rollup : [];
  let failing = 0;
  let pending = 0;

  for (const raw of items) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const state = upper(item.state);
    if (state) {
      if (FAILING_STATES.has(state)) failing += 1;
      else if (PENDING_STATES.has(state)) pending += 1;
      continue;
    }
    const status = upper(item.status);
    if (status && status !== 'COMPLETED') pending += 1;
    else if (FAILING_CONCLUSIONS.has(upper(item.conclusion))) failing += 1;
  }

  return { total: items.length, failing, pending };
}

/** What GitHub says about a pull request that decides whether it can be merged. */
export interface Mergeability {
  /** OPEN | MERGED | CLOSED */
  state: string;
  isDraft: boolean;
  /** MERGEABLE | CONFLICTING | UNKNOWN */
  mergeable: string;
  /** CLEAN | UNSTABLE | HAS_HOOKS | BLOCKED | BEHIND | DIRTY | DRAFT | UNKNOWN */
  mergeState: string;
  /** '' | APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED */
  reviewDecision: string;
  checks: CheckSummary;
  baseBranch: string;
}

export interface MergeAssessment {
  /** Reasons the merge cannot go ahead now. Empty when it can. */
  blockers: string[];
  /** Worth knowing before merging, but not a reason to refuse. */
  warnings: string[];
  /** The only thing missing is a moment: GitHub has not finished working out mergeability. */
  transient: boolean;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Whether a pull request can be merged right now, in plain language. Pure. */
export function assessMerge(input: Mergeability): MergeAssessment {
  const blockers: string[] = [];
  const warnings: string[] = [];
  let transient = false;

  const state = input.state.toUpperCase();
  const base = input.baseBranch || 'the base branch';
  const mergeable = input.mergeable.toUpperCase();
  const mergeState = input.mergeState.toUpperCase();

  if (state === 'MERGED') {
    blockers.push('It is already merged.');
  } else if (state === 'CLOSED') {
    blockers.push('It is closed.');
  } else {
    if (input.isDraft) blockers.push('It is still a draft. Mark it ready for review on GitHub first.');

    if (mergeable === 'CONFLICTING' || mergeState === 'DIRTY') {
      blockers.push(`It has conflicts with ${base}. Resolve them first.`);
    } else if (mergeState === 'BEHIND') {
      blockers.push(`It is behind ${base}, and this repository requires branches to be up to date before merging.`);
    } else if (mergeState === 'BLOCKED') {
      blockers.push('GitHub blocks the merge: a required review or check is missing.');
    } else if (mergeable === 'UNKNOWN' || mergeState === 'UNKNOWN') {
      blockers.push('GitHub is still working out whether it can be merged. Check again in a moment.');
      transient = true;
    }

    if (input.checks.failing > 0) warnings.push(`${plural(input.checks.failing, 'check is', 'checks are')} failing.`);
    if (input.checks.pending > 0) warnings.push(`${plural(input.checks.pending, 'check is', 'checks are')} still running.`);
    if (mergeState === 'UNSTABLE' && input.checks.failing === 0) warnings.push('Some checks are not passing.');
    if (input.reviewDecision.toUpperCase() === 'CHANGES_REQUESTED') {
      warnings.push('A reviewer has requested changes on GitHub.');
    }
  }

  return { blockers, warnings, transient };
}

/** What `gh pr merge` said when it refused, as something a person can act on. */
export function explainMergeFailure(output: string, exitCode: number): string {
  const text = output.trim();
  if (/head branch was modified|expected head|head sha/i.test(text)) {
    return 'The branch changed while merging. Review it again.';
  }
  if (/squash merges? (are|is) not allowed|not allowed.*squash|merge method.*not allowed/i.test(text)) {
    return "Squash merging is turned off in this repository's settings.";
  }
  // Before the conflict test: gh words a policy refusal as "is not mergeable: the base branch
  // policy prohibits the merge", which must not be mistaken for a conflict.
  if (/required status check|required review|protected branch|branch protection|base branch policy/i.test(text)) {
    return `A branch protection rule blocks the merge. ${firstLine(text)}`;
  }
  if (/merge conflict|conflicting|not mergeable|cannot be cleanly/i.test(text)) {
    return 'GitHub says the pull request has conflicts and cannot be merged.';
  }
  if (/gh auth login|not logged in|requires authentication|bad credentials|HTTP 401|HTTP 403|Resource not accessible/i.test(text)) {
    return 'GitHub CLI (`gh`) is not allowed to merge here. Run `gh auth login`, or check your permission on the repository.';
  }
  return `gh pr merge failed (exit ${exitCode}): ${firstLine(text) || 'no output'}`;
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

/**
 * Why the agent could not write the squash message, in a few words a person understands. The
 * raw error names the agent, the step and the backend; none of that helps the reader.
 */
export function explainAgentFailure(message: string): string {
  const text = message.replace(/\s+/g, ' ').trim();
  if (/not authenticated|claude login|oauth session/i.test(text)) {
    return 'Claude Code is not signed in - run `claude login` in a terminal, then try again';
  }
  if (/session limit|usage limit|rate.?limit|overloaded|\b429\b/i.test(text)) {
    return 'Claude is busy, or your usage limit was reached';
  }
  if (/did not answer within|timed out|timeout/i.test(text)) return 'Claude did not answer in time';
  if (/not installed|ENOENT|command not found/i.test(text)) return 'Claude Code is not installed';
  // Drop the "Agent ... failed during step ... [backend/kind]:" preamble.
  return clipAtWord(text.replace(/^.*?\]:\s*/, ''), 120);
}

/* -------------------------------------------------------------------------- */
/* The squash commit message                                                   */
/* -------------------------------------------------------------------------- */

/** The conventional width of a commit subject. The agent is asked to stay within it. */
export const SUBJECT_TARGET = 72;
/** Nothing longer than this reaches `git log`, whoever wrote it. */
const SUBJECT_HARD_LIMIT = 200;

/** Single line, no wrapping quotes or backticks, no trailing full stop. */
export function cleanSubject(raw: string): string {
  let text = (raw.split('\n').find((line) => line.trim() !== '') ?? '').replace(/\s+/g, ' ').trim();
  text = text.replace(/^["'`]+|["'`]+$/g, '').trim();
  return text.replace(/[.\s]+$/, '');
}

/**
 * Adds " (#N)" - the convention that makes a squash commit point back at its pull request - unless
 * the subject already ends with it.
 */
export function withPullRequestReference(subject: string, number: number): string {
  const reference = `(#${number})`;
  const text = cleanSubject(subject);
  if (text === '') return reference;
  if (text.endsWith(reference)) return clipAtWord(text, SUBJECT_HARD_LIMIT);
  const room = SUBJECT_HARD_LIMIT - reference.length - 1;
  return `${clipAtWord(text, room)} ${reference}`;
}

/**
 * Cuts at a word boundary so a long text never ends in the middle of a word. The result,
 * ellipsis included, is never longer than `max`.
 */
export function clipAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - 3);
  const cut = text.slice(0, room);
  const space = cut.lastIndexOf(' ');
  return `${(space > room * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}...`;
}

/** Trims, drops code fences around the whole body, collapses runs of blank lines. */
export function cleanBody(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text);
  if (fenced) text = fenced[1]!.trim();
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface SquashMessage {
  subject: string;
  body: string;
}

/** Puts an agent's message into its final shape: one clean subject with the reference, a clean body. */
export function normalizeSquashMessage(raw: SquashMessage, number: number): SquashMessage {
  const subject = withPullRequestReference(raw.subject, number);
  let body = cleanBody(raw.body);
  // A body that opens by repeating the subject adds nothing.
  const [firstBodyLine = '', ...restOfBody] = body.split('\n');
  const plainSubject = cleanSubject(raw.subject).toLowerCase();
  if (firstBodyLine.trim() !== '' && cleanSubject(firstBodyLine).toLowerCase() === plainSubject) {
    body = restOfBody.join('\n').trim();
  }
  return { subject, body };
}

/**
 * The paragraph of a pull-request description that says what it is for: the first one under a
 * "Summary" heading if there is one, otherwise the first paragraph of text.
 */
export function describePullRequest(body: string, maxChars = 700): string {
  const text = body.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n/g, '\n').trim();
  if (text === '') return '';

  let chunk = text;
  const heading = /^#{1,6}\s*summary\s*$/im.exec(text);
  if (heading) {
    const after = text.slice(heading.index + heading[0].length);
    const next = after.search(/^#{1,6}\s/m);
    chunk = (next === -1 ? after : after.slice(0, next)).trim();
  }

  const paragraph = chunk
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find((part) => part !== '' && !/^#{1,6}\s/.test(part));
  return paragraph ? clipAtWord(paragraph.replace(/\s*\n\s*/g, ' '), maxChars) : '';
}

export interface SquashSource {
  number: number;
  title: string;
  body: string;
  commits: Array<{ headline: string }>;
  files: Array<{ path: string; additions: number; deletions: number }>;
}

/**
 * The message used when no agent could write one: the pull request's own title and summary, plus
 * the files that really changed. Plain on purpose - the human reads it before anything is merged.
 */
export function fallbackSquashMessage(source: SquashSource): SquashMessage {
  const title = source.title.trim() || source.commits[0]?.headline.trim() || `Pull request #${source.number}`;
  const subject = withPullRequestReference(title, source.number);

  const shown = source.files.slice(0, 8).map((file) => `- ${file.path} (+${file.additions} -${file.deletions})`);
  const hidden = source.files.length - shown.length;
  const files =
    shown.length === 0
      ? ''
      : ['Changed files:', ...shown, ...(hidden > 0 ? [`- and ${plural(hidden, 'more file', 'more files')}`] : [])].join('\n');

  return { subject, body: [describePullRequest(source.body), files].filter((part) => part !== '').join('\n\n') };
}

/* -------------------------------------------------------------------------- */
/* Cutting a diff down for an agent                                            */
/* -------------------------------------------------------------------------- */

const GENERATED_FILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum|gradle\.lockfile)$|\.min\.(js|css)$|\.map$/i;

/** Lockfiles, minified bundles and source maps: huge, generated, and never what a message should describe. */
export function isGeneratedFile(path: string): boolean {
  return GENERATED_FILE.test(path);
}

export interface CondensedDiff {
  text: string;
  /** Files left out entirely (generated, or beyond the size limit). */
  omitted: string[];
  /** Files that were cut short. */
  shortened: string[];
}

export interface CondenseLimits {
  /** Upper bound for the whole text. */
  maxChars?: number;
  /** Upper bound for the lines kept of one file. */
  maxLinesPerFile?: number;
}

/**
 * Cuts a unified diff down to what an agent needs to describe the change: generated files go,
 * very long files keep their beginning, and the whole is kept under a size limit. What was left
 * out is reported, so the agent (and the reader of the draft) can tell the picture is partial.
 */
export function condenseDiff(diff: string, limits: CondenseLimits = {}): CondensedDiff {
  const maxChars = limits.maxChars ?? 60_000;
  const maxLines = limits.maxLinesPerFile ?? 300;

  const sections = diff.split(/^(?=diff --git )/m).filter((part) => part.trim() !== '');
  const omitted: string[] = [];
  const shortened: string[] = [];
  const kept: string[] = [];
  let used = 0;

  for (const section of sections) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(section);
    const path = header?.[2] ?? header?.[1] ?? '(unknown file)';

    if (isGeneratedFile(path)) {
      omitted.push(path);
      continue;
    }

    let text = section.endsWith('\n') ? section : `${section}\n`;
    const lines = text.split('\n');
    if (lines.length - 1 > maxLines) {
      text = `${lines.slice(0, maxLines).join('\n')}\n[... ${lines.length - 1 - maxLines} more lines of ${path} left out ...]\n`;
      shortened.push(path);
    }

    if (used + text.length > maxChars) {
      omitted.push(path);
      continue;
    }
    kept.push(text);
    used += text.length;
  }

  return { text: kept.join(''), omitted, shortened };
}
